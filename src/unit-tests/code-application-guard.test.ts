import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  ApplyCheckRequest,
  CodeApplicationAttempt,
  CodeApplicationGuardDeps,
  guardCodeApplication,
  isOfflineApplicationAllowed,
  measureCodeChange,
  parseApplyCheckResponse,
} from '../code-application-guard';
import type { TelemetryEventInput } from '../telemetry';

function harness(options: {
  response?: unknown;
  fail?: Error;
  confirm?: boolean;
  offlineMaxLines?: number;
} = {}) {
  const requests: ApplyCheckRequest[] = [];
  const notifications: string[] = [];
  const confirmations: Array<{ message: string; detail: string }> = [];
  const events: TelemetryEventInput[] = [];
  const deps: CodeApplicationGuardDeps = {
    requestApplyCheck: async (request) => {
      requests.push(request);
      if (options.fail) {
        throw options.fail;
      }
      return options.response;
    },
    confirm: async (message, detail) => {
      confirmations.push({ message, detail });
      return options.confirm ?? true;
    },
    notify: (message) => {
      notifications.push(message);
    },
    track: (event) => {
      events.push(event);
    },
    offlineMaxLines: () => options.offlineMaxLines ?? 12,
  };
  return { deps, requests, notifications, confirmations, events };
}

const INSERT_FOUR_LINES: CodeApplicationAttempt = {
  decisionId: 'dec-1',
  filePath: 'src/Main.java',
  language: 'java',
  applyMode: 'insert',
  originalText: '',
  newText: 'int a = 1;\nint b = 2;\n\nint c = a + b;\nSystem.out.println(c);',
  trigger: 'selection',
  origin: 'selection_widget',
  fileLabel: 'Main.java',
};

function lines(count: number) {
  return Array.from({ length: count }, (_, index) => `linea${index};`).join('\n');
}

describe('measureCodeChange', () => {
  it('insert cuenta las lineas no vacias insertadas', () => {
    assert.deepEqual(measureCodeChange('insert', '', 'a;\n\n  b;\r\nc;\n'), { linesChanged: 3, charsChanged: 13 });
  });

  it('delete cuenta las lineas no vacias eliminadas', () => {
    assert.deepEqual(measureCodeChange('delete', 'x = 1\n\ny = 2\n', ''), { linesChanged: 2, charsChanged: 13 });
  });

  it('replace solo cuenta lo que cambia de verdad', () => {
    const original = 'int a = 1;\nint b = 2;\nreturn a;';
    const next = 'int a = 1;\n  int b = 3;\nreturn a;\n// TODO: revisar';
    assert.equal(measureCodeChange('replace', original, next).linesChanged, 2);
    assert.equal(measureCodeChange('replace', original, original).linesChanged, 0);
    assert.equal(measureCodeChange('replace', original, original).charsChanged, 0);
    // Reindentar no cuenta como cambio de lineas.
    assert.equal(measureCodeChange('replace', 'a;\nb;', '  a;\n  b;').linesChanged, 0);
    assert.equal(measureCodeChange('replace', 'abc', 'abXc').charsChanged, 1);
  });

  it('respeta los limites del contrato', () => {
    const huge = measureCodeChange('insert', '', lines(6000));
    assert.equal(huge.linesChanged, 5000);
  });
});

describe('parseApplyCheckResponse', () => {
  it('normaliza una respuesta valida', () => {
    assert.deepEqual(parseApplyCheckResponse({
      ok: true,
      allowed: false,
      reason: ' Ya usaste tus 3 aplicaciones. ',
      reasonCode: 'code_application_limit_reached',
      maxLines: 20,
      remaining: 0,
      requireConfirmation: true,
      decisionId: 'dec-7',
    }), {
      allowed: false,
      reason: 'Ya usaste tus 3 aplicaciones.',
      reasonCode: 'code_application_limit_reached',
      maxLines: 20,
      remaining: 0,
      requireConfirmation: true,
      decisionId: 'dec-7',
    });
  });

  it('devuelve null si no trae allowed booleano', () => {
    assert.equal(parseApplyCheckResponse({}), null);
    assert.equal(parseApplyCheckResponse({ allowed: 'true' }), null);
    assert.equal(parseApplyCheckResponse(null), null);
    assert.equal(parseApplyCheckResponse([]), null);
  });

  it('remaining null se conserva como null', () => {
    const parsed = parseApplyCheckResponse({ allowed: true, remaining: null, maxLines: 20 });
    assert.equal(parsed?.remaining, null);
    assert.equal(parsed?.reasonCode, 'ok');
    assert.equal(parsed?.decisionId, null);
  });
});

describe('isOfflineApplicationAllowed', () => {
  it('permite hasta offlineMaxLines inclusive', () => {
    assert.equal(isOfflineApplicationAllowed(12, 12), true);
    assert.equal(isOfflineApplicationAllowed(13, 12), false);
    assert.equal(isOfflineApplicationAllowed(0, 0), true);
    assert.equal(isOfflineApplicationAllowed(1, 0), false);
  });
});

describe('guardCodeApplication', () => {
  it('manda a apply-check exactamente los campos del contrato', async () => {
    const { deps, requests } = harness({ response: { ok: true, allowed: true, reasonCode: 'ok', requireConfirmation: false } });
    await guardCodeApplication(INSERT_FOUR_LINES, deps);
    assert.deepEqual(requests, [{
      decisionId: 'dec-1',
      filePath: 'src/Main.java',
      language: 'java',
      applyMode: 'insert',
      linesChanged: 4,
      charsChanged: INSERT_FOUR_LINES.newText.length,
      trigger: 'selection',
    }]);
  });

  it('sin decisionId no manda la clave', async () => {
    const { deps, requests } = harness({ response: { allowed: true } });
    await guardCodeApplication({ ...INSERT_FOUR_LINES, decisionId: undefined }, deps);
    assert.equal('decisionId' in requests[0], false);
  });

  it('permitido sin confirmacion: aplica sin preguntar', async () => {
    const { deps, confirmations, notifications, events } = harness({ response: { allowed: true, reasonCode: 'ok', remaining: 2 } });
    const verdict = await guardCodeApplication(INSERT_FOUR_LINES, deps);
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.offline, false);
    assert.equal(verdict.confirmed, false);
    assert.equal(verdict.remaining, 2);
    assert.equal(verdict.linesChanged, 4);
    assert.equal(confirmations.length, 0);
    assert.equal(notifications.length, 0);
    assert.equal(events.length, 0);
  });

  it('allowed=false: no aplica, muestra el motivo y registra code_application_blocked', async () => {
    const { deps, notifications, events, confirmations } = harness({
      response: {
        allowed: false,
        reason: 'Ya usaste las 3 aplicaciones de este archivo.',
        reasonCode: 'code_application_limit_reached',
        maxLines: 20,
        remaining: 0,
        requireConfirmation: true,
        decisionId: 'dec-1',
      },
    });
    const verdict = await guardCodeApplication(INSERT_FOUR_LINES, deps);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reasonCode, 'code_application_limit_reached');
    assert.deepEqual(notifications, ['ADACEEN: Ya usaste las 3 aplicaciones de este archivo.']);
    assert.equal(confirmations.length, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'code_application_blocked');
    assert.equal(events[0].category, 'code_application');
    assert.equal(events[0].value, 'code_application_limit_reached');
    assert.equal(events[0].decisionId, 'dec-1');
    assert.equal(events[0].metadata?.linesChanged, 4);
    assert.equal(events[0].metadata?.origin, 'selection_widget');
  });

  it('allowed=false sin reason usa un texto por defecto segun reasonCode', async () => {
    const { deps, notifications } = harness({ response: { allowed: false, reasonCode: 'code_application_disabled' } });
    await guardCodeApplication(INSERT_FOUR_LINES, deps);
    assert.match(notifications[0], /desactivó la aplicación de código/);
  });

  it('requireConfirmation: pregunta y aplica si el estudiante acepta', async () => {
    const { deps, confirmations } = harness({ response: { allowed: true, requireConfirmation: true }, confirm: true });
    const verdict = await guardCodeApplication(INSERT_FOUR_LINES, deps);
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0].message, /Main\.java/);
    assert.match(confirmations[0].detail, /Son 4 líneas/);
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.confirmed, true);
  });

  it('requireConfirmation: si el estudiante cancela no se aplica ni se registra bloqueo', async () => {
    const { deps, events } = harness({ response: { allowed: true, requireConfirmation: true }, confirm: false });
    const verdict = await guardCodeApplication(INSERT_FOUR_LINES, deps);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.cancelled, true);
    assert.equal(verdict.reasonCode, 'cancelled_by_user');
    assert.equal(events.length, 0);
  });

  it('sin red: aplica si linesChanged <= offlineMaxLines, sin preguntar', async () => {
    const { deps, notifications, events, confirmations } = harness({ fail: new TypeError('fetch failed'), offlineMaxLines: 12 });
    const verdict = await guardCodeApplication(INSERT_FOUR_LINES, deps);
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.offline, true);
    assert.equal(notifications.length, 0);
    assert.equal(events.length, 0);
    assert.equal(confirmations.length, 0);
  });

  it('sin red: bloquea cambios mas grandes que offlineMaxLines', async () => {
    const { deps, notifications, events } = harness({ fail: new Error('Backend no respondio en 8s'), offlineMaxLines: 12 });
    const verdict = await guardCodeApplication({ ...INSERT_FOUR_LINES, newText: lines(13) }, deps);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.offline, true);
    assert.equal(verdict.reasonCode, 'offline_too_large');
    assert.equal(notifications.length, 1);
    assert.match(notifications[0], /hasta 12 línea\(s\) y este tiene 13/);
    assert.equal(events[0].eventType, 'code_application_blocked');
    assert.equal(events[0].value, 'offline_too_large');
    assert.equal(events[0].metadata?.linesChanged, 13);
    assert.equal(events[0].metadata?.offline, true);
  });

  it('una respuesta sin decision (backend viejo, HTML, {}) usa la regla offline', async () => {
    const { deps } = harness({ response: {}, offlineMaxLines: 2 });
    const verdict = await guardCodeApplication(INSERT_FOUR_LINES, deps);
    assert.equal(verdict.offline, true);
    assert.equal(verdict.allowed, false);
  });
});
