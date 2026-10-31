// ADACEEN (VS Code): avance del taller en la esquina del panel (0.0.38), sin importar vscode.
//
// La VM de editores mide cada cierto tiempo cuanto lleva cada estudiante del taller (puntos
// hechos y a medias, si compila) y el backend lo guarda (POST /api/workspaces/progress-report).
// La vista «Este archivo» muestra el suyo en la esquina: «35 %», con lo que falta al pasar el
// mouse. Contrato (docs/arquitectura/contrato-api.md, backend del 30/10/2026):
//   GET /api/workshop-progress/me[?repoFullName=<owner/name>] ->
//   { ok: true, status: "sin-editor" | "sin-taller" | "sin-carpeta" | "en-curso",
//     progress: null | { taller, titulo, percent, compiles, done, partial, total,
//       pending: [{ id, hu, texto, partial }] (a lo sumo 8, en el orden del taller), pendingCount,
//       stale, receivedAt, lastChangeAt, matchedBy: "repo" | "pilot" | "latest" } }
// progress solo viene con «en-curso». percent es ponderado por el peso de cada punto; done,
// partial y total son cuentas de puntos. Sin sesion (401) o sin red no se muestra nada.
// Se prueba con node:test.

/** Lo que dice el backend del avance: sin vincular GitHub, sin taller, sin la carpeta, o el avance. */
export type WorkshopStatus = 'sin-editor' | 'sin-taller' | 'sin-carpeta' | 'en-curso';

/** Un punto del taller que falta o va a medias. */
export type WorkshopPendingPoint = { id: string; hu: string; texto: string; partial: boolean };

export type WorkshopProgress = {
  taller: string;
  titulo: string;
  /** Ponderado por el peso de cada punto (lo calcula la VM). */
  percent: number;
  compiles: boolean | null;
  /** Puntos hechos, a medias y del taller (cuentas, sin peso). */
  done: number;
  partial: number;
  total: number;
  /** Lo que falta o va a medias, en el orden del taller (a lo sumo 8). */
  pending: WorkshopPendingPoint[];
  /** Cuantos faltan o van a medias en total (antes del tope de pending). */
  pendingCount: number;
  stale: boolean;
  receivedAt: string;
  lastChangeAt: string;
  matchedBy: 'repo' | 'pilot' | 'latest' | '';
};

/** La respuesta revisada: el estado y, solo con «en-curso», el avance. */
export type WorkshopProgressReply =
  | { status: 'en-curso'; progress: WorkshopProgress }
  | { status: Exclude<WorkshopStatus, 'en-curso'>; progress: null };

/** Lo que pinta la vista: null = no se muestra. */
export type ProgressPill = {
  /** «35 %» (o «— %» si falta algo para medir). */
  text: string;
  /** Lo que sale al pasar el mouse (y lee el lector de pantalla). */
  title: string;
  /** Para el color: bajo (<40), medio (<80), alto, o apagada (no se puede medir todavia). */
  level: 'low' | 'mid' | 'high' | 'muted';
  stale: boolean;
};

export const PROGRESS_PATH = '/api/workshop-progress/me';
/** Despues de guardar o compilar, a lo sumo una consulta cada 2 minutos. */
export const PROGRESS_WORK_THROTTLE_MS = 2 * 60_000;
/** Con la vista a la vista, una consulta cada 5 minutos. */
export const PROGRESS_POLL_MS = 5 * 60_000;

/** El backend manda a lo sumo 8 puntos pendientes; se cuidan los mismos. */
const MAX_PENDING_POINTS = 8;
const MAX_TEXT = 160;
const STATUSES: readonly WorkshopStatus[] = ['sin-editor', 'sin-taller', 'sin-carpeta', 'en-curso'];

function text(value: unknown, max = MAX_TEXT) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function count(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** owner/name valido para la consulta (o '' si no lo es). */
export function progressRepoParam(repo: string | undefined) {
  const value = String(repo || '').trim();
  return /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : '';
}

export function progressUrl(baseUrl: string, repo?: string) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const param = progressRepoParam(repo);
  return `${base}${PROGRESS_PATH}${param ? `?repoFullName=${encodeURIComponent(param)}` : ''}`;
}

function normalizeProgress(raw: unknown): WorkshopProgress | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const progress = raw as Record<string, unknown>;
  if (typeof progress.percent !== 'number' || !Number.isFinite(progress.percent)) {
    return null;
  }
  const pending = Array.isArray(progress.pending)
    ? progress.pending
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({ id: text(item.id, 40), hu: text(item.hu, 40), texto: text(item.texto), partial: item.partial === true }))
      .filter((item) => item.id || item.texto)
      .slice(0, MAX_PENDING_POINTS)
    : [];
  const matchedBy = progress.matchedBy === 'repo' || progress.matchedBy === 'pilot' || progress.matchedBy === 'latest' ? progress.matchedBy : '';
  return {
    taller: text(progress.taller, 80),
    titulo: text(progress.titulo, 120),
    percent: Math.min(100, Math.max(0, Math.round(progress.percent))),
    compiles: typeof progress.compiles === 'boolean' ? progress.compiles : null,
    done: count(progress.done),
    partial: count(progress.partial),
    total: count(progress.total),
    pending,
    // Nunca menos de lo que vino en la lista.
    pendingCount: Math.max(count(progress.pendingCount), pending.length),
    stale: progress.stale === true,
    receivedAt: text(progress.receivedAt, 40),
    lastChangeAt: text(progress.lastChangeAt, 40),
    matchedBy,
  };
}

/**
 * La respuesta del backend, revisada: null si no tiene la forma del contrato (o no hay respuesta:
 * sin sesion). «en-curso» sin un avance valido tampoco vale.
 */
export function normalizeWorkshopProgressReply(value: unknown): WorkshopProgressReply | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const data = value as Record<string, unknown>;
  const status = STATUSES.find((item) => item === data.status);
  if (data.ok !== true || !status) {
    return null;
  }
  if (status !== 'en-curso') {
    return { status, progress: null };
  }
  const progress = normalizeProgress(data.progress);
  return progress ? { status, progress } : null;
}

/** «hoy 14:32», «ayer 09:05» o «28/10 18:40» (hora local). '' si la fecha no se entiende. */
export function formatReportTime(iso: string, now: Date = new Date()) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (value: number) => String(value).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = (left: Date, right: Date) => left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
  if (sameDay(date, now)) {
    return `hoy ${time}`;
  }
  const yesterday = new Date(now.getTime());
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) {
    return `ayer ${time}`;
  }
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${time}`;
}

/** «2 hechos y 3 a medias de 10 puntos» (cuentas sin peso: el porcentaje si lleva el peso de cada punto). */
export function pointsSummary(progress: Pick<WorkshopProgress, 'done' | 'partial' | 'total'>) {
  if (!progress.total) {
    return '';
  }
  const done = `${progress.done} ${progress.done === 1 ? 'hecho' : 'hechos'}`;
  const partial = progress.partial ? ` y ${progress.partial} a medias` : '';
  return `${done}${partial} de ${progress.total} ${progress.total === 1 ? 'punto' : 'puntos'}`;
}

/** Sin avance que mostrar todavia: la pastilla apagada dice que falta (o no se muestra). */
const STATUS_HINTS: Record<Exclude<WorkshopStatus, 'en-curso'>, string> = {
  'sin-editor': 'Tu avance del taller se mide con tu cuenta de GitHub: vincúlala en ADACEEN (ADACEEN: Conectar) para verlo aquí.',
  'sin-carpeta': 'Todavía no se ve tu carpeta del taller en el editor: ábrela (o clónala) en el túnel para que se mida tu avance.',
  'sin-taller': '',
};

/** La pastilla de la esquina y su texto al pasar el mouse. null: no se muestra. */
export function buildProgressPill(reply: WorkshopProgressReply | null, now: Date = new Date()): ProgressPill | null {
  if (!reply) {
    return null;
  }
  if (reply.status !== 'en-curso') {
    const hint = STATUS_HINTS[reply.status];
    return hint ? { text: '— %', title: hint, level: 'muted', stale: false } : null;
  }
  const progress = reply.progress;
  const lines: string[] = [];
  const name = progress.titulo || progress.taller;
  const points = pointsSummary(progress);
  // El porcentaje pondera cada punto por su peso: con las cuentas al lado, «80 %» y «2 hechos y 3 a
  // medias de 10» no parecen contradecirse.
  lines.push(`Avance del taller${name ? ` «${name}»` : ''}: ${progress.percent} %${points ? ` · ${points}` : ''}`);
  if (progress.compiles === false) {
    lines.push('Tu proyecto no compila: arregla eso primero.');
  } else if (progress.compiles === true) {
    lines.push('Tu proyecto compila.');
  }
  if (progress.pending.length) {
    lines.push('Te falta:');
    for (const point of progress.pending) {
      const label = point.texto || point.id;
      lines.push(`• ${point.hu ? `${point.hu}: ` : ''}${label}${point.partial ? ' (a medias)' : ''}`);
    }
    const rest = progress.pendingCount - progress.pending.length;
    if (rest > 0) {
      lines.push(`… y ${rest} ${rest === 1 ? 'punto más' : 'puntos más'}`);
    }
  } else if (progress.percent >= 100) {
    lines.push('¡Todos los puntos están hechos!');
  }
  const when = formatReportTime(progress.receivedAt, now);
  if (when) {
    lines.push(`Medido ${when}${progress.stale ? ' (desactualizado: se mide de nuevo en unos minutos)' : ''}.`);
  } else if (progress.stale) {
    lines.push('Desactualizado: se mide de nuevo en unos minutos.');
  }
  return {
    text: `${progress.percent} %`,
    title: lines.join('\n'),
    level: progress.percent >= 80 ? 'high' : progress.percent >= 40 ? 'mid' : 'low',
    stale: progress.stale,
  };
}

/** ¿Toca pedir el avance despues de guardar o compilar? (a lo sumo una vez cada 2 minutos) */
export function shouldRefreshAfterWork(lastFetchAt: number, now: number) {
  return !lastFetchAt || now - lastFetchAt >= PROGRESS_WORK_THROTTLE_MS;
}

/** Programas que compilan, prueban o ejecutan un taller. */
const BUILD_PROGRAMS = /^(?:make|mingw32-make|cmake|ninja|g\+\+(?:-\d+)?|gcc(?:-\d+)?|c\+\+|cc|clang\+?\+?(?:-\d+)?|javac|java|mvn|mvnw|gradle|gradlew|python3?|py|pytest|dotnet|node|npm|ctest)$/;

/**
 * Una orden de la terminal que compila o ejecuta el taller (make, cmake, g++, javac, mvn,
 * python...): al terminar, el avance puede haber cambiado. Solo la primera palabra de cada orden
 * encadenada (`cd build && make`), sin la ruta (`/usr/bin/g++`) ni `sudo`/`time`.
 */
export function isBuildCommandLine(commandLine: string) {
  return String(commandLine || '')
    .split(/&&|\|\||;|\|/)
    .map((part) => part.trim().replace(/^(?:(?:sudo|time|env)\s+|[A-Z_][A-Z0-9_]*=\S*\s+)*/, ''))
    .some((part) => {
      const program = (part.split(/\s+/)[0] || '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
      return BUILD_PROGRAMS.test(program) || /^\.\/[\w.-]+$/.test(part.split(/\s+/)[0] || '');
    });
}
