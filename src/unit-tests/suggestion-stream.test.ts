import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  createLivePainter,
  createNdjsonLineParser,
  createRepaintThrottle,
  createStreamFanout,
  isNdjsonResponse,
  readBackendJsonResponse,
  readSuggestionStream,
} from '../suggestion-stream';
import type { ByteStream, LiveTarget, SuggestionStreamEvent } from '../suggestion-stream';

// 0.0.39: la respuesta del tutor en vivo (NDJSON de /suggest-tab).

function bytesStream(chunks: Array<string | Uint8Array>): ByteStream & { cancelled: boolean } {
  const encoder = new TextEncoder();
  const queue = chunks.map((chunk) => (typeof chunk === 'string' ? encoder.encode(chunk) : chunk));
  const stream = {
    cancelled: false,
    getReader() {
      return {
        read: async () => {
          const value = queue.shift();
          return value ? { done: false, value } : { done: true };
        },
        cancel: async () => {
          stream.cancelled = true;
        },
        releaseLock: () => undefined,
      };
    },
  };
  return stream;
}

/** Reloj a mano para los topes de frecuencia. */
function manualClock() {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => nowMs,
    setTimer: (callback: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: nowMs + ms, callback });
      return id;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      nowMs += ms;
      for (const [id, timer] of [...timers.entries()].sort((left, right) => left[1].at - right[1].at)) {
        if (timer.at <= nowMs) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

describe('NDJSON de /suggest-tab (0.0.39)', () => {
  it('junta las lineas cortadas entre trozos, tambien una letra con tilde partida en dos bytes', () => {
    const values: unknown[] = [];
    const parser = createNdjsonLineParser((value) => values.push(value));
    const bytes = new TextEncoder().encode('{"type":"partial","text":"explicación"}\n{"type":"final","status":200,"body":{}}\n');
    const cut = bytes.indexOf(0xc3) + 1; // a mitad de la «ó»
    parser.push(bytes.slice(0, 10));
    parser.push(bytes.slice(10, cut));
    parser.push(bytes.slice(cut));
    parser.end();
    assert.deepEqual(values, [{ type: 'partial', text: 'explicación' }, { type: 'final', status: 200, body: {} }]);
  });

  it('una linea que no es JSON se ignora y una ultima sin salto de linea tambien se lee', () => {
    const values: unknown[] = [];
    const parser = createNdjsonLineParser((value) => values.push(value));
    parser.push('basura\n\n{"a":1}\n{"b":');
    parser.push('2}');
    parser.end();
    assert.deepEqual(values, [{ a: 1 }, { b: 2 }]);
  });

  it('readSuggestionStream entrega parciales y reinicios y devuelve el final; despues del final no lee mas', async () => {
    const events: SuggestionStreamEvent[] = [];
    const body = bytesStream([
      '{"type":"partial","text":"Uno"}\n{"type":"par',
      'tial","text":"Uno dos"}\n{"type":"restart"}\n',
      '{"type":"partial","text":"Otra"}\n{"type":"final","status":200,"body":{"ok":true,"output_text":"x"}}\n',
      '{"type":"partial","text":"despues del final"}\n',
    ]);
    const final = await readSuggestionStream(body, (event) => events.push(event));
    assert.deepEqual(final, { status: 200, body: { ok: true, output_text: 'x' } });
    assert.deepEqual(events, [
      { type: 'partial', text: 'Uno' },
      { type: 'partial', text: 'Uno dos' },
      { type: 'restart' },
      { type: 'partial', text: 'Otra' },
    ]);
    assert.equal(body.cancelled, true);
  });

  it('un aviso que falla no corta la lectura; sin final devuelve null', async () => {
    const final = await readSuggestionStream(bytesStream(['{"type":"partial","text":"a"}\n{"type":"final","status":200,"body":{"ok":true}}\n']), () => {
      throw new Error('pantalla');
    });
    assert.deepEqual(final, { status: 200, body: { ok: true } });
    assert.equal(await readSuggestionStream(bytesStream(['{"type":"partial","text":"a"}\n']), undefined), null);
  });

  it('readBackendJsonResponse: NDJSON da el status y el cuerpo del final; JSON de un backend anterior, igual que siempre', async () => {
    const ndjson = await readBackendJsonResponse({
      status: 200,
      headers: { get: () => 'application/x-ndjson; charset=utf-8' },
      body: bytesStream(['{"type":"final","status":400,"body":{"ok":false,"error":"tab_content requerido"}}\n']),
      text: async () => '',
    });
    assert.equal(ndjson.status, 400);
    assert.deepEqual(ndjson.data, { ok: false, error: 'tab_content requerido' });

    const events: SuggestionStreamEvent[] = [];
    const json = await readBackendJsonResponse({
      status: 200,
      headers: { get: () => 'application/json; charset=utf-8' },
      body: bytesStream([]),
      text: async () => '{"ok":true,"output_text":"hola"}',
    }, (event) => events.push(event));
    assert.deepEqual(json.data, { ok: true, output_text: 'hola' });
    assert.deepEqual(events, [], 'un backend anterior no manda parciales');

    await assert.rejects(readBackendJsonResponse({
      status: 200,
      headers: { get: () => 'application/x-ndjson' },
      body: bytesStream(['{"type":"partial","text":"a"}\n']),
      text: async () => '',
    }), /antes del final/);
    assert.equal(isNdjsonResponse('Application/X-NDJSON;charset=utf-8'), true);
    assert.equal(isNdjsonResponse('application/json'), false);
  });
});

describe('pedido compartido: la explicacion en vivo llega a todos los que esperan', () => {
  it('cada uno recibe los eventos; el que llega tarde recibe primero el ultimo texto; despues de cerrar, nada', () => {
    const fanout = createStreamFanout();
    const first: SuggestionStreamEvent[] = [];
    const second: SuggestionStreamEvent[] = [];
    fanout.subscribe((event) => first.push(event));
    fanout.emit({ type: 'partial', text: 'Uno' });
    const unsubscribe = fanout.subscribe((event) => second.push(event));
    fanout.emit({ type: 'partial', text: 'Uno dos' });
    unsubscribe();
    fanout.emit({ type: 'partial', text: 'Uno dos tres' });
    assert.deepEqual(first.map((event) => event.type === 'partial' && event.text), ['Uno', 'Uno dos', 'Uno dos tres']);
    assert.deepEqual(second.map((event) => event.type === 'partial' && event.text), ['Uno', 'Uno dos']);
    fanout.close();
    fanout.emit({ type: 'partial', text: 'tarde' });
    assert.equal(first.length, 3);
    assert.equal(fanout.size, 0);
  });

  it('un reinicio borra el ultimo texto para quien se suma despues', () => {
    const fanout = createStreamFanout();
    fanout.emit({ type: 'partial', text: 'primera respuesta' });
    fanout.emit({ type: 'restart' });
    const late: SuggestionStreamEvent[] = [];
    fanout.subscribe((event) => late.push(event));
    assert.deepEqual(late, []);
  });

  it('uno que falla no deja sin texto a los demas', () => {
    const fanout = createStreamFanout();
    const seen: string[] = [];
    fanout.subscribe(() => {
      throw new Error('x');
    });
    fanout.subscribe((event) => seen.push(event.type));
    fanout.emit({ type: 'partial', text: 'a' });
    assert.deepEqual(seen, ['partial']);
  });
});

describe('repintado en vivo con tope de frecuencia', () => {
  it('el primero enseguida, despues como mucho uno cada 250 ms con el ultimo texto', () => {
    const clock = manualClock();
    const painted: string[] = [];
    const throttle = createRepaintThrottle<string>({ intervalMs: 250, paint: (text) => painted.push(text), ...clock });
    throttle.push('a');
    throttle.push('ab');
    throttle.push('abc');
    assert.deepEqual(painted, ['a']);
    clock.advance(249);
    assert.deepEqual(painted, ['a']);
    clock.advance(1);
    assert.deepEqual(painted, ['a', 'abc']);
    throttle.push('abcd');
    throttle.cancel();
    clock.advance(1000);
    assert.deepEqual(painted, ['a', 'abc']);
    assert.equal(clock.pending, 0);
  });
});

type Model = LiveTarget & { label: string };

describe('pintor en vivo: un pedido viejo no pinta', () => {
  function setup(initial: Model, canPaint = () => true) {
    const clock = manualClock();
    let current: Model | null = initial;
    const painted: Model[] = [];
    const painter = createLivePainter<Model>({
      current: () => current,
      target: initial,
      paint: (model) => {
        current = model;
        painted.push(model);
      },
      canPaint,
      ...clock,
    });
    return { clock, painter, painted, set: (model: Model | null) => { current = model; }, get: () => current };
  }

  const waiting: Model = { metricId: 'm1', uriString: 'file:///a.cpp', loading: true, label: 'cargando' };

  it('pinta la explicacion sobre la sugerencia que espera, con tope de frecuencia', () => {
    const { clock, painter, painted, get } = setup(waiting);
    painter.onEvent({ type: 'partial', text: 'Uno' });
    painter.onEvent({ type: 'partial', text: 'Uno dos' });
    assert.deepEqual(painted.map((model) => model.partialText), ['Uno']);
    clock.advance(250);
    assert.deepEqual(painted.map((model) => model.partialText), ['Uno', 'Uno dos']);
    assert.equal(get()?.partialText, 'Uno dos');
    assert.equal(get()?.label, 'cargando', 'el resto del modelo no cambia');
  });

  it('otra sugerencia (nueva seleccion) o ya llego la respuesta: no pinta; lo pendiente se descarta', () => {
    const { clock, painter, painted, set } = setup(waiting);
    painter.onEvent({ type: 'partial', text: 'Uno' });
    painter.onEvent({ type: 'partial', text: 'Uno dos' });
    set({ metricId: 'm2', uriString: 'file:///a.cpp', loading: true, label: 'otra seleccion' });
    clock.advance(500);
    painter.onEvent({ type: 'partial', text: 'Uno dos tres' });
    clock.advance(500);
    assert.deepEqual(painted.map((model) => model.partialText), ['Uno']);
    set({ ...waiting, loading: false, label: 'lista' });
    painter.onEvent({ type: 'partial', text: 'tarde' });
    clock.advance(500);
    assert.equal(painted.length, 1);
  });

  it('dispose (pedido cancelado o respuesta lista) no deja nada pendiente', () => {
    const { clock, painter, painted } = setup(waiting);
    painter.onEvent({ type: 'partial', text: 'Uno' });
    painter.onEvent({ type: 'partial', text: 'Uno dos' });
    painter.dispose();
    clock.advance(1000);
    painter.onEvent({ type: 'partial', text: 'Uno dos tres' });
    clock.advance(1000);
    assert.deepEqual(painted.map((model) => model.partialText), ['Uno']);
    assert.equal(clock.pending, 0);
  });

  it('la ventana ya no esta en ese sitio (o la cerro): no la reabre', () => {
    let open = true;
    const { painter, painted } = setup(waiting, () => open);
    painter.onEvent({ type: 'partial', text: 'Uno' });
    open = false;
    painter.onEvent({ type: 'partial', text: 'Uno dos' });
    painter.onEvent({ type: 'partial', text: 'Uno dos tres' });
    assert.deepEqual(painted.map((model) => model.partialText), ['Uno']);
  });

  it('un reinicio (el backend volvio a preguntar) borra lo que se mostraba', () => {
    const { clock, painter, get } = setup({ ...waiting, loading: false, pendingMode: 'replace' });
    painter.onEvent({ type: 'partial', text: 'Primera' });
    clock.advance(300);
    painter.onEvent({ type: 'restart' });
    clock.advance(300);
    assert.equal(get()?.partialText, '');
  });
});
