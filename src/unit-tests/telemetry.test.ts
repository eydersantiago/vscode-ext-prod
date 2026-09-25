import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildTelemetryEvent,
  SuggestionExposureTracker,
  TELEMETRY_SCHEMA_VERSION,
  TelemetryClient,
  TelemetryEventPayload,
  toLegacyTelemetryEvent,
} from '../telemetry';

const CONTRACT_KEYS = new Set([
  'source', 'category', 'eventType', 'pageContext', 'repoFullName', 'branch', 'filePath', 'language',
  'subjectId', 'value', 'durationMs', 'count', 'metadata', 'occurredAt', 'schemaVersion', 'seq',
  'clientSessionId', 'decisionId', 'latencyMs', 'errorText', 'errorHash', 'contextHash',
]);

type Call = { url: string; headers: Record<string, string>; body: { events: Array<Record<string, unknown>> } };

function fakeFetch(responses: Array<{ status: number; body?: unknown } | 'network-error'>) {
  const calls: Call[] = [];
  const impl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = responses.shift() ?? { status: 200, body: { ok: true } };
    if (next === 'network-error') {
      throw new TypeError('fetch failed');
    }
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => JSON.stringify(next.body ?? {}),
    };
  };
  return { impl, calls };
}

describe('buildTelemetryEvent', () => {
  it('agrega los campos v1.1 y respeta los limites del esquema', () => {
    const event = buildTelemetryEvent({
      category: 'signal',
      eventType: 'compile_error_detected',
      value: 'v'.repeat(1500),
      errorText: 'e'.repeat(900),
      decisionId: 'd'.repeat(120),
      latencyMs: 9_999_999,
      durationMs: 12.6,
      count: 0,
      filePath: '  src/Main.java  ',
      errorHash: 'no-es-hex',
      metadata: { line: 3 },
    }, { seq: 7, clientSessionId: 'vss123', now: new Date('2026-09-23T10:00:00.000Z') });

    assert.equal(event.schemaVersion, TELEMETRY_SCHEMA_VERSION);
    assert.equal(event.schemaVersion, '1.1');
    assert.equal(event.seq, 7);
    assert.equal(event.clientSessionId, 'vss123');
    assert.equal(event.source, 'vscode_extension');
    assert.equal(event.occurredAt, '2026-09-23T10:00:00.000Z');
    assert.equal(event.value?.length, 1000);
    assert.equal(event.errorText?.length, 500);
    assert.equal(event.decisionId?.length, 80);
    assert.equal(event.latencyMs, 600000);
    assert.equal(event.durationMs, 13);
    assert.equal(event.count, 1);
    assert.equal(event.filePath, 'src/Main.java');
    assert.equal('errorHash' in event, false);
    assert.deepEqual(event.metadata, { line: 3 });
    for (const key of Object.keys(event)) {
      assert.ok(CONTRACT_KEYS.has(key), `clave fuera del contrato: ${key}`);
    }
  });

  it('omite los campos vacios o nulos (el esquema estricto no acepta null en ellos)', () => {
    const event = buildTelemetryEvent({
      category: 'suggestion',
      eventType: 'vscode_suggestion_shown',
      decisionId: null,
      latencyMs: null,
      durationMs: undefined,
      repoFullName: '   ',
    }, { seq: 0, clientSessionId: 'vss1' });
    assert.equal('decisionId' in event, false);
    assert.equal('latencyMs' in event, false);
    assert.equal('durationMs' in event, false);
    assert.equal('repoFullName' in event, false);
  });

  it('el formato viejo mueve los campos v1.1 a metadata y no manda errorText', () => {
    const event = buildTelemetryEvent({
      category: 'suggestion',
      eventType: 'vscode_suggestion_shown',
      decisionId: 'dec-1',
      latencyMs: 120,
      errorText: 'secreto',
      metadata: { a: 1 },
    }, { seq: 4, clientSessionId: 'vss9' });
    const legacy = toLegacyTelemetryEvent(event);
    assert.equal('schemaVersion' in legacy, false);
    assert.equal('seq' in legacy, false);
    assert.equal('errorText' in legacy, false);
    assert.equal('decisionId' in legacy, false);
    assert.deepEqual(legacy.metadata, {
      a: 1,
      schemaVersion: '1.1',
      seq: 4,
      clientSessionId: 'vss9',
      decisionId: 'dec-1',
      latencyMs: 120,
    });
  });
});

describe('TelemetryClient', () => {
  const endpoint = { baseUrl: 'http://backend.test/', sessionId: '', clientId: 'vscabcdefgh123' };

  it('manda sin sesion con x-adaceen-client-id, junta eventos y numera seq', async () => {
    const { impl, calls } = fakeFetch([{ status: 200 }]);
    const client = new TelemetryClient({ getEndpoint: () => endpoint, fetchImpl: impl, flushDelayMs: 5, random: () => 0 });
    client.track({ category: 'suggestion', eventType: 'vscode_suggestion_shown' });
    client.track({ category: 'suggestion', eventType: 'vscode_suggestion_ignored', durationMs: 1500 });
    await client.flush();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://backend.test/api/behavior/events');
    assert.equal(calls[0].headers['x-adaceen-client-id'], 'vscabcdefgh123');
    assert.equal(calls[0].headers['x-session-id'], undefined);
    const events = calls[0].body.events;
    assert.deepEqual(events.map((event) => event.seq), [0, 1]);
    assert.ok(events.every((event) => event.clientSessionId === client.clientSessionId));
    assert.ok(events.every((event) => event.schemaVersion === '1.1'));
    assert.equal(client.nextSeq, 2);
  });

  it('agrega a cada evento la metadata base (entorno del editor) sin pisar la del evento', async () => {
    const { impl, calls } = fakeFetch([{ status: 200 }]);
    const client = new TelemetryClient({
      getEndpoint: () => endpoint,
      fetchImpl: impl,
      flushDelayMs: 5,
      baseMetadata: () => ({ editorHost: 'local', editorUi: 'desktop' }),
    });
    client.track({ category: 'suggestion', eventType: 'vscode_suggestion_shown' });
    client.track({ category: 'signal', eventType: 'compile_error_detected', metadata: { line: 4, editorUi: 'web' } });
    await client.flush();

    const events = calls[0].body.events;
    assert.deepEqual(events[0].metadata, { editorHost: 'local', editorUi: 'desktop' });
    assert.deepEqual(events[1].metadata, { editorHost: 'local', editorUi: 'web', line: 4 });
  });

  it('con sesion manda tambien x-session-id', async () => {
    const { impl, calls } = fakeFetch([{ status: 200 }]);
    const client = new TelemetryClient({ getEndpoint: () => ({ ...endpoint, sessionId: 'ses-1' }), fetchImpl: impl, flushDelayMs: 5 });
    client.track({ category: 'signal', eventType: 'blocking_detected' });
    await client.flush();
    assert.equal(calls[0].headers['x-session-id'], 'ses-1');
    assert.equal(calls[0].headers['x-adaceen-client-id'], 'vscabcdefgh123');
  });

  it('reintenta una sola vez ante error de red', async () => {
    const { impl, calls } = fakeFetch(['network-error', 'network-error']);
    const logs: string[] = [];
    const client = new TelemetryClient({ getEndpoint: () => endpoint, fetchImpl: impl, flushDelayMs: 5, retryDelayMs: 1, log: (line) => logs.push(line) });
    client.track({ category: 'suggestion', eventType: 'vscode_suggestion_shown' });
    await client.flush();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body, calls[1].body);
    assert.equal(logs.length, 1);
  });

  it('no reintenta ante un error HTTP del servidor', async () => {
    const { impl, calls } = fakeFetch([{ status: 500, body: { ok: false, error: 'boom' } }]);
    const client = new TelemetryClient({ getEndpoint: () => endpoint, fetchImpl: impl, flushDelayMs: 5, retryDelayMs: 1 });
    client.track({ category: 'suggestion', eventType: 'vscode_suggestion_shown' });
    await client.flush();
    assert.equal(calls.length, 1);
  });

  it('con un backend anterior a la v1.1 reenvia con las claves de siempre', async () => {
    const { impl, calls } = fakeFetch([
      { status: 400, body: { ok: false, error: "Unrecognized key(s) in object: 'schemaVersion', 'seq'" } },
      { status: 200 },
    ]);
    const client = new TelemetryClient({ getEndpoint: () => endpoint, fetchImpl: impl, flushDelayMs: 5 });
    client.track({ category: 'suggestion', eventType: 'vscode_suggestion_shown', decisionId: 'dec-9', errorText: 'x' });
    await client.flush();
    assert.equal(calls.length, 2);
    const legacy = calls[1].body.events[0];
    assert.equal('schemaVersion' in legacy, false);
    assert.equal('errorText' in legacy, false);
    assert.equal((legacy.metadata as Record<string, unknown>).decisionId, 'dec-9');
  });

  it('no manda nada sin backend o sin identidad', async () => {
    const { impl, calls } = fakeFetch([]);
    const withoutIdentity = new TelemetryClient({ getEndpoint: () => ({ baseUrl: 'http://b', sessionId: '', clientId: '' }), fetchImpl: impl, flushDelayMs: 5 });
    withoutIdentity.track({ category: 'suggestion', eventType: 'a' });
    await withoutIdentity.flush();
    const withoutBackend = new TelemetryClient({ getEndpoint: () => null, fetchImpl: impl, flushDelayMs: 5 });
    withoutBackend.track({ category: 'suggestion', eventType: 'b' });
    await withoutBackend.flush();
    assert.equal(calls.length, 0);
  });

  it('parte en lotes de 50 eventos', async () => {
    const { impl, calls } = fakeFetch([]);
    const client = new TelemetryClient({ getEndpoint: () => endpoint, fetchImpl: impl, flushDelayMs: 5 });
    for (let index = 0; index < 120; index += 1) {
      client.track({ category: 'suggestion', eventType: 'vscode_suggestion_shown' });
    }
    await client.flush();
    assert.deepEqual(calls.map((call) => call.body.events.length), [50, 50, 20]);
    const seqs = calls.flatMap((call) => call.body.events.map((event) => (event as unknown as TelemetryEventPayload).seq));
    assert.deepEqual(seqs, Array.from({ length: 120 }, (_, index) => index));
  });
});

describe('SuggestionExposureTracker', () => {
  it('una sugerencia reemplazada por otra cuenta como ignorada con su tiempo visible', () => {
    const tracker = new SuggestionExposureTracker<string>();
    tracker.markShown('a', 'A', 1000);
    assert.equal(tracker.onPublish({ id: 'b' }, 4000)?.durationMs, 3000);
    assert.equal(tracker.currentId, '');
  });

  it('el marcador de carga no decide; si vuelve la misma sugerencia no es ignorada', () => {
    const tracker = new SuggestionExposureTracker<string>();
    tracker.markShown('a', 'A', 1000);
    assert.equal(tracker.onPublish({ id: 'local', loading: true }, 2000), null);
    assert.equal(tracker.onPublish({ id: 'a' }, 5000), null);
    assert.equal(tracker.currentId, 'a');
  });

  it('si tras cargar llega otra, el tiempo visible termina cuando empezo la carga', () => {
    const tracker = new SuggestionExposureTracker<string>();
    tracker.markShown('a', 'A', 1000);
    tracker.onPublish({ id: 'local', loading: true }, 2500);
    const ignored = tracker.onPublish({ id: 'c' }, 9000);
    assert.deepEqual(ignored, { item: 'A', durationMs: 1500 });
  });

  it('aplicar la sugerencia la saca del seguimiento sin marcarla ignorada', () => {
    const tracker = new SuggestionExposureTracker<string>();
    tracker.markShown('a', 'A', 1000);
    assert.equal(tracker.shownAt('a'), 1000);
    assert.equal(tracker.onPublish({ id: 'a', applied: true }, 3000), null);
    assert.equal(tracker.onPublish(null, 4000), null);
  });

  it('desaparecer (null) o cerrar la ventana la marca ignorada', () => {
    const tracker = new SuggestionExposureTracker<string>();
    tracker.markShown('a', 'A', 1000);
    assert.equal(tracker.onPublish(null, 1800)?.durationMs, 800);
    tracker.markShown('b', 'B', 2000);
    assert.equal(tracker.dismiss('otra', 2500), null);
    assert.deepEqual(tracker.dismiss('b', 2600), { item: 'B', durationMs: 600 });
  });
});
