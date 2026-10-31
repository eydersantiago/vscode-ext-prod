// ADACEEN (VS Code): cuando pedir el avance del taller (0.0.38), sin importar vscode.
//
// Se pide al activar, al mostrarse la vista, despues de guardar o compilar (a lo sumo una vez
// cada 2 minutos) y cada 5 minutos mientras la vista se ve. Un error (backend anterior sin la
// ruta, sesion vencida, sin red) esconde la pastilla sin avisar; tras un 404 no se vuelve a
// preguntar en 30 minutos. Al cambiar de sesion se esconde enseguida y se pregunta de nuevo
// (refetchForNewSession); lo que llegue de la sesion anterior se descarta.
// Se prueba con node:test (reloj y temporizadores inyectados).
import { normalizeWorkshopProgress, PROGRESS_POLL_MS, shouldRefreshAfterWork } from './workshop-progress';
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
  /**
   * Sube con cada cambio de sesion: lo que llega de una consulta de una generacion anterior (con
   * las cabeceras de la sesion de antes) se descarta. Sin esto, en un equipo compartido el
   * siguiente estudiante podia ver el avance del anterior.
   */
  private generation = 0;
  private inFlight: { generation: number; promise: Promise<void> } | null = null;
  private timer: unknown = null;
  private disposed = false;

  constructor(private readonly deps: WorkshopProgressPollerDeps) {}

  get progress() {
    return this.current;
  }

  private now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Pide el avance si hace falta: una sola consulta a la vez (la que esta en curso sirve), no mas
   * de una cada 20 s, y tras un 404 (backend sin la ruta) no pregunta en 30 minutos.
   */
  refresh(): Promise<void> {
    if (this.disposed || this.now() < this.unsupportedUntil) {
      return Promise.resolve();
    }
    if (this.inFlight) {
      return this.inFlight.promise;
    }
    if (this.lastFetchAt && this.now() - this.lastFetchAt < PROGRESS_MIN_INTERVAL_MS) {
      return Promise.resolve();
    }
    return this.start();
  }

  /**
   * Otra sesion (otra cuenta, se conecto o se cerro la sesion): lo que se mostraba era de la
   * anterior y se esconde ya; la consulta en curso se ignora y se pregunta de nuevo con la sesion
   * nueva, aunque antes el backend no tuviera la ruta.
   */
  refetchForNewSession(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    this.generation += 1;
    this.unsupportedUntil = 0;
    this.inFlight = null;
    if (this.current) {
      this.current = null;
      this.deps.onChange(null);
    }
    return this.start();
  }

  private start(): Promise<void> {
    const entry = { generation: this.generation, promise: Promise.resolve() };
    this.lastFetchAt = this.now();
    entry.promise = this.fetchOnce(entry.generation).finally(() => {
      if (this.inFlight === entry) {
        this.inFlight = null;
      }
    });
    this.inFlight = entry;
    return entry.promise;
  }

  private async fetchOnce(generation: number) {
    let next: WorkshopProgress | null = null;
    let unsupported = false;
    try {
      const data = await this.deps.fetchProgress();
      next = data === null ? null : normalizeWorkshopProgress(data);
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      unsupported = status === 404;
      this.deps.log?.(`[Avance] No se pudo leer el avance del taller${typeof status === 'number' ? ` (HTTP ${status})` : ''}: ${String((error as Error)?.message || error).slice(0, 160)}`);
      next = null;
    }
    if (this.disposed || generation !== this.generation) {
      return; // de otra sesion: no se muestra
    }
    this.unsupportedUntil = unsupported ? this.now() + PROGRESS_UNSUPPORTED_BACKOFF_MS : 0;
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
  refreshAfterWork() {
    if (shouldRefreshAfterWork(this.lastFetchAt, this.now())) {
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
