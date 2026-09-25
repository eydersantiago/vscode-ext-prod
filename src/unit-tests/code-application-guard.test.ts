import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  ApplyCheckRequest,
  CLICK_CONFIRM_MAX_LINES,
  clickConfirmsChange,
  CodeApplicationAttempt,
  CodeApplicationGuardDeps,
  describeQueuedTarget,
  describeWaitTime,
  guardCodeApplication,
  insertAnchorMatches,
  isExplicitClickOrigin,
  isFreshOverlayClick,
  isOfflineApplicationAllowed,
  measureCodeChange,
  OVERLAY_CLICK_MAX_AGE_MS,
  parseApplyCheckResponse,
  pickTextMatch,
  QUICK_FIX_AUTO_OPEN_WINDOW_MS,
  queuedActionSummary,
  queuedCodeActionAgeMs,
  queuedCodeActionNeedsPrompt,
  QueuedTargetCheck,
  queuedTargetVerified,
  quickFixOrigin,
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
    assert.equal(verdict.confirmedBy, 'dialog');
  });

  it('requireConfirmation con clic explicito: el clic es la confirmacion, sin dialogo', async () => {
    const { deps, confirmations, notifications, events } = harness({
      response: { allowed: true, reasonCode: 'ok', requireConfirmation: true, remaining: 1, decisionId: 'dec-9' },
      confirm: false,
    });
    const verdict = await guardCodeApplication({ ...INSERT_FOUR_LINES, explicitClick: true }, deps);
    assert.equal(confirmations.length, 0, 'no abre el modal «Aplicar»');
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.confirmed, true);
    assert.equal(verdict.confirmedBy, 'click');
    assert.equal(verdict.requireConfirmation, true);
    assert.equal(verdict.remaining, 1);
    assert.equal(verdict.decisionId, 'dec-9');
    assert.equal(notifications.length, 0);
    assert.equal(events.length, 0);
  });

  it('clic explicito: si la politica no permite aplicar, sigue sin aplicar', async () => {
    const { deps, confirmations, notifications, events } = harness({
      response: { allowed: false, reasonCode: 'code_application_disabled', requireConfirmation: true },
    });
    const verdict = await guardCodeApplication({ ...INSERT_FOUR_LINES, explicitClick: true }, deps);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.confirmed, false);
    assert.equal(verdict.confirmedBy, null);
    assert.equal(confirmations.length, 0);
    assert.equal(notifications.length, 1);
    assert.equal(events[0].eventType, 'code_application_blocked');
  });

  it('clic explicito sin red: la regla offline se aplica igual', async () => {
    const { deps, confirmations } = harness({ fail: new TypeError('fetch failed'), offlineMaxLines: 2 });
    const verdict = await guardCodeApplication({ ...INSERT_FOUR_LINES, explicitClick: true }, deps);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reasonCode, 'offline_too_large');
    assert.equal(confirmations.length, 0);
  });

  it('clic explicito sobre un cambio grande: se pregunta igual (y dice por que)', async () => {
    const { deps, confirmations } = harness({ response: { allowed: true, requireConfirmation: true, maxLines: 150 } });
    const verdict = await guardCodeApplication({
      ...INSERT_FOUR_LINES,
      applyMode: 'replace',
      originalText: lines(18),
      newText: lines(18).replace(/linea/g, 'fila'),
      origin: 'codelens',
      explicitClick: true,
    }, deps);
    assert.equal(confirmations.length, 1, 'un clic sin querer en el CodeLens no reescribe 18 lineas sin pausa');
    assert.match(confirmations[0].message, /¿Aplicar el cambio del tutor en Main\.java\?/);
    assert.match(confirmations[0].detail, /Son 18 líneas/);
    assert.match(confirmations[0].detail, new RegExp(`más de ${CLICK_CONFIRM_MAX_LINES} líneas`));
    assert.equal(verdict.confirmedBy, 'dialog');
  });

  it('clic explicito al eliminar: se pregunta igual', async () => {
    const { deps, confirmations } = harness({ response: { allowed: true, requireConfirmation: true }, confirm: false });
    const verdict = await guardCodeApplication({
      ...INSERT_FOUR_LINES,
      applyMode: 'delete',
      originalText: 'int temporal = 0;',
      newText: '',
      origin: 'selection_widget',
      explicitClick: true,
    }, deps);
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0].detail, /^Borra 1 línea\. Tu docente pide confirmar los cambios del tutor que borran código/);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.cancelled, true);
  });

  it(`clic explicito: hasta ${CLICK_CONFIRM_MAX_LINES} lineas sin dialogo, desde ${CLICK_CONFIRM_MAX_LINES + 1} con dialogo`, async () => {
    for (const [count, dialogs] of [[CLICK_CONFIRM_MAX_LINES, 0], [CLICK_CONFIRM_MAX_LINES + 1, 1]] as const) {
      const { deps, confirmations } = harness({ response: { allowed: true, requireConfirmation: true } });
      const verdict = await guardCodeApplication({ ...INSERT_FOUR_LINES, newText: lines(count), explicitClick: true }, deps);
      assert.equal(confirmations.length, dialogs, `${count} lineas`);
      assert.equal(verdict.allowed, true);
      assert.equal(verdict.confirmedBy, dialogs ? 'dialog' : 'click');
    }
    assert.equal(clickConfirmsChange('insert', CLICK_CONFIRM_MAX_LINES), true);
    assert.equal(clickConfirmsChange('replace', CLICK_CONFIRM_MAX_LINES + 1), false);
    assert.equal(clickConfirmsChange('delete', 1), false);
  });

  it('el dialogo antepone confirmDetail (que es y donde se aplicara)', async () => {
    const { deps, confirmations } = harness({ response: { allowed: true, requireConfirmation: true } });
    await guardCodeApplication({
      ...INSERT_FOUR_LINES,
      origin: 'browser_code_action',
      confirmDetail: 'Agregar comentario TODO (lo pediste en el navegador hace 3 días).',
    }, deps);
    assert.equal(confirmations.length, 1);
    assert.equal(
      confirmations[0].detail,
      'Agregar comentario TODO (lo pediste en el navegador hace 3 días). Son 4 líneas. Tu docente pide confirmar antes de aplicar código del tutor. Puedes deshacerlo con Ctrl+Z.',
    );
  });

  it('sin requireConfirmation el clic no cuenta como confirmacion pedida', async () => {
    const { deps } = harness({ response: { allowed: true, requireConfirmation: false } });
    const verdict = await guardCodeApplication({ ...INSERT_FOUR_LINES, explicitClick: true }, deps);
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.confirmed, false);
    assert.equal(verdict.confirmedBy, null);
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

describe('clic explicito del estudiante', () => {
  it('los origenes de la ventana flotante, CodeLens, arreglo rapido, pista, hover y comando son clics', () => {
    for (const origin of ['selection_widget', 'codelens', 'quick_fix', 'inlay_hint', 'hover', 'command']) {
      assert.equal(isExplicitClickOrigin(origin), true, origin);
    }
    for (const origin of ['', 'auto', 'auto_apply', 'browser_code_action', 'SELECTION_WIDGET', 'quick_fix_auto']) {
      assert.equal(isExplicitClickOrigin(origin), false, origin);
    }
  });

  it('el menu de arreglos rapidos que ADACEEN abre solo no cuenta como clic', () => {
    const openedAt = Date.parse('2026-09-25T12:00:00.000Z');
    assert.equal(quickFixOrigin(openedAt, openedAt + 300), 'quick_fix_auto');
    assert.equal(quickFixOrigin(openedAt, openedAt + QUICK_FIX_AUTO_OPEN_WINDOW_MS), 'quick_fix_auto');
    // Ctrl+. del estudiante, despues o sin apertura automatica.
    assert.equal(quickFixOrigin(openedAt, openedAt + QUICK_FIX_AUTO_OPEN_WINDOW_MS + 1), 'quick_fix');
    assert.equal(quickFixOrigin(0, openedAt), 'quick_fix');
    assert.equal(isExplicitClickOrigin(quickFixOrigin(openedAt, openedAt + 300)), false);
    assert.equal(isExplicitClickOrigin(quickFixOrigin(0, openedAt)), true);
  });

  const REQUESTED = '2026-09-25T12:00:00.000Z';
  const at = (ms: number) => new Date(Date.parse(REQUESTED) + ms).toISOString();

  it('reemplazo del overlay reclamado enseguida: el clic del overlay confirma', () => {
    const action = { source: 'browser_extension', metadata: { source: 'browser_sync_panel', requestedFrom: 'overlay_button' }, requestedAt: REQUESTED, claimedAt: at(8_000) };
    assert.equal(queuedCodeActionAgeMs(action), 8_000);
    assert.equal(isFreshOverlayClick(action), true);
  });

  it('hasta 10 minutos en la cola sigue valiendo; despues se pregunta', () => {
    const base = { source: 'browser_extension', metadata: {}, requestedAt: REQUESTED };
    assert.equal(isFreshOverlayClick({ ...base, claimedAt: at(OVERLAY_CLICK_MAX_AGE_MS) }), true);
    assert.equal(isFreshOverlayClick({ ...base, claimedAt: at(OVERLAY_CLICK_MAX_AGE_MS + 1) }), false);
  });

  it('sin claimedAt compara con la hora local', () => {
    const action = { source: 'browser_extension', requestedAt: REQUESTED };
    assert.equal(isFreshOverlayClick(action, Date.parse(REQUESTED) + 60_000), true);
    assert.equal(isFreshOverlayClick(action, Date.parse(REQUESTED) + 3 * 60 * 60_000), false);
  });

  it('sin la hora en que se pidio no se sabe si es reciente: se pregunta', () => {
    assert.equal(queuedCodeActionAgeMs({ source: 'browser_extension' }), null);
    assert.equal(isFreshOverlayClick({ source: 'browser_extension' }), false);
    assert.equal(isFreshOverlayClick({ source: 'browser_extension', requestedAt: 'ayer' }), false);
    assert.equal(isFreshOverlayClick({ metadata: { requestedFrom: 'inline_code_palette' } }), false);
    assert.equal(isFreshOverlayClick({ metadata: { source: 'browser_sync_panel' }, requestedAt: REQUESTED, claimedAt: at(5_000) }), true);
  });

  it('el comando manual no confirma un reemplazo viejo de la cola', () => {
    // «Aplicar siguiente reemplazo del navegador» aplica el mas antiguo pendiente: solo el
    // clic reciente en el overlay confirma (processNextCodeActionForRepo usa isFreshOverlayClick).
    const deHaceTresDias = { source: 'browser_extension', metadata: { requestedFrom: 'overlay_button' }, requestedAt: REQUESTED, claimedAt: at(3 * 24 * 60 * 60_000) };
    assert.equal(isFreshOverlayClick(deHaceTresDias), false);
    assert.equal(queuedCodeActionNeedsPrompt({ explicitClick: isFreshOverlayClick(deHaceTresDias), confirmedByGuard: false, autoApply: false }), true);
  });

  it('sin origen del overlay no es un clic', () => {
    assert.equal(isFreshOverlayClick({}), false);
    assert.equal(isFreshOverlayClick({ source: 'dashboard', metadata: { requestedFrom: '  ' } }), false);
  });

  it('«Aplicar reemplazo»/«Omitir» solo cuando nadie confirmo y no hay autoaplicar', () => {
    assert.equal(queuedCodeActionNeedsPrompt({ explicitClick: true, confirmedByGuard: false, autoApply: false }), false);
    assert.equal(queuedCodeActionNeedsPrompt({ explicitClick: false, confirmedByGuard: true, autoApply: false }), false);
    assert.equal(queuedCodeActionNeedsPrompt({ explicitClick: false, confirmedByGuard: false, autoApply: true }), false);
    assert.equal(queuedCodeActionNeedsPrompt({ explicitClick: false, confirmedByGuard: false, autoApply: false }), true);
  });

  it('describeWaitTime', () => {
    assert.equal(describeWaitTime(0), 'hace 1 min');
    assert.equal(describeWaitTime(25 * 60_000), 'hace 25 min');
    assert.equal(describeWaitTime(3 * 60 * 60_000), 'hace 3 h');
    assert.equal(describeWaitTime(3 * 24 * 60 * 60_000), 'hace 3 días');
  });
});

describe('destino de un reemplazo del navegador', () => {
  const FILE = 'public class Main {\n  void run() {\n    int i = 0;\n    i++;\n  }\n}\n';
  const check = (overrides: Partial<QueuedTargetCheck>): QueuedTargetCheck => ({
    applyMode: 'replace',
    matchCount: 1,
    matchAtFocus: false,
    anchorMatches: false,
    line: 4,
    fileLabel: 'Main.java',
    ...overrides,
  });

  it('pickTextMatch: cuantas veces aparece y cual usar', () => {
    const once = FILE.indexOf('i++;');
    assert.deepEqual(pickTextMatch(FILE, 'i++;', 0, 0), { index: once, count: 1, atFocus: false });
    assert.deepEqual(pickTextMatch(FILE, 'i++;', once + 2, once + 2), { index: once, count: 1, atFocus: true });
    assert.deepEqual(pickTextMatch(FILE, 'i += 2;', 0, 0), { index: -1, count: 0, atFocus: false });
    assert.deepEqual(pickTextMatch(FILE, '', 0, 0), { index: -1, count: 0, atFocus: false });
    // Varias copias: la que toca el cursor (o la seleccion); si ninguna, la primera.
    const twice = `${FILE}${FILE}`;
    const second = twice.lastIndexOf('i++;');
    assert.deepEqual(pickTextMatch(twice, 'i++;', second + 1, second + 1), { index: second, count: 2, atFocus: true });
    assert.deepEqual(pickTextMatch(twice, 'i++;', second - 4, second + 10), { index: second, count: 2, atFocus: true });
    assert.deepEqual(pickTextMatch(twice, 'i++;', 0, 0), { index: once, count: 2, atFocus: false });
  });

  it('insertAnchorMatches: la linea enfocada sigue donde se insertaria', () => {
    assert.equal(insertAnchorMatches('    i++;', 'i++;'), true);
    assert.equal(insertAnchorMatches('    int i = 0;\n    i++;', '\n    i++;\n'), true);
    assert.equal(insertAnchorMatches('    i += 2;', 'i++;'), false);
    // Fragmento (seleccion o lo visible alrededor del cursor): la linea del cursor esta en el.
    assert.equal(insertAnchorMatches('    i++;', '  void run() {\n    int i = 0;\n    i++;\n  }'), true);
    assert.equal(insertAnchorMatches('    return total;', '  void run() {\n    int i = 0;\n    i++;\n  }'), false);
    assert.equal(insertAnchorMatches('', '  void run() {\n\n    i++;'), true);
    // Linea en blanco enfocada (lo comun al pedir «Insertar debajo»): vale si sigue en blanco.
    assert.equal(insertAnchorMatches('    ', '   \n'), true);
    assert.equal(insertAnchorMatches('', ''), true);
    assert.equal(insertAnchorMatches('    i++;', '   \n'), false);
  });

  it('coincidencia unica confirma; sin coincidencia o con varias, no', () => {
    assert.equal(queuedTargetVerified(check({ matchCount: 1 })), true);
    assert.equal(queuedTargetVerified(check({ matchCount: 0 })), false);
    assert.equal(queuedTargetVerified(check({ matchCount: 2 })), false);
    // Varias copias, pero el cursor esta sobre una: es la que el estudiante tenia enfocada.
    assert.equal(queuedTargetVerified(check({ matchCount: 2, matchAtFocus: true })), true);
    assert.equal(queuedTargetVerified(check({ applyMode: 'delete', matchCount: 1 })), true);
    assert.equal(queuedTargetVerified(check({ applyMode: 'delete', matchCount: 0 })), false);
    assert.equal(queuedTargetVerified(check({ applyMode: 'insert', anchorMatches: true, matchCount: 0 })), true);
    assert.equal(queuedTargetVerified(check({ applyMode: 'insert', anchorMatches: false, matchCount: 1 })), false);
  });

  it('el aviso dice donde caera el cambio si no se pudo comprobar', () => {
    assert.equal(describeQueuedTarget(check({ matchCount: 1 })), '');
    assert.equal(
      describeQueuedTarget(check({ matchCount: 0, line: 14 })),
      'No encontré en Main.java el código que elegiste (cambió o ya no está): se aplicará en la línea 14.',
    );
    assert.equal(
      describeQueuedTarget(check({ matchCount: 2, line: 5 })),
      'El código que elegiste aparece varias veces en Main.java: se aplicará en la primera, línea 5.',
    );
    assert.equal(
      describeQueuedTarget(check({ applyMode: 'insert', anchorMatches: false, line: 9 })),
      'No encontré en Main.java la línea que tenías enfocada: se insertará debajo de la línea 9.',
    );
  });

  it('resumen del aviso: titulo, espera (solo si pasaron mas de 10 min) y destino', () => {
    assert.equal(queuedActionSummary({ label: 'Modificar seleccion', ageMs: 8_000, targetNote: '' }), 'Modificar seleccion.');
    assert.equal(queuedActionSummary({ label: 'Modificar seleccion', ageMs: null, targetNote: '' }), 'Modificar seleccion.');
    assert.equal(
      queuedActionSummary({ label: 'Modificar seleccion', ageMs: 3 * 24 * 60 * 60_000, targetNote: '' }),
      'Modificar seleccion (lo pediste en el navegador hace 3 días).',
    );
    assert.equal(
      queuedActionSummary({ label: 'Modificar seleccion', ageMs: 8_000, targetNote: describeQueuedTarget(check({ matchCount: 0, line: 14 })) }),
      'Modificar seleccion. No encontré en Main.java el código que elegiste (cambió o ya no está): se aplicará en la línea 14.',
    );
  });

  it('clic reciente en el overlay sobre codigo que ya no esta: pregunta con el destino', async () => {
    // Lo que hace applyPendingCodeAction: el clic solo confirma con el destino comprobado.
    const target = check({ matchCount: 0, line: 14 });
    const explicitClick = isFreshOverlayClick({ source: 'browser_extension', requestedAt: '2026-09-25T12:00:00.000Z', claimedAt: '2026-09-25T12:00:08.000Z' });
    assert.equal(explicitClick, true);
    const clickConfirms = explicitClick && queuedTargetVerified(target);
    assert.equal(clickConfirms, false);
    const summary = queuedActionSummary({ label: 'Modificar seleccion', ageMs: 8_000, targetNote: describeQueuedTarget(target) });

    // Con la politica por defecto (requireConfirmation) pregunta el dialogo del docente, con el destino.
    const { deps, confirmations } = harness({ response: { allowed: true, requireConfirmation: true } });
    const verdict = await guardCodeApplication({
      ...INSERT_FOUR_LINES,
      applyMode: 'replace',
      originalText: 'i += 2;',
      newText: 'i += 3;',
      origin: 'browser_code_action',
      explicitClick: clickConfirms,
      confirmDetail: clickConfirms ? '' : summary,
    }, deps);
    assert.equal(confirmations.length, 1);
    assert.match(confirmations[0].detail, /se aplicará en la línea 14/);
    assert.equal(verdict.confirmedBy, 'dialog');

    // Sin requireConfirmation: el aviso «Aplicar reemplazo»/«Omitir» (salvo autoaplicar).
    const relaxed = harness({ response: { allowed: true, requireConfirmation: false } });
    const relaxedVerdict = await guardCodeApplication({ ...INSERT_FOUR_LINES, explicitClick: clickConfirms, confirmDetail: summary }, relaxed.deps);
    assert.equal(relaxed.confirmations.length, 0);
    assert.equal(queuedCodeActionNeedsPrompt({ explicitClick: clickConfirms, confirmedByGuard: relaxedVerdict.confirmed, autoApply: false }), true);
  });
});
