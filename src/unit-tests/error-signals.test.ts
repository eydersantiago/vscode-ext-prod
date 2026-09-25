import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  BlockingSignal,
  ErrorSignal,
  ErrorSignalTracker,
  normalizeErrorText,
  summarizeDiagnostics,
} from '../error-signals';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DOC = 'file:///proyecto/Main.java';
const SEMICOLON = { text: "Syntax error, insert ';' to complete BlockStatements", line: 12 };
const UNKNOWN_SYMBOL = { text: 'cannot find symbol: variable total', line: 20 };

function types(signals: ErrorSignal[]) {
  return signals.map((signal) => signal.type);
}

function blocking(signals: ErrorSignal[]) {
  return signals.find((signal): signal is BlockingSignal => signal.type === 'blocking_detected');
}

/** Tracker que ya estaba mirando el archivo (sin errores), para que los errores nuevos sean apariciones. */
function watchingTracker() {
  const tracker = new ErrorSignalTracker();
  tracker.observe(DOC, [], -MINUTE);
  return tracker;
}

/** Error que aparece, se queda estable (sin editar) y desaparece: una aparicion confirmada. */
function appearOnce(tracker: ErrorSignalTracker, at: number, error = SEMICOLON) {
  tracker.observe(DOC, [error], at);
  const confirmed = tracker.observe(DOC, [error], at + 6 * SECOND);
  tracker.observe(DOC, [], at + 7 * SECOND);
  return confirmed;
}

describe('normalizeErrorText', () => {
  it('ignora tildes, mayusculas, numeros y espacios extra', () => {
    assert.equal(normalizeErrorText('  Línea 12:   Falta   el ;  '), 'linea #: falta el ;');
    assert.equal(normalizeErrorText('Linea 14: falta el ;'), normalizeErrorText('LÍNEA 3: falta   el ;'));
    assert.notEqual(normalizeErrorText("Cannot find name 'a'"), normalizeErrorText("Cannot find name 'b'"));
  });

  it('recorta a 300 caracteres', () => {
    assert.equal(normalizeErrorText('x'.repeat(1000)).length, 300);
  });
});

describe('summarizeDiagnostics', () => {
  it('ordena por posicion, pone primero los errores y limita a 10', () => {
    const diagnostics = [
      { message: 'aviso tardio', severity: 'warning' as const, line: 2 },
      { message: 'segundo error', severity: 'error' as const, line: 30 },
      { message: 'informativo', severity: 'information' as const, line: 1 },
      { message: 'pista', severity: 'hint' as const, line: 1 },
      { message: '  primer \n error  ', severity: 'error' as const, line: 5, character: 4 },
      ...Array.from({ length: 12 }, (_, index) => ({ message: `aviso ${index}`, severity: 'warning' as const, line: 40 + index })),
    ];
    const summary = summarizeDiagnostics(diagnostics);
    assert.deepEqual(summary.firstError, { message: 'primer error', line: 5 });
    assert.equal(summary.items.length, 10);
    assert.deepEqual(summary.items.slice(0, 3), [
      { message: 'primer error', severity: 'error', line: 5 },
      { message: 'segundo error', severity: 'error', line: 30 },
      { message: 'aviso tardio', severity: 'warning', line: 2 },
    ]);
    assert.ok(summary.items.every((item) => item.severity === 'error' || item.severity === 'warning'));
    assert.deepEqual(summary.errors.map((item) => item.line), [5, 30]);
  });

  it('recorta los mensajes a 300 caracteres y deja visibleError hasta 2000', () => {
    const long = 'm'.repeat(2500);
    const summary = summarizeDiagnostics([{ message: long, severity: 'error', line: 1 }]);
    assert.equal(summary.items[0].message.length, 300);
    assert.equal(summary.errors[0].text.length, 300);
    assert.equal(summary.firstError?.message.length, 2000);
  });

  it('sin errores no hay firstError', () => {
    const summary = summarizeDiagnostics([{ message: 'solo aviso', severity: 'warning', line: 3 }]);
    assert.equal(summary.firstError, null);
    assert.equal(summary.items.length, 1);
    assert.equal(summary.errors.length, 0);
  });
});

describe('ErrorSignalTracker', () => {
  it('un error de tecleo que desaparece antes de 5 s no emite nada', () => {
    const tracker = new ErrorSignalTracker();
    assert.deepEqual(tracker.observe(DOC, [SEMICOLON], 0), []);
    assert.deepEqual(tracker.observe(DOC, [SEMICOLON], 3 * SECOND), []);
    assert.deepEqual(tracker.observe(DOC, [], 4 * SECOND), []);
  });

  it('un error estable emite compile_error_detected una vez y deduplica 60 s', () => {
    const tracker = new ErrorSignalTracker();
    tracker.observe(DOC, [SEMICOLON], 0);
    const first = tracker.observe(DOC, [SEMICOLON], 5 * SECOND);
    assert.deepEqual(first, [{ type: 'compile_error_detected', key: normalizeErrorText(SEMICOLON.text), text: SEMICOLON.text, line: 12 }]);
    assert.deepEqual(tracker.observe(DOC, [SEMICOLON], 20 * SECOND), []);
    // Se corrige y vuelve dentro de los 60 s: no se repite el evento.
    tracker.observe(DOC, [], 25 * SECOND);
    tracker.observe(DOC, [SEMICOLON], 30 * SECOND);
    assert.deepEqual(types(tracker.observe(DOC, [SEMICOLON], 36 * SECOND)), []);
    // Pasados los 60 s si se vuelve a registrar.
    tracker.observe(DOC, [], 70 * SECOND);
    tracker.observe(DOC, [SEMICOLON], 80 * SECOND);
    assert.deepEqual(types(tracker.observe(DOC, [SEMICOLON], 86 * SECOND)), ['compile_error_detected']);
  });

  it('mientras el estudiante escribe no se confirma el error', () => {
    const tracker = new ErrorSignalTracker();
    tracker.observe(DOC, [SEMICOLON], 0, 0);
    assert.deepEqual(tracker.observe(DOC, [SEMICOLON], 6 * SECOND, 4 * SECOND), []);
    assert.equal(tracker.nextDeadline(6 * SECOND, 4 * SECOND), 9 * SECOND);
    assert.deepEqual(types(tracker.observe(DOC, [SEMICOLON], 9 * SECOND, 4 * SECOND)), ['compile_error_detected']);
  });

  it('solo se reporta el primer error visible del archivo', () => {
    const tracker = new ErrorSignalTracker();
    tracker.observe(DOC, [SEMICOLON, UNKNOWN_SYMBOL], 0);
    const signals = tracker.observe(DOC, [SEMICOLON, UNKNOWN_SYMBOL], 6 * SECOND);
    assert.deepEqual(signals.map((signal) => signal.text), [SEMICOLON.text]);
    // Al corregir el primero, el segundo pasa a ser el visible y se reporta.
    const next = tracker.observe(DOC, [UNKNOWN_SYMBOL], 8 * SECOND);
    assert.deepEqual(next.map((signal) => signal.text), [UNKNOWN_SYMBOL.text]);
  });

  it('el mismo error presente >= 90 s es un bloqueo (una sola vez por episodio)', () => {
    const tracker = new ErrorSignalTracker({ blockingMs: 90 * SECOND });
    tracker.observe(DOC, [SEMICOLON], 0);
    tracker.observe(DOC, [SEMICOLON], 6 * SECOND);
    assert.equal(tracker.nextDeadline(6 * SECOND), 90 * SECOND);
    assert.equal(blocking(tracker.observe(DOC, [SEMICOLON], 89 * SECOND)), undefined);
    const signal = blocking(tracker.observe(DOC, [SEMICOLON], 90 * SECOND));
    assert.ok(signal);
    assert.equal(signal.reason, 'persistent');
    assert.equal(signal.durationMs, 90 * SECOND);
    assert.equal(signal.count, 1);
    assert.equal(signal.line, 12);
    assert.equal(blocking(tracker.observe(DOC, [SEMICOLON], 200 * SECOND)), undefined);
    assert.equal(tracker.nextDeadline(200 * SECOND), null);
  });

  it('respeta blockingSeconds configurado', () => {
    const tracker = new ErrorSignalTracker({ blockingMs: 30 * SECOND });
    tracker.observe(DOC, [SEMICOLON], 0);
    assert.ok(blocking(tracker.observe(DOC, [SEMICOLON], 30 * SECOND)));
  });

  it('el mismo error 3 veces en 10 minutos es un bloqueo por repeticion', () => {
    const tracker = watchingTracker();
    assert.equal(blocking(appearOnce(tracker, 0)), undefined);
    assert.equal(blocking(appearOnce(tracker, 2 * MINUTE)), undefined);
    const signal = blocking(appearOnce(tracker, 4 * MINUTE));
    assert.ok(signal);
    assert.equal(signal.reason, 'repeated');
    assert.equal(signal.count, 3);
    assert.equal(signal.durationMs, 6 * SECOND);
  });

  it('las apariciones de hace mas de 10 minutos no cuentan', () => {
    const tracker = watchingTracker();
    appearOnce(tracker, 0);
    appearOnce(tracker, 6 * MINUTE);
    assert.equal(blocking(appearOnce(tracker, 11 * MINUTE)), undefined);
  });

  it('cambiar de archivo y volver no cuenta como repetir el error', () => {
    const tracker = new ErrorSignalTracker();
    const other = 'file:///proyecto/Otro.java';
    for (let round = 0; round < 4; round += 1) {
      const at = round * MINUTE;
      tracker.observe(DOC, [SEMICOLON], at);
      const signals = tracker.observe(DOC, [SEMICOLON], at + 10 * SECOND);
      assert.equal(blocking(signals), undefined);
      tracker.observe(other, [], at + 20 * SECOND);
    }
  });

  it('tras un bloqueo, el mismo error no vuelve a bloquear durante el enfriamiento', () => {
    const tracker = new ErrorSignalTracker({ blockingMs: 90 * SECOND, blockingCooldownMs: 5 * MINUTE });
    tracker.observe(DOC, [SEMICOLON], 0);
    assert.ok(blocking(tracker.observe(DOC, [SEMICOLON], 90 * SECOND)));
    tracker.observe(DOC, [], 100 * SECOND);
    tracker.observe(DOC, [SEMICOLON], 110 * SECOND);
    assert.equal(blocking(tracker.observe(DOC, [SEMICOLON], 200 * SECOND)), undefined);
    assert.equal(tracker.nextDeadline(200 * SECOND), 390 * SECOND);
    assert.ok(blocking(tracker.observe(DOC, [SEMICOLON], 390 * SECOND)));
  });

  it('cuando desaparece el error de un bloqueo emite blocking_resolved con la duracion del episodio', () => {
    const tracker = new ErrorSignalTracker({ blockingMs: 90 * SECOND });
    tracker.observe(DOC, [SEMICOLON], 0);
    assert.ok(blocking(tracker.observe(DOC, [SEMICOLON], 90 * SECOND)));
    assert.equal(tracker.openEpisodeCount(), 1);
    const signals = tracker.observe(DOC, [], 150 * SECOND);
    assert.deepEqual(signals, [{
      type: 'blocking_resolved',
      key: normalizeErrorText(SEMICOLON.text),
      text: SEMICOLON.text,
      line: 12,
      durationMs: 150 * SECOND,
      blockedForMs: 60 * SECOND,
      resolvedWhileAway: false,
    }]);
    assert.equal(tracker.openEpisodeCount(), 0);
    // Se cierra una sola vez.
    assert.deepEqual(tracker.observe(DOC, [], 200 * SECOND), []);
  });

  it('un error que desaparece sin haber bloqueado no emite blocking_resolved', () => {
    const tracker = new ErrorSignalTracker();
    tracker.observe(DOC, [SEMICOLON], 0);
    tracker.observe(DOC, [SEMICOLON], 6 * SECOND);
    assert.deepEqual(types(tracker.observe(DOC, [], 30 * SECOND)), []);
  });

  it('un bloqueo sigue abierto al cambiar de archivo y se cierra al corregirlo despues de volver', () => {
    const tracker = new ErrorSignalTracker({ blockingMs: 90 * SECOND });
    const other = 'file:///proyecto/Otro.java';
    tracker.observe(DOC, [SEMICOLON], 0);
    assert.ok(blocking(tracker.observe(DOC, [SEMICOLON], 90 * SECOND)));
    tracker.observe(other, [], 100 * SECOND);
    // Vuelve y el error sigue: mismo episodio, sin compile_error ni bloqueo nuevo.
    assert.deepEqual(tracker.observe(DOC, [SEMICOLON], 200 * SECOND), []);
    assert.deepEqual(tracker.observe(DOC, [SEMICOLON], 600 * SECOND), []);
    const [resolved] = tracker.observe(DOC, [], 620 * SECOND);
    assert.equal(resolved.type, 'blocking_resolved');
    if (resolved.type === 'blocking_resolved') {
      assert.equal(resolved.durationMs, 620 * SECOND);
      assert.equal(resolved.blockedForMs, 530 * SECOND);
      assert.equal(resolved.resolvedWhileAway, false);
    }
  });

  it('si el error se corrigio desde otro archivo, se cierra al volver con resolvedWhileAway', () => {
    const tracker = new ErrorSignalTracker({ blockingMs: 90 * SECOND });
    const other = 'file:///proyecto/Otro.java';
    tracker.observe(DOC, [SEMICOLON], 0);
    assert.ok(blocking(tracker.observe(DOC, [SEMICOLON], 90 * SECOND)));
    tracker.observe(other, [], 100 * SECOND);
    // Al volver los diagnosticos pueden llegar vacios un instante: no se cierra todavia.
    assert.deepEqual(tracker.observe(DOC, [], 300 * SECOND), []);
    assert.equal(tracker.nextDeadline(300 * SECOND), 305 * SECOND);
    const [resolved] = tracker.observe(DOC, [], 305 * SECOND);
    assert.equal(resolved.type, 'blocking_resolved');
    if (resolved.type === 'blocking_resolved') {
      assert.equal(resolved.resolvedWhileAway, true);
      // Cota superior: hasta que volvio al archivo.
      assert.equal(resolved.durationMs, 300 * SECOND);
      assert.equal(resolved.blockedForMs, 210 * SECOND);
    }
    assert.equal(tracker.openEpisodeCount(), 0);
  });

  it('si al volver los diagnosticos llegan tarde, el episodio sigue abierto', () => {
    const tracker = new ErrorSignalTracker({ blockingMs: 90 * SECOND });
    const other = 'file:///proyecto/Otro.java';
    tracker.observe(DOC, [SEMICOLON], 0);
    assert.ok(blocking(tracker.observe(DOC, [SEMICOLON], 90 * SECOND)));
    tracker.observe(other, [], 100 * SECOND);
    assert.deepEqual(tracker.observe(DOC, [], 300 * SECOND), []);
    // Llegan los diagnosticos con el mismo error: no es un error nuevo.
    assert.deepEqual(tracker.observe(DOC, [SEMICOLON], 302 * SECOND), []);
    assert.deepEqual(tracker.observe(DOC, [SEMICOLON], 320 * SECOND), []);
    assert.equal(tracker.openEpisodeCount(), 1);
    const [resolved] = tracker.observe(DOC, [], 400 * SECOND);
    assert.equal(resolved.type === 'blocking_resolved' && resolved.resolvedWhileAway, false);
  });

  it('isPresent sigue la presencia del error normalizado', () => {
    const tracker = new ErrorSignalTracker();
    tracker.observe(DOC, [SEMICOLON], 0);
    assert.equal(tracker.isPresent(normalizeErrorText(SEMICOLON.text)), true);
    tracker.observe(DOC, [], SECOND);
    assert.equal(tracker.isPresent(normalizeErrorText(SEMICOLON.text)), false);
  });
});
