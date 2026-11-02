// Pruebas de editor-session-claim.ts: canje de la sesion en el backend.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { EditorSessionLabel } from '../editor-session-records';
import { interpretClaimResponse, interpretSessionCheck, requestEditorClaim } from '../editor-session-claim';
import { BACKEND, SESSION_A, SESSION_C, GITHUB_TOKEN } from './editor-session-fixtures';

describe('canje en el backend', () => {
  const context = { backendUrl: BACKEND, label: 'codigo' as EditorSessionLabel };

  it('200 guarda sesion, vencimiento y usuario', () => {
    const result = interpretClaimResponse(200, {
      ok: true,
      sessionId: SESSION_C,
      expiresAt: '2026-10-25T12:00:00.000Z',
      user: { id: 'u1', role: 'student', email: 'ana@correounivalle.edu.co', displayName: 'Ana' },
      githubLogin: 'ana-gh',
    }, context);
    assert.ok(result.ok);
    assert.equal(result.githubLogin, 'ana-gh');
    assert.deepEqual(result.session, {
      sessionId: SESSION_C,
      backendUrl: BACKEND,
      expiresAt: Date.parse('2026-10-25T12:00:00.000Z'),
      userName: 'Ana',
      userEmail: 'ana@correounivalle.edu.co',
      label: 'codigo',
    });
  });

  it('traduce los errores del contrato', () => {
    const cases: Array<[number, unknown, string]> = [
      [400, { ok: false, error: 'invalid_code' }, 'invalid_code'],
      [404, { ok: false, error: 'code_not_found' }, 'code_not_found'],
      [429, { ok: false, error: 'too_many_attempts' }, 'too_many_attempts'],
      [429, {}, 'too_many_attempts'],
      [401, { ok: false, error: 'github_token_invalid' }, 'github_token_invalid'],
      [404, {}, 'backend_outdated'],
      [500, { ok: false, error: 'boom' }, 'backend_error'],
      [200, { ok: true }, 'backend_error'],
    ];
    for (const [status, body, error] of cases) {
      const result = interpretClaimResponse(status, body, context);
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.error, error, `${status} ${JSON.stringify(body)}`);
    }
    const notLinked = interpretClaimResponse(404, {
      ok: false,
      error: 'github_login_not_linked',
      message: 'Conecta tu cuenta de GitHub en ADACEEN (overlay del navegador) y vuelve a intentar.',
    }, context);
    assert.ok(!notLinked.ok);
    assert.match(notLinked.message, /overlay del navegador/);
  });

  it('requestEditorClaim hace POST sin sesion y nunca lanza', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchOk = async (url: string, init: { headers: Record<string, string>; body?: string }) => {
      calls.push({ url, headers: init.headers, body: init.body || '' });
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, sessionId: SESSION_C, user: {} }) };
    };
    const result = await requestEditorClaim(fetchOk, {
      kind: 'github',
      baseUrl: `${BACKEND}/`,
      body: { githubToken: GITHUB_TOKEN, editorHost: 'local' },
      headers: { 'x-adaceen-client-id': 'vscabcdefgh123' },
      label: 'github',
    });
    assert.ok(result.ok);
    assert.equal(calls[0].url, `${BACKEND}/api/auth/editor/github`);
    assert.equal(calls[0].headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal('x-session-id' in calls[0].headers, false);
    assert.deepEqual(JSON.parse(calls[0].body), { githubToken: GITHUB_TOKEN, editorHost: 'local' });
    // El token no queda en lo que se devuelve (y de ahi a SecretStorage).
    assert.doesNotMatch(JSON.stringify(result), /TOKENSECRETO/);

    const failing = async () => {
      throw new TypeError('fetch failed');
    };
    const down = await requestEditorClaim(failing, { kind: 'code', baseUrl: BACKEND, body: {}, label: 'codigo' });
    assert.equal(!down.ok && down.error, 'network');
  });

  it('/api/auth/me: nombre, sesion invalida o sin respuesta', () => {
    assert.deepEqual(
      interpretSessionCheck(200, { ok: true, session: { id: SESSION_A, user: { displayName: 'Ana', email: 'a@x.co' } } }),
      { status: 'ok', userName: 'Ana', userEmail: 'a@x.co' },
    );
    assert.deepEqual(interpretSessionCheck(401, { ok: false }), { status: 'invalid' });
    assert.deepEqual(interpretSessionCheck(200, { ok: true }, 'invalid'), { status: 'invalid' });
    assert.deepEqual(interpretSessionCheck(500, {}), { status: 'unknown' });
    assert.deepEqual(interpretSessionCheck(0, {}), { status: 'unknown' });
  });
});
