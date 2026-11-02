// ADACEEN (VS Code 0.0.39): respuesta del tutor en vivo. Sin importar vscode, para probarlo con
// node:test y para la prueba de contrato del backend (tests/integration/contrato-vscode.test.ts).
//
// /suggest-tab con «Accept: application/x-ndjson» (backend del 01-11-2026) responde por lineas JSON:
//   {"type":"partial","text":"..."}  la explicacion (prosa) que el tutor lleva escrita, acumulada;
//                                    nunca codigo: el codigo llega solo en el final, ya recortado
//   {"type":"restart"}                el backend volvio a preguntar (reintento): borrar lo de antes
//   {"type":"final","status":200,"body":{...}}  el mismo JSON de siempre, siempre la ultima linea
// Un backend anterior (o un camino rapido sin modelo) responde el JSON de siempre: se lee igual que
// en la 0.0.38.

export const SUGGEST_TAB_STREAM_ACCEPT = 'application/x-ndjson, application/json;q=0.9';

export type SuggestionStreamEvent =
  | { type: 'partial'; text: string }
  | { type: 'restart' };

export type SuggestionStreamFinal = { status: number; body: unknown };

/** Tope de la explicacion en vivo que se guarda y se pinta. */
export const LIVE_TEXT_MAX_CHARS = 12_000;

/** La respuesta es NDJSON (por su Content-Type). */
export function isNdjsonResponse(contentType: string | null | undefined) {
  return /^\s*application\/x-ndjson\b/i.test(String(contentType || ''));
}

/**
 * Lector de NDJSON por trozos: las lineas pueden llegar cortadas entre dos trozos (y una letra con
 * tilde, partida entre dos bytes). Entrega cada linea completa ya parseada; una linea que no es JSON
 * se ignora.
 */
export function createNdjsonLineParser(onLine: (value: unknown) => void) {
  const decoder = new TextDecoder();
  let buffer = '';
  const drain = (final: boolean) => {
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      emit(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
    if (final && buffer.trim()) {
      emit(buffer);
      buffer = '';
    }
  };
  const emit = (line: string) => {
    const clean = line.trim();
    if (!clean) {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(clean);
    } catch {
      return;
    }
    onLine(value);
  };
  return {
    push(chunk: Uint8Array | string) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      drain(false);
    },
    end() {
      buffer += decoder.decode();
      drain(true);
    },
  };
}

/** Una linea del NDJSON como evento (parcial o reinicio), como final, o null si no se reconoce. */
export function readStreamLine(value: unknown): { event: SuggestionStreamEvent } | { final: SuggestionStreamFinal } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.type === 'partial' && typeof record.text === 'string') {
    return { event: { type: 'partial', text: record.text.slice(0, LIVE_TEXT_MAX_CHARS) } };
  }
  if (record.type === 'restart') {
    return { event: { type: 'restart' } };
  }
  if (record.type === 'final') {
    const status = Number(record.status);
    return { final: { status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 200, body: record.body ?? {} } };
  }
  return null;
}

/** Lo minimo de un ReadableStream que se lee (fetch en Node y en el navegador). */
export type ByteStream = {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  };
};

/**
 * Lee el cuerpo NDJSON entero: entrega parciales y reinicios a onEvent y devuelve el final (o null
 * si la conexion termino sin final). Un onEvent que falla no corta la lectura.
 */
export async function readSuggestionStream(
  body: ByteStream,
  onEvent: ((event: SuggestionStreamEvent) => void) | undefined,
): Promise<SuggestionStreamFinal | null> {
  const reader = body.getReader();
  let final: SuggestionStreamFinal | null = null;
  const parser = createNdjsonLineParser((value) => {
    const read = readStreamLine(value);
    if (!read) {
      return;
    }
    if ('final' in read) {
      final = read.final;
      return;
    }
    if (final) {
      return;
    }
    try {
      onEvent?.(read.event);
    } catch {
      // Pintar un parcial no puede cortar la respuesta.
    }
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        parser.push(value);
      }
      if (final) {
        // Despues del final no hay nada mas que leer.
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    parser.end();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ya liberado.
    }
  }
  return final;
}

/** Lo minimo de una respuesta de fetch que se lee (Node y navegador). */
export type BackendResponseLike = {
  status: number;
  headers: { get(name: string): string | null };
  body: ByteStream | null;
  text(): Promise<string>;
};

/**
 * La respuesta del backend como { status, data, text }, venga en vivo (NDJSON: los parciales van a
 * onEvent; status y data son los del final) o como el JSON de siempre (backend anterior o camino
 * rapido). Un NDJSON que termina sin final es un error. fetchJsonWithTimeout (backend-http.ts) la
 * usa; la prueba de contrato del backend tambien.
 */
export async function readBackendJsonResponse(
  response: BackendResponseLike,
  onEvent?: (event: SuggestionStreamEvent) => void,
): Promise<{ status: number; data: unknown; text: string }> {
  if (response.body && isNdjsonResponse(response.headers.get('content-type'))) {
    const final = await readSuggestionStream(response.body, onEvent);
    if (!final) {
      throw new Error('El backend corto la respuesta en vivo antes del final.');
    }
    const data = final.body ?? {};
    return { status: final.status, data, text: JSON.stringify(data) };
  }
  const text = await response.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  return { status: response.status, data, text };
}

type ListenerSet = Set<(event: SuggestionStreamEvent) => void>;

/**
 * Reparte los eventos de un pedido en curso a todos los que lo esperan (el pedido se comparte:
 * extension.ts no manda dos iguales a la vez). Quien se suma tarde recibe primero la ultima
 * explicacion que ya llego. unsubscribe() lo saca; despues de close() no se entrega nada.
 */
export function createStreamFanout() {
  const listeners: ListenerSet = new Set();
  let latest = '';
  let closed = false;
  return {
    emit(event: SuggestionStreamEvent) {
      if (closed) {
        return;
      }
      latest = event.type === 'partial' ? event.text : '';
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // Uno que falla no deja sin texto a los demas.
        }
      }
    },
    subscribe(listener: (event: SuggestionStreamEvent) => void) {
      if (closed) {
        return () => undefined;
      }
      listeners.add(listener);
      if (latest) {
        try {
          listener({ type: 'partial', text: latest });
        } catch {
          // Igual que arriba.
        }
      }
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      listeners.clear();
    },
    get size() {
      return listeners.size;
    },
  };
}

type TimerHandle = unknown;

/**
 * Tope de frecuencia para repintar la ventana con el texto en vivo: el primero enseguida, despues
 * como mucho uno por intervalo (siempre el ultimo). cancel() descarta lo pendiente.
 */
export function createRepaintThrottle<T>(options: {
  intervalMs: number;
  paint: (value: T) => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}) {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: TimerHandle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let pending: { value: T } | null = null;
  let lastPaintAt = Number.NEGATIVE_INFINITY;
  let timer: TimerHandle | null = null;
  const fire = () => {
    timer = null;
    if (!pending) {
      return;
    }
    const { value } = pending;
    pending = null;
    lastPaintAt = now();
    options.paint(value);
  };
  return {
    push(value: T) {
      pending = { value };
      if (timer !== null) {
        return;
      }
      const wait = Math.max(0, lastPaintAt + options.intervalMs - now());
      if (wait === 0) {
        fire();
      } else {
        timer = setTimer(fire, wait);
      }
    },
    cancel() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      pending = null;
    },
  };
}

/** Repintado de la ventana: como mucho una vez por este intervalo mientras llega el texto en vivo. */
export const LIVE_REPAINT_INTERVAL_MS = 250;

/** Lo que mira el pintor en vivo del modelo activo (ActiveSuggestionModel lo cumple). */
export type LiveTarget = {
  metricId: string;
  uriString: string;
  loading?: boolean;
  pendingMode?: string;
  partialText?: string;
};

/**
 * Pinta la explicacion en vivo de UN pedido sobre la sugerencia que lo espera (0.0.39). Cada
 * parcial se pinta solo si la sugerencia activa sigue siendo la que se mostro al pedir (mismo
 * metricId y documento) y sigue esperando (loading o pendingMode). Un pedido cancelado o
 * reemplazado (otra seleccion, otra sugerencia, ya llego la respuesta) no pinta nada. Repinta con
 * tope de frecuencia (createRepaintThrottle) y solo con `paint` (la ventana), no con todo lo demas.
 * dispose() deja de pintar (y descarta lo pendiente).
 */
export function createLivePainter<T extends LiveTarget>(options: {
  /** El modelo activo ahora. */
  current: () => T | null;
  /** La sugerencia que espera este pedido (la que se publico al empezar). */
  target: Pick<T, 'metricId' | 'uriString'>;
  /** Guarda el modelo con el texto en vivo y repinta la ventana. */
  paint: (model: T) => void;
  /**
   * Ademas, si todavia se puede pintar: la seleccion sigue igual y la ventana sigue abierta en ese
   * sitio (el estudiante pudo moverse o cerrarla con la X mientras el modelo activo es el mismo).
   */
  canPaint?: (model: T) => boolean;
  intervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}) {
  let disposed = false;
  const stillWaiting = (model: T | null): model is T => !!model
    && model.metricId === options.target.metricId
    && model.uriString === options.target.uriString
    && (!!model.loading || !!model.pendingMode);
  const throttle = createRepaintThrottle<string>({
    intervalMs: options.intervalMs ?? LIVE_REPAINT_INTERVAL_MS,
    now: options.now,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    paint: (text) => {
      if (disposed) {
        return;
      }
      const model = options.current();
      if (!stillWaiting(model) || model.partialText === text) {
        return;
      }
      if (options.canPaint && !options.canPaint(model)) {
        return;
      }
      options.paint({ ...model, partialText: text });
    },
  });
  return {
    onEvent(event: SuggestionStreamEvent) {
      if (disposed) {
        return;
      }
      if (!stillWaiting(options.current())) {
        throttle.cancel();
        return;
      }
      throttle.push(event.type === 'partial' ? event.text.slice(0, LIVE_TEXT_MAX_CHARS) : '');
    },
    dispose() {
      disposed = true;
      throttle.cancel();
    },
  };
}
