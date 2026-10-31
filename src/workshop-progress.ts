// ADACEEN (VS Code): avance del taller en la esquina del panel (0.0.38), sin importar vscode.
//
// La VM de editores mide cada cierto tiempo cuanto lleva cada estudiante del taller (puntos
// hechos, si compila) y el backend lo guarda (POST /api/workspaces/progress-report). La vista
// «Este archivo» muestra el suyo en la esquina: «35 %», con los puntos que faltan al pasar el
// mouse. Contrato: GET /api/workspaces/my-progress[?repoFullName=<owner/name>] ->
//   { ok: true, progress: null | { taller, titulo, percent, compiles, done, total,
//     missing: [{ id, hu, texto }], stale, receivedAt, lastChangeAt } }
// Con un backend anterior (404), sin sesion (401) o sin red no se muestra nada.
// Se prueba con node:test.

export type WorkshopMissingPoint = { id: string; hu: string; texto: string };

export type WorkshopProgress = {
  taller: string;
  titulo: string;
  percent: number;
  compiles: boolean | null;
  done: number;
  total: number;
  missing: WorkshopMissingPoint[];
  stale: boolean;
  receivedAt: string;
  lastChangeAt: string;
};

/** Lo que pinta la vista: null = no se muestra. */
export type ProgressPill = {
  /** «35 %». */
  text: string;
  /** Lo que sale al pasar el mouse (y lee el lector de pantalla). */
  title: string;
  /** Para el color: bajo (<40), medio (<80) o alto. */
  level: 'low' | 'mid' | 'high';
  stale: boolean;
};

export const PROGRESS_PATH = '/api/workspaces/my-progress';
export const MAX_TOOLTIP_POINTS = 8;
/** Despues de guardar o compilar, a lo sumo una consulta cada 2 minutos. */
export const PROGRESS_WORK_THROTTLE_MS = 2 * 60_000;
/** Con la vista a la vista, una consulta cada 5 minutos. */
export const PROGRESS_POLL_MS = 5 * 60_000;

const MAX_TEXT = 160;

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

/**
 * La respuesta del backend, revisada: null si no trae avance (todavia no hay informe, el
 * estudiante no empezo) o si no tiene la forma del contrato.
 */
export function normalizeWorkshopProgress(value: unknown): WorkshopProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const data = value as Record<string, unknown>;
  if (data.ok !== true) {
    return null;
  }
  const raw = data.progress;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const progress = raw as Record<string, unknown>;
  if (typeof progress.percent !== 'number' || !Number.isFinite(progress.percent)) {
    return null;
  }
  const missing = Array.isArray(progress.missing)
    ? progress.missing
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
      .map((item) => ({ id: text(item.id, 40), hu: text(item.hu, 40), texto: text(item.texto) }))
      .filter((item) => item.id || item.texto)
      .slice(0, 100)
    : [];
  return {
    taller: text(progress.taller, 80),
    titulo: text(progress.titulo, 120),
    percent: Math.min(100, Math.max(0, Math.round(progress.percent))),
    compiles: typeof progress.compiles === 'boolean' ? progress.compiles : null,
    done: count(progress.done),
    total: count(progress.total),
    missing,
    stale: progress.stale === true,
    receivedAt: text(progress.receivedAt, 40),
    lastChangeAt: text(progress.lastChangeAt, 40),
  };
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

/** La pastilla de la esquina y su texto al pasar el mouse. null: no se muestra. */
export function buildProgressPill(progress: WorkshopProgress | null, now: Date = new Date()): ProgressPill | null {
  if (!progress) {
    return null;
  }
  const lines: string[] = [];
  const name = progress.titulo || progress.taller;
  lines.push(`Avance del taller${name ? ` «${name}»` : ''}: ${progress.percent} %${progress.total ? ` (${progress.done} de ${progress.total} puntos)` : ''}`);
  if (progress.compiles === false) {
    lines.push('Tu proyecto no compila: arregla eso primero.');
  } else if (progress.compiles === true) {
    lines.push('Tu proyecto compila.');
  }
  if (progress.missing.length) {
    lines.push('Te falta:');
    for (const point of progress.missing.slice(0, MAX_TOOLTIP_POINTS)) {
      const label = point.texto || point.id;
      lines.push(`• ${point.hu ? `${point.hu}: ` : ''}${label}`);
    }
    const rest = progress.missing.length - MAX_TOOLTIP_POINTS;
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
