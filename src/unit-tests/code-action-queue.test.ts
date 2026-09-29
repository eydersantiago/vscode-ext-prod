import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  confirmAppliedCodeAction,
  PROMPT_TIMED_OUT,
  promptWithTimeout,
  replacementAlreadyApplied,
} from '../code-action-queue';

// A12.12 · ADACEEN-155, riesgo 2: la cola de reemplazos no se para con un aviso ignorado y un
// cambio aplicado nunca queda como fallido.

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe('code-action-queue: aviso con tiempo limite', () => {
  it('devuelve la respuesta si llega a tiempo', async () => {
    assert.equal(await promptWithTimeout(Promise.resolve('Aplicar reemplazo'), 1000), 'Aplicar reemplazo');
  });

  it('se da por no respondido si nadie contesta', async () => {
    const never = new Promise<string>(() => {});
    assert.equal(await promptWithTimeout(never, 10), PROMPT_TIMED_OUT);
  });
});

describe('code-action-queue: confirmar un cambio ya aplicado', () => {
  const noSleep = async () => {};

  it('confirma al primer intento', async () => {
    let calls = 0;
    const result = await confirmAppliedCodeAction(async () => { calls += 1; }, { sleep: noSleep });
    assert.deepEqual(result, { outcome: 'completed', attempts: 1 });
    assert.equal(calls, 1);
  });

  it('reintenta ante un fallo pasajero', async () => {
    let calls = 0;
    const waits: number[] = [];
    const result = await confirmAppliedCodeAction(async () => {
      calls += 1;
      if (calls < 3) {
        throw httpError(502);
      }
    }, { sleep: async (ms) => { waits.push(ms); } });
    assert.equal(result.outcome, 'completed');
    assert.equal(result.attempts, 3);
    assert.deepEqual(waits, [1000, 3000]);
  });

  it('un 404 es que ya estaba cerrado, no un fallo', async () => {
    const result = await confirmAppliedCodeAction(async () => { throw httpError(404); }, { sleep: noSleep });
    assert.deepEqual(result, { outcome: 'already_closed', attempts: 1 });
  });

  it('si no se puede confirmar, queda sin confirmar (nunca «fallido»)', async () => {
    const result = await confirmAppliedCodeAction(async () => { throw new Error('red caida'); }, { sleep: noSleep });
    assert.equal(result.outcome, 'unconfirmed');
    assert.equal(result.attempts, 3);
    assert.match(String(result.lastError), /red caida/);
  });
});

describe('code-action-queue: no aplicar dos veces un cambio que volvio a la cola', () => {
  const base = {
    documentText: 'int main() {\n  int x = 1;\n}\n',
    originalText: 'int x = 0;',
    replacementText: 'int x = 1;',
    applyMode: 'replace' as const,
  };

  it('en el segundo reclamo, si el archivo ya tiene el cambio, no se vuelve a aplicar', () => {
    assert.equal(replacementAlreadyApplied({ ...base, attempts: 2 }), true);
  });

  it('en el primer reclamo siempre se aplica (el texto nuevo podria existir por otra razon)', () => {
    assert.equal(replacementAlreadyApplied({ ...base, attempts: 1 }), false);
  });

  it('si el original sigue en el archivo, no esta aplicado', () => {
    assert.equal(replacementAlreadyApplied({ ...base, documentText: 'int x = 0;\nint x = 1;\n', attempts: 2 }), false);
  });

  it('inserciones, borrados y reemplazos que contienen al original no se deciden por texto', () => {
    assert.equal(replacementAlreadyApplied({ ...base, applyMode: 'insert', attempts: 2 }), false);
    assert.equal(replacementAlreadyApplied({ ...base, applyMode: 'delete', attempts: 2 }), false);
    assert.equal(replacementAlreadyApplied({
      ...base,
      originalText: 'x = 0;',
      replacementText: 'int x = 0; // x = 0;',
      documentText: 'int x = 0; // x = 0;',
      attempts: 2,
    }), false);
  });
});
