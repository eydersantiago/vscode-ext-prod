import { buildIdentityHeaders, CLIENT_ID_HEADER, randomToken, SESSION_ID_HEADER } from './client-identity';

/**
 * Telemetria v1.1 hacia POST /api/behavior/events.
 *
 * - Funciona sin sesion: el backend identifica al estudiante por
 *   x-adaceen-client-id (ver client-identity.ts).
 * - Cada evento lleva schemaVersion "1.1", un seq monotono por activacion y
 *   un clientSessionId aleatorio por activacion; con los huecos de seq el
 *   backend mide cuantos eventos se perdieron.
 * - Los eventos que llegan casi a la vez se mandan juntos (un POST).
 * - Un unico reintento ante error de red. No hay cola offline (se descarto).
 * - El esquema del backend es estricto: solo se mandan las claves del
 *   contrato, recortadas a sus limites.
 *
 * No importa vscode, para poder probarlo con node:test.
 */

export const TELEMETRY_SCHEMA_VERSION = '1.1';
export const TELEMETRY_MAX_EVENTS_PER_REQUEST = 50;

export type TelemetrySource = 'browser_extension' | 'vscode_extension' | 'backend' | 'system';

export type TelemetryCategory =
  | 'suggestion'
  | 'cursor_idle'
  | 'codespace'
  | 'github_pr'
  | 'navigation'
  | 'project_context'
  | 'intervention'
  | 'error'
  | 'workflow'
  | 'tutor'
  | 'signal'
  | 'code_application'
  | 'quiz';

/** Lo que el resto de la extension entrega; buildTelemetryEvent lo limpia. */
export type TelemetryEventInput = {
  category: TelemetryCategory;
  eventType: string;
  source?: TelemetrySource;
  pageContext?: string;
  repoFullName?: string;
  branch?: string;
  filePath?: string;
  language?: string;
  subjectId?: string;
  value?: string;
  durationMs?: number | null;
  count?: number | null;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
  decisionId?: string | null;
  latencyMs?: number | null;
  /** El servidor lo convierte en errorHash y no lo guarda. */
  errorText?: string;
  errorHash?: string;
  contextHash?: string;
};

/** Evento tal como viaja (solo claves del contrato v1.1). */
export type TelemetryEventPayload = {
  source: TelemetrySource;
  category: TelemetryCategory;
  eventType: string;
  pageContext?: string;
  repoFullName?: string;
  branch?: string;
  filePath?: string;
  language?: string;
  subjectId?: string;
  value?: string;
  durationMs?: number;
  count?: number;
  metadata?: Record<string, unknown>;
  occurredAt: string;
  schemaVersion: string;
  seq: number;
  clientSessionId: string;
  decisionId?: string;
  latencyMs?: number;
  errorText?: string;
  errorHash?: string;
  contextHash?: string;
};

type StringLimits = Record<
  'pageContext' | 'repoFullName' | 'branch' | 'filePath' | 'language' | 'subjectId' | 'value' | 'decisionId' | 'errorText',
  number
>;

/** Limites del esquema del backend (behavior-routes). */
export const TELEMETRY_STRING_LIMITS: StringLimits = {
  pageContext: 120,
  repoFullName: 240,
  branch: 160,
  filePath: 700,
  language: 120,
  subjectId: 220,
  value: 1000,
  decisionId: 80,
  errorText: 500,
};

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function cleanInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function cleanHash(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{1,64}$/i.test(value) ? value.toLowerCase() : undefined;
}

export function createClientSessionId(random: () => number = Math.random) {
  return `vss${randomToken(21, random)}`;
}

/**
 * Construye el evento que viaja al backend: rellena los campos v1.1, recorta
 * cadenas y enteros a los limites del esquema y omite lo vacio (el esquema
 * estricto rechaza null en campos que no lo admiten).
 */
export function buildTelemetryEvent(
  input: TelemetryEventInput,
  context: { seq: number; clientSessionId: string; now?: Date },
): TelemetryEventPayload {
  const event: TelemetryEventPayload = {
    source: input.source || 'vscode_extension',
    category: input.category,
    eventType: (cleanString(input.eventType, 120) || 'unknown_event'),
    occurredAt: cleanString(input.occurredAt, 40) || (context.now || new Date()).toISOString(),
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    seq: cleanInt(context.seq, 0, 1_000_000_000) ?? 0,
    clientSessionId: cleanString(context.clientSessionId, 80) || 'sin-sesion-cliente',
  };

  const strings: Array<keyof StringLimits> = [
    'pageContext',
    'repoFullName',
    'branch',
    'filePath',
    'language',
    'subjectId',
    'value',
    'decisionId',
    'errorText',
  ];
  for (const key of strings) {
    const clean = cleanString(input[key], TELEMETRY_STRING_LIMITS[key]);
    if (clean !== undefined) {
      event[key] = clean;
    }
  }

  const durationMs = cleanInt(input.durationMs, 0, 86_400_000);
  if (durationMs !== undefined) {
    event.durationMs = durationMs;
  }
  const count = cleanInt(input.count, 1, 100_000);
  if (count !== undefined) {
    event.count = count;
  }
  const latencyMs = cleanInt(input.latencyMs, 0, 600_000);
  if (latencyMs !== undefined) {
    event.latencyMs = latencyMs;
  }
  const errorHash = cleanHash(input.errorHash);
  if (errorHash) {
    event.errorHash = errorHash;
  }
  const contextHash = cleanHash(input.contextHash);
  if (contextHash) {
    event.contextHash = contextHash;
  }
  if (input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)) {
    event.metadata = input.metadata;
  }
  return event;
}

const LEGACY_KEYS = new Set([
  'source',
  'category',
  'eventType',
  'pageContext',
  'repoFullName',
  'branch',
  'filePath',
  'language',
  'subjectId',
  'value',
  'durationMs',
  'count',
  'metadata',
  'occurredAt',
]);

/**
 * Compatibilidad con un backend anterior a la v1.1 (esquema estricto sin las
 * claves nuevas): los campos v1.1 pasan a metadata. errorText no se manda,
 * porque ese backend lo guardaria en claro.
 */
export function toLegacyTelemetryEvent(event: TelemetryEventPayload): Record<string, unknown> {
  const legacy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (LEGACY_KEYS.has(key)) {
      legacy[key] = value;
    }
  }
  legacy.metadata = {
    ...(event.metadata || {}),
    schemaVersion: event.schemaVersion,
    seq: event.seq,
    clientSessionId: event.clientSessionId,
    ...(event.decisionId ? { decisionId: event.decisionId } : {}),
    ...(event.latencyMs !== undefined ? { latencyMs: event.latencyMs } : {}),
  };
  return legacy;
}

export type TelemetryEndpoint = {
  baseUrl: string;
  sessionId: string;
  clientId: string;
};

type PostResult = {
  ok: boolean;
  status: number;
  /** true cuando fetch fallo (red caida, DNS, tiempo agotado). */
  networkError: boolean;
  error: string;
};

type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type TelemetryClientOptions = {
  getEndpoint: () => TelemetryEndpoint | null;
  /**
   * Metadata que llevan todos los eventos (editorHost, editorUi). La metadata
   * propia del evento manda si repite una clave.
   */
  baseMetadata?: () => Record<string, unknown>;
  log?: (line: string) => void;
  fetchImpl?: FetchLike;
  /** Espera para juntar eventos casi simultaneos en un solo POST. */
  flushDelayMs?: number;
  /** Espera antes del unico reintento ante error de red. */
  retryDelayMs?: number;
  timeoutMs?: number;
  random?: () => number;
};

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

export class TelemetryClient {
  readonly clientSessionId: string;
  private seq = 0;
  private pending: TelemetryEventPayload[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private readonly options: Required<Omit<TelemetryClientOptions, 'log' | 'fetchImpl' | 'random' | 'baseMetadata'>> & TelemetryClientOptions;

  constructor(options: TelemetryClientOptions) {
    this.options = {
      flushDelayMs: 300,
      retryDelayMs: 1500,
      timeoutMs: 8000,
      ...options,
    };
    this.clientSessionId = createClientSessionId(options.random);
  }

  /** Siguiente valor de seq que se asignaria (para pruebas y diagnostico). */
  get nextSeq() {
    return this.seq;
  }

  /** Encola un evento; sale en el siguiente POST (unos cientos de ms). */
  track(input: TelemetryEventInput): TelemetryEventPayload {
    const base = this.options.baseMetadata?.();
    const withBase = base && Object.keys(base).length
      ? { ...input, metadata: { ...base, ...(input.metadata || {}) } }
      : input;
    const event = buildTelemetryEvent(withBase, { seq: this.seq, clientSessionId: this.clientSessionId });
    this.seq += 1;
    this.pending.push(event);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, this.options.flushDelayMs);
    }
    return event;
  }

  /** Manda todo lo pendiente. Nunca lanza. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const events = this.pending.splice(0, this.pending.length);
    for (let index = 0; index < events.length; index += TELEMETRY_MAX_EVENTS_PER_REQUEST) {
      await this.sendChunk(events.slice(index, index + TELEMETRY_MAX_EVENTS_PER_REQUEST));
    }
  }

  dispose() {
    void this.flush();
  }

  private async sendChunk(events: TelemetryEventPayload[]) {
    if (!events.length) {
      return;
    }
    const endpoint = this.options.getEndpoint();
    const baseUrl = (endpoint?.baseUrl || '').replace(/\/+$/, '');
    if (!endpoint || !baseUrl) {
      return;
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      ...buildIdentityHeaders(endpoint.sessionId, endpoint.clientId),
    };
    if (!headers[CLIENT_ID_HEADER] && !headers[SESSION_ID_HEADER]) {
      // Sin sesion ni clientId el backend no sabria de quien es el evento.
      return;
    }

    const url = `${baseUrl}/api/behavior/events`;
    let result = await this.post(url, headers, JSON.stringify({ events }));
    if (!result.ok && result.networkError) {
      await wait(this.options.retryDelayMs);
      result = await this.post(url, headers, JSON.stringify({ events }));
    }
    if (!result.ok && result.status === 400 && /unrecognized key/i.test(result.error)) {
      // Backend anterior a la v1.1: se reenvia con las claves de siempre.
      result = await this.post(url, headers, JSON.stringify({ events: events.map(toLegacyTelemetryEvent) }));
    }

    if (result.ok) {
      if (this.consecutiveFailures > 0) {
        this.options.log?.(`[Metrics] Telemetria recuperada tras ${this.consecutiveFailures} envio(s) fallido(s).`);
      }
      this.consecutiveFailures = 0;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures === 1 || this.consecutiveFailures % 20 === 0) {
      const names = [...new Set(events.map((event) => event.eventType))].join(', ');
      this.options.log?.(
        `[Metrics] No se pudo registrar ${names} (${result.status ? `HTTP ${result.status}` : 'sin red'}): ${result.error}`,
      );
    }
  }

  private async post(url: string, headers: Record<string, string>, body: string): Promise<PostResult> {
    const fetchImpl: FetchLike = this.options.fetchImpl || (fetch as unknown as FetchLike);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal });
      const text = await response.text().catch(() => '');
      if (response.ok) {
        return { ok: true, status: response.status, networkError: false, error: '' };
      }
      let error = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === 'string') {
          error = parsed.error.slice(0, 300);
        }
      } catch {
        // Respuesta sin JSON: se deja el texto recortado.
      }
      return { ok: false, status: response.status, networkError: false, error };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        networkError: true,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Sigue cuanto tiempo estuvo a la vista una sugerencia para poder emitir
 * vscode_suggestion_ignored cuando se reemplaza o se descarta sin aplicarse.
 *
 * - markShown: la sugerencia se mostro (tras vscode_suggestion_shown).
 * - onPublish: cambia lo que se ve. Un marcador "cargando" no decide nada
 *   todavia (la respuesta nueva puede traer la misma sugerencia); una
 *   sugerencia distinta o null la dan por ignorada; la misma marcada como
 *   aplicada deja de seguirse.
 */
export class SuggestionExposureTracker<T> {
  private visible: { id: string; item: T; shownAt: number; hiddenAt: number | null } | null = null;

  get currentId(): string {
    return this.visible?.id || '';
  }

  /** Cuando se mostro la sugerencia que se sigue ahora (null si es otra o ninguna). */
  shownAt(id: string): number | null {
    return this.visible && this.visible.id === id ? this.visible.shownAt : null;
  }

  markShown(id: string, item: T, now: number) {
    if (!id) {
      return;
    }
    if (this.visible?.id === id) {
      this.visible.item = item;
      this.visible.hiddenAt = null;
      return;
    }
    this.visible = { id, item, shownAt: now, hiddenAt: null };
  }

  onPublish(
    next: { id: string; loading?: boolean; applied?: boolean } | null,
    now: number,
  ): { item: T; durationMs: number } | null {
    const current = this.visible;
    if (!current) {
      return null;
    }
    if (next && next.id === current.id) {
      if (next.applied) {
        this.visible = null;
      } else if (next.loading) {
        if (current.hiddenAt === null) {
          current.hiddenAt = now;
        }
      } else {
        current.hiddenAt = null;
      }
      return null;
    }
    if (next?.loading) {
      if (current.hiddenAt === null) {
        current.hiddenAt = now;
      }
      return null;
    }
    this.visible = null;
    const endedAt = current.hiddenAt ?? now;
    return { item: current.item, durationMs: Math.max(0, endedAt - current.shownAt) };
  }

  /** El estudiante cerro la sugerencia (p. ej. la ventana flotante). */
  dismiss(id: string, now: number): { item: T; durationMs: number } | null {
    const current = this.visible;
    if (!current || current.id !== id) {
      return null;
    }
    this.visible = null;
    const endedAt = current.hiddenAt ?? now;
    return { item: current.item, durationMs: Math.max(0, endedAt - current.shownAt) };
  }
}
