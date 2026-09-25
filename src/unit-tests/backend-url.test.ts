import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  detectEditorHost,
  isAdaceenHealth,
  LOCAL_BACKEND_BASE_URL,
  needsLocalBackendProbe,
  probeLocalBackend,
  PRODUCTION_BACKEND_BASE_URL,
  resolveBackendBaseUrl,
} from '../backend-url';

const HEALTH = { ok: true, mode: 'local', database_provider: 'memory-postgres', queue_configured: false };

function fakeFetch(result: { ok: boolean; body?: unknown } | 'rechazo' | 'cuelga') {
  const calls: string[] = [];
  const impl = (url: string, init: { signal?: AbortSignal }) => {
    calls.push(url);
    if (result === 'rechazo') {
      return Promise.reject(new TypeError('fetch failed: ECONNREFUSED'));
    }
    if (result === 'cuelga') {
      return new Promise<never>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return Promise.resolve({ ok: result.ok, json: async () => result.body });
  };
  return { impl, calls };
}

describe('resolveBackendBaseUrl', () => {
  it('un valor escrito en el ajuste manda sobre todo lo demas', () => {
    assert.deepEqual(
      resolveBackendBaseUrl({ configured: 'https://otro.test/', envUrl: 'https://env.test', codespace: true, localBackendDetected: true }),
      { baseUrl: 'https://otro.test', source: 'setting' },
    );
  });

  it('despues la variable ADACEEN_BACKEND_URL y luego Codespaces', () => {
    assert.equal(resolveBackendBaseUrl({ envUrl: 'https://env.test//', codespace: true, localBackendDetected: true }).baseUrl, 'https://env.test');
    assert.deepEqual(
      resolveBackendBaseUrl({ configured: '  ', codespace: true, localBackendDetected: true }),
      { baseUrl: PRODUCTION_BACKEND_BASE_URL, source: 'codespaces' },
    );
  });

  it('en un equipo: local si el backend local responde y produccion si no', () => {
    assert.deepEqual(resolveBackendBaseUrl({ codespace: false, localBackendDetected: true }), { baseUrl: LOCAL_BACKEND_BASE_URL, source: 'local' });
    assert.deepEqual(resolveBackendBaseUrl({ codespace: false, localBackendDetected: false }), { baseUrl: PRODUCTION_BACKEND_BASE_URL, source: 'production' });
  });

  it('sin probar todavia conserva el comportamiento anterior (local)', () => {
    assert.deepEqual(resolveBackendBaseUrl({ codespace: false, localBackendDetected: null }), { baseUrl: LOCAL_BACKEND_BASE_URL, source: 'local-sin-probar' });
  });

  it('solo se prueba el backend local cuando nadie eligio uno y no es Codespaces', () => {
    assert.equal(needsLocalBackendProbe({ codespace: false }), true);
    assert.equal(needsLocalBackendProbe({ configured: 'http://127.0.0.1:3000', codespace: false }), false);
    assert.equal(needsLocalBackendProbe({ envUrl: 'https://env.test', codespace: false }), false);
    assert.equal(needsLocalBackendProbe({ codespace: true }), false);
  });
});

describe('probeLocalBackend', () => {
  it('reconoce el /health de ADACEEN', async () => {
    const { impl, calls } = fakeFetch({ ok: true, body: HEALTH });
    assert.equal(await probeLocalBackend(impl), true);
    assert.deepEqual(calls, ['http://127.0.0.1:3000/health']);
  });

  it('otra aplicacion en el puerto 3000 no cuenta como backend local', async () => {
    for (const body of [{ ok: true }, { status: 'up' }, '<html>', [HEALTH], null]) {
      assert.equal(await probeLocalBackend(fakeFetch({ ok: true, body }).impl), false, JSON.stringify(body));
    }
    assert.equal(await probeLocalBackend(fakeFetch({ ok: false, body: HEALTH }).impl), false);
  });

  it('nada escuchando o sin respuesta: no hay backend local (y no lanza)', async () => {
    assert.equal(await probeLocalBackend(fakeFetch('rechazo').impl), false);
    // AbortSignal.timeout no mantiene vivo el proceso de prueba; este temporizador si.
    const keepAlive = setTimeout(() => undefined, 5000);
    const startedAt = Date.now();
    assert.equal(await probeLocalBackend(fakeFetch('cuelga').impl, LOCAL_BACKEND_BASE_URL, 50), false);
    assert.ok(Date.now() - startedAt < 2000);
    clearTimeout(keepAlive);
  });

  it('isAdaceenHealth pide ok, mode y database_provider', () => {
    assert.equal(isAdaceenHealth(HEALTH), true);
    assert.equal(isAdaceenHealth({ ok: true, mode: 'queue' }), false);
    assert.equal(isAdaceenHealth({ ok: 'true', mode: 'local', database_provider: 'x' }), false);
  });
});

describe('detectEditorHost', () => {
  it('distingue VS Code instalado, tunel, Codespaces y otros remotos', () => {
    assert.equal(detectEditorHost({ remoteName: undefined, codespace: false }), 'local');
    assert.equal(detectEditorHost({ remoteName: 'tunnel', codespace: false }), 'tunnel');
    assert.equal(detectEditorHost({ remoteName: 'codespaces', codespace: true }), 'codespaces');
    assert.equal(detectEditorHost({ remoteName: 'ssh-remote', codespace: false }), 'remote');
    assert.equal(detectEditorHost({ remoteName: 'wsl', codespace: false }), 'remote');
  });
});
