import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildIdentityHeaders,
  CLIENT_ID_HEADER,
  CLIENT_ID_PATTERN,
  CLIENT_ID_STORAGE_KEY,
  ClientIdStore,
  generateClientId,
  getOrCreateClientId,
  isValidClientId,
  SESSION_ID_HEADER,
} from '../client-identity';

function memoryStore(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const writes: Array<[string, unknown]> = [];
  const store: ClientIdStore = {
    get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    update(key: string, value: unknown) {
      data.set(key, value);
      writes.push([key, value]);
      return Promise.resolve();
    },
  };
  return { store, data, writes };
}

describe('client-identity', () => {
  it('reutiliza el id que ya guardo la vista de quiz, sin reescribirlo', () => {
    const { store, writes } = memoryStore({ [CLIENT_ID_STORAGE_KEY]: 'vscabc123def456ghi789jkl012' });
    assert.equal(getOrCreateClientId(store), 'vscabc123def456ghi789jkl012');
    assert.equal(writes.length, 0);
  });

  it('genera y guarda un id nuevo cuando no hay uno valido', () => {
    const { store, data, writes } = memoryStore({ [CLIENT_ID_STORAGE_KEY]: 'x' });
    const id = getOrCreateClientId(store);
    assert.match(id, /^vsc[a-z0-9]{24}$/);
    assert.match(id, CLIENT_ID_PATTERN);
    assert.equal(data.get(CLIENT_ID_STORAGE_KEY), id);
    assert.deepEqual(writes, [[CLIENT_ID_STORAGE_KEY, id]]);
    // La segunda llamada devuelve el mismo id.
    assert.equal(getOrCreateClientId(store), id);
  });

  it('generateClientId es determinista con un random inyectado', () => {
    assert.equal(generateClientId(() => 0), `vsc${'a'.repeat(24)}`);
  });

  it('valida con el mismo patron que el backend', () => {
    assert.equal(isValidClientId('vscabcdefgh'), true);
    assert.equal(isValidClientId('Abc_def-123'), true);
    assert.equal(isValidClientId('corto'), false);
    assert.equal(isValidClientId('con espacio 123'), false);
    assert.equal(isValidClientId('a'.repeat(81)), false);
    assert.equal(isValidClientId(undefined), false);
  });

  it('arma x-adaceen-client-id siempre y x-session-id solo con sesion', () => {
    assert.deepEqual(buildIdentityHeaders('', 'vscabcdefgh123'), { [CLIENT_ID_HEADER]: 'vscabcdefgh123' });
    assert.deepEqual(buildIdentityHeaders('  sesion-1 ', 'vscabcdefgh123'), {
      [CLIENT_ID_HEADER]: 'vscabcdefgh123',
      [SESSION_ID_HEADER]: 'sesion-1',
    });
    assert.deepEqual(buildIdentityHeaders('sesion-1', 'mal id'), { [SESSION_ID_HEADER]: 'sesion-1' });
  });
});
