// ADACEEN (VS Code): cuando pedir el avance del taller (0.0.38), sin importar vscode.
//
// Se pide al activar, al mostrarse la vista, despues de guardar o compilar (a lo sumo una vez
// cada 2 minutos) y cada 5 minutos mientras la vista se ve. Un error (backend anterior sin la
// ruta, sesion vencida, sin red) esconde la pastilla sin avisar; tras un 404 no se vuelve a
// preguntar en 30 minutos (salvo que se pida a proposito: otra sesion, «Actualizar»).
// Se prueba con node:test (reloj y temporizadores inyectados).
import { normalizeWorkshopProgress, PROGRESS_POLL_MS, shouldRefreshAfterSave } from './workshop-progress';
import type { WorkshopProgress } from './workshop-progress';

export const PROGRESS_UNSUPPORTED_BACKOFF_MS = 30 * 60_000;
/** Dos pedidos seguidos (al activar y al mostrarse la vista) no hacen dos consultas. */
export const PROGRESS_MIN_INTERVAL_MS = 20_000;

export type WorkshopProgressPollerDeps = {
  /** GET /api/workspaces/my-progress. Lanza ante un error (con `status` si fue HTTP). null: sin sesion. */
  fetchProgress: () => Promise<unknown | null>;
  onChange: (progress: WorkshopProgress | null) => void;
  log?: (line: string) => void;
  now?: () => number;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
};

export class WorkshopProgressPoller {
  private current: WorkshopProgress | null = null;
  private lastFetchAt = 0;
  private unsupportedUntil = 0;
  private inFlight: Promise<void> | null = null;
  private timer: unknown = null;
  private disposed = false;

  constructor(private readonly deps: WorkshopProgressPollerDeps) {}

  get progress() {
    return this.current;
  }

  private now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Pide el avance (una sola consulta a la vez). `force`: aunque el backend no tuviera la ruta. */
  refresh(force = false): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (!force && this.now() < this.unsupportedUntil) {
      return Promise.resolve();
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    if (!force && this.lastFetchAt && this.now() - this.lastFetchAt < PROGRESS_MIN_INTERVAL_MS) {
      return Promise.resolve();
    }
    this.lastFetchAt = this.now();
    this.inFlight = this.fetchOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetchOnce() {
    let next: WorkshopProgress | null = null;
    try {
      const data = await this.deps.fetchProgress();
      next = data === null ? null : normalizeWorkshopProgress(data);
      this.unsupportedUntil = 0;
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      if (status === 404) {
        this.unsupportedUntil = this.now() + PROGRESS_UNSUPPORTED_BACKOFF_MS;
      }
      this.deps.log?.(`[Avance] No se pudo leer el avance del taller${typeof status === 'number' ? ` (HTTP ${status})` : ''}: ${String((error as Error)?.message || error).slice(0, 160)}`);
      next = null;
    }
    if (this.disposed) {
      return;
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.current);
    this.current = next;
    if (changed) {
      this.deps.onChange(next);
    }
  }

  /** La vista se mostro u oculto: con la vista a la vista se pide ya y cada 5 minutos. */
  setVisible(visible: boolean) {
    if (this.disposed) {
      return;
    }
    if (!visible) {
      this.stopTimer();
      return;
    }
    void this.refresh();
    if (!this.timer) {
      const every = this.deps.setInterval || ((callback: () => void, ms: number) => setInterval(callback, ms));
      this.timer = every(() => {
        void this.refresh();
      }, PROGRESS_POLL_MS);
    }
  }

  /** Se guardo un archivo o termino una compilacion: se pide si pasaron 2 minutos. */
  noteWork() {
    if (shouldRefreshAfterSave(this.lastFetchAt, this.now())) {
      void this.refresh();
    }
  }

  private stopTimer() {
    if (this.timer) {
      const clear = this.deps.clearInterval || ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
      clear(this.timer);
      this.timer = null;
    }
  }

  dispose() {
    this.disposed = true;
    this.stopTimer();
  }
}
