/**
 * Senales de error y de bloqueo a partir de los diagnosticos del editor
 * (A6.2). Es la "activacion por eventos definidos" del anteproyecto: cuando el
 * estudiante se queda atascado en el mismo error, ADACEEN lo registra y puede
 * pedir una sugerencia con trigger "blocking".
 *
 * Reglas (contrato compartido):
 *   - compile_error_detected: el primer error del archivo activo, deduplicado
 *     por texto normalizado durante 60 s.
 *   - blocking_detected: el mismo error (texto normalizado) sigue presente
 *     >= blockingSeconds (90 s por defecto) o aparece 3 veces en 10 minutos.
 *
 * Para no confundir errores de tecleo con errores reales, un error solo
 * "aparece" (cuenta para las repeticiones y para compile_error_detected)
 * cuando lleva stableMs presente y el estudiante lleva stableMs sin editar.
 * Los errores que ya estaban al abrir o volver a un archivo no cuentan como
 * apariciones nuevas (cambiar de pestana no es repetir el error).
 *
 * Modulo puro (sin vscode) para poder probarlo con node:test.
 */

export type DiagnosticSeverityName = 'error' | 'warning' | 'information' | 'hint';

export type DiagnosticLike = {
  message: string;
  severity: DiagnosticSeverityName;
  /** Linea en base 1. */
  line: number;
  character?: number;
};

/** Forma que espera /suggest-tab en `diagnostics`. */
export type SuggestDiagnostic = {
  message: string;
  severity: 'error' | 'warning';
  line: number;
};

export type DiagnosticsSummary = {
  /** Primer error del archivo (por posicion), o null si no hay errores. */
  firstError: { message: string; line: number } | null;
  /** Hasta 10 errores y avisos, primero los errores. */
  items: SuggestDiagnostic[];
  /** Todos los errores (recortados), en orden de aparicion, para el detector. */
  errors: ObservedError[];
};

export const ERROR_TEXT_MAX_CHARS = 300;
export const VISIBLE_ERROR_MAX_CHARS = 2000;
export const DIAGNOSTIC_MESSAGE_MAX_CHARS = 300;
export const MAX_SUGGEST_DIAGNOSTICS = 10;
const MAX_TRACKED_ERRORS = 25;
const MAX_REMEMBERED_KEYS = 200;

export function compactDiagnosticMessage(message: string, max = DIAGNOSTIC_MESSAGE_MAX_CHARS) {
  return String(message || '').replace(/\s+/g, ' ').trim().slice(0, Math.max(0, max));
}

/**
 * Texto normalizado para comparar errores: sin tildes, en minusculas, con
 * los numeros (lineas, columnas, conteos) cambiados por # y los espacios
 * colapsados. "Linea 12: falta ;" y "Linea 14: falta ;" son el mismo error.
 */
export function normalizeErrorText(text: string): string {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ERROR_TEXT_MAX_CHARS);
}

function safeLine(line: number) {
  return Number.isFinite(line) ? Math.max(1, Math.round(line)) : 1;
}

export function summarizeDiagnostics(diagnostics: DiagnosticLike[]): DiagnosticsSummary {
  const relevant = diagnostics
    .map((item, index) => ({
      message: compactDiagnosticMessage(item.message, VISIBLE_ERROR_MAX_CHARS),
      severity: item.severity,
      line: safeLine(item.line),
      character: Number(item.character) || 0,
      index,
    }))
    .filter((item) => item.message && (item.severity === 'error' || item.severity === 'warning'))
    .sort((left, right) => left.line - right.line || left.character - right.character || left.index - right.index);

  const errors = relevant.filter((item) => item.severity === 'error');
  const warnings = relevant.filter((item) => item.severity === 'warning');
  const items: SuggestDiagnostic[] = [...errors, ...warnings]
    .slice(0, MAX_SUGGEST_DIAGNOSTICS)
    .map((item) => ({
      message: item.message.slice(0, DIAGNOSTIC_MESSAGE_MAX_CHARS),
      severity: item.severity === 'error' ? 'error' : 'warning',
      line: item.line,
    }));

  return {
    firstError: errors[0] ? { message: errors[0].message, line: errors[0].line } : null,
    items,
    errors: errors.slice(0, MAX_TRACKED_ERRORS).map((item) => ({
      text: item.message.slice(0, ERROR_TEXT_MAX_CHARS),
      line: item.line,
    })),
  };
}

export type ErrorSignalSettings = {
  /** Tiempo que debe seguir presente el mismo error para considerarlo bloqueo. */
  blockingMs: number;
  /** Ventana de deduplicacion de compile_error_detected por texto normalizado. */
  dedupeMs: number;
  /** Presencia minima (y tiempo sin editar) para que un error "aparezca". */
  stableMs: number;
  /** Apariciones del mismo error dentro de repeatWindowMs que cuentan como bloqueo. */
  repeatThreshold: number;
  repeatWindowMs: number;
  /** Tras un bloqueo del mismo error no se emite otro hasta pasado este tiempo. */
  blockingCooldownMs: number;
};

export const DEFAULT_ERROR_SIGNAL_SETTINGS: ErrorSignalSettings = {
  blockingMs: 90_000,
  dedupeMs: 60_000,
  stableMs: 5_000,
  repeatThreshold: 3,
  repeatWindowMs: 10 * 60_000,
  blockingCooldownMs: 5 * 60_000,
};

export type ObservedError = {
  text: string;
  /** Linea en base 1. */
  line: number;
};

export type CompileErrorSignal = {
  type: 'compile_error_detected';
  key: string;
  text: string;
  line: number;
};

export type BlockingSignal = {
  type: 'blocking_detected';
  key: string;
  text: string;
  line: number;
  /** Tiempo que lleva presente el error en el archivo activo. */
  durationMs: number;
  /** Apariciones del error en la ventana de repeticion (minimo 1). */
  count: number;
  reason: 'persistent' | 'repeated';
};

export type ErrorSignal = CompileErrorSignal | BlockingSignal;

type Presence = {
  key: string;
  text: string;
  line: number;
  firstSeenAt: number;
  confirmed: boolean;
  /** false para errores que ya estaban al abrir o volver al archivo. */
  countsAsAppearance: boolean;
  reported: boolean;
  blocked: boolean;
};

export class ErrorSignalTracker {
  private settings: ErrorSignalSettings;
  private documentKey: string | null = null;
  private readonly presences = new Map<string, Presence>();
  /** Claves presentes en orden de posicion; la primera es el error visible. */
  private order: string[] = [];
  private readonly appearances = new Map<string, number[]>();
  private readonly lastDetectedAt = new Map<string, number>();
  private readonly lastBlockingAt = new Map<string, number>();

  constructor(settings: Partial<ErrorSignalSettings> = {}) {
    this.settings = { ...DEFAULT_ERROR_SIGNAL_SETTINGS, ...settings };
  }

  updateSettings(settings: Partial<ErrorSignalSettings>) {
    this.settings = { ...this.settings, ...settings };
  }

  /** El error (clave normalizada) sigue presente en el archivo observado. */
  isPresent(key: string) {
    return this.presences.has(key);
  }

  /**
   * Registra los errores actuales del archivo activo (en orden de posicion).
   * documentKey identifica el archivo: al cambiar, los errores que ya tiene
   * se toman como punto de partida y no como apariciones nuevas.
   * lastEditAt es la ultima edicion de ese archivo (ms).
   */
  observe(documentKey: string, errors: ObservedError[], now: number, lastEditAt = Number.NEGATIVE_INFINITY): ErrorSignal[] {
    const settings = this.settings;
    const signals: ErrorSignal[] = [];
    const baseline = documentKey !== this.documentKey;
    if (baseline) {
      this.presences.clear();
      this.documentKey = documentKey;
    }

    const current = new Map<string, ObservedError>();
    for (const error of errors) {
      const key = normalizeErrorText(error.text);
      if (key && !current.has(key)) {
        current.set(key, error);
      }
    }

    for (const key of [...this.presences.keys()]) {
      if (!current.has(key)) {
        this.presences.delete(key);
      }
    }
    for (const [key, error] of current) {
      const presence = this.presences.get(key);
      if (presence) {
        presence.text = error.text;
        presence.line = safeLine(error.line);
        continue;
      }
      this.presences.set(key, {
        key,
        text: error.text,
        line: safeLine(error.line),
        firstSeenAt: now,
        confirmed: false,
        countsAsAppearance: !baseline,
        reported: false,
        blocked: false,
      });
    }
    this.order = [...current.keys()];
    this.prune(now);

    const idleForMs = now - lastEditAt;
    for (const presence of this.presences.values()) {
      if (!presence.confirmed && now - presence.firstSeenAt >= settings.stableMs && idleForMs >= settings.stableMs) {
        presence.confirmed = true;
        if (presence.countsAsAppearance) {
          const list = this.appearances.get(presence.key) || [];
          list.push(now);
          this.appearances.set(presence.key, list);
        }
      }
    }

    const first = this.order.length ? this.presences.get(this.order[0]) : undefined;
    if (first && first.confirmed && !first.reported) {
      first.reported = true;
      const lastDetected = this.lastDetectedAt.get(first.key);
      if (lastDetected === undefined || now - lastDetected >= settings.dedupeMs) {
        this.lastDetectedAt.set(first.key, now);
        signals.push({ type: 'compile_error_detected', key: first.key, text: first.text, line: first.line });
      }
    }

    for (const key of this.order) {
      const presence = this.presences.get(key);
      if (!presence || presence.blocked) {
        continue;
      }
      const lastBlocking = this.lastBlockingAt.get(key);
      if (lastBlocking !== undefined && now - lastBlocking < settings.blockingCooldownMs) {
        continue;
      }
      const durationMs = Math.max(0, now - presence.firstSeenAt);
      const count = this.appearances.get(key)?.length || 0;
      const persistent = durationMs >= settings.blockingMs;
      const repeated = presence.confirmed && presence.countsAsAppearance && count >= settings.repeatThreshold;
      if (!persistent && !repeated) {
        continue;
      }
      presence.blocked = true;
      this.lastBlockingAt.set(key, now);
      signals.push({
        type: 'blocking_detected',
        key,
        text: presence.text,
        line: presence.line,
        durationMs,
        count: Math.max(1, count),
        reason: persistent ? 'persistent' : 'repeated',
      });
    }

    return signals;
  }

  /**
   * Proximo instante en que una nueva observacion podria emitir algo aunque
   * los diagnosticos no cambien (un error que se confirma o que cumple el
   * tiempo de bloqueo). null si no hay nada pendiente.
   */
  nextDeadline(now: number, lastEditAt = Number.NEGATIVE_INFINITY): number | null {
    const settings = this.settings;
    let next = Number.POSITIVE_INFINITY;
    for (const presence of this.presences.values()) {
      if (!presence.confirmed) {
        next = Math.min(next, Math.max(presence.firstSeenAt, lastEditAt) + settings.stableMs);
      }
      if (!presence.blocked) {
        const lastBlocking = this.lastBlockingAt.get(presence.key);
        const cooldownEnd = lastBlocking === undefined ? Number.NEGATIVE_INFINITY : lastBlocking + settings.blockingCooldownMs;
        next = Math.min(next, Math.max(presence.firstSeenAt + settings.blockingMs, cooldownEnd));
      }
    }
    return Number.isFinite(next) ? Math.max(next, now) : null;
  }

  private prune(now: number) {
    const settings = this.settings;
    for (const [key, list] of this.appearances) {
      const recent = list.filter((at) => now - at < settings.repeatWindowMs);
      if (recent.length) {
        this.appearances.set(key, recent);
      } else {
        this.appearances.delete(key);
      }
    }
    for (const [key, at] of this.lastDetectedAt) {
      if (now - at >= settings.dedupeMs) {
        this.lastDetectedAt.delete(key);
      }
    }
    for (const [key, at] of this.lastBlockingAt) {
      if (now - at >= settings.blockingCooldownMs) {
        this.lastBlockingAt.delete(key);
      }
    }
    for (const map of [this.appearances, this.lastDetectedAt, this.lastBlockingAt] as Array<Map<string, unknown>>) {
      while (map.size > MAX_REMEMBERED_KEYS) {
        const oldest = map.keys().next().value as string;
        map.delete(oldest);
      }
    }
  }
}
