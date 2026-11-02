// Pruebas de EditorSessionManager (editor-session.ts) con dependencias falsas.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseStoredEditorSession, serializeStoredEditorSession } from '../editor-session-records';
import { NOW, BACKEND, SESSION_A, SESSION_B, SESSION_C, GITHUB_TOKEN, fileText, record, harness, claimOk, assertNoSecretsInLogs } from './editor-session-fixtures';

describe('EditorSessionManager', () => {
  it('al arrancar usa SecretStorage antes que el archivo del tunel', async () => {
    const h = harness({ secret: serializeStoredEditorSession(record(), NOW), file: fileText() });
    await h.manager.initialize();
    assert.equal(h.manager.currentSessionId(), SESSION_A);
    assert.equal(h.manager.current()?.source, 'secret');
    assert.deepEqual(h.changes, [{ id: SESSION_A, idChanged: true }]);
  });

  it('sin SecretStorage usa el archivo; un registro vencido se borra', async () => {
    const vencido = serializeStoredEditorSession(record({ expiresAt: NOW - 1000 }), NOW);
    const h = harness({ secret: vencido, file: fileText() });
    await h.manager.initialize();
    assert.equal(h.manager.current()?.source, 'file');
    assert.equal(h.manager.currentSessionId(), SESSION_B);
    assert.equal(h.deletes, 1);
  });

  it('invalida en SecretStorage: la olvida y sigue con el archivo, sin GitHub ni aviso', async () => {
    const h = harness({ secret: serializeStoredEditorSession(record(), NOW), file: fileText(), githubToken: GITHUB_TOKEN });
    await h.manager.initialize();
    h.manager.reportInvalid(SESSION_A);
    h.manager.reportInvalid(SESSION_A);
    await h.manager.whenIdle();
    assert.equal(h.manager.currentSessionId(), SESSION_B);
    assert.equal(h.state.secret, undefined);
    assert.equal(h.deletes, 1);
    assert.deepEqual(h.tokenModes, []);
    assert.equal(h.lost, 0);
    assertNoSecretsInLogs(h);
  });

  it('invalida y sin archivo: NO vuelve a conectar con GitHub en silencio, marca el equipo y avisa', async () => {
    // Mac compartida: VS Code tiene el permiso de GitHub de otro estudiante (A)
    // y B cerro sesion en el navegador. No se vuelve a vincular solo a A.
    const h = harness({
      secret: serializeStoredEditorSession(record({ label: 'vscode-local' }), NOW),
      githubToken: GITHUB_TOKEN,
      githubClaim: claimOk(SESSION_C, 'github'),
    });
    await h.manager.initialize();
    h.manager.reportInvalid(SESSION_A);
    await h.manager.whenIdle();
    assert.deepEqual(h.tokenModes, []);
    assert.deepEqual(h.claims, []);
    assert.equal(h.manager.current(), null);
    assert.equal(h.state.secret, undefined);
    assert.equal(h.state.unlinked, true);
    assert.equal(h.lost, 1);
    assertNoSecretsInLogs(h);
  });

  it('si nada funciona avisa una sola vez por ventana', async () => {
    const h = harness({ file: fileText(), setting: 'ajuste-123456' });
    await h.manager.initialize();
    assert.equal(h.manager.current()?.source, 'file');
    h.manager.reportInvalid(SESSION_B);
    await h.manager.whenIdle();
    // Cae al ajuste heredado: todavia hay sesion, no se avisa.
    assert.equal(h.manager.current()?.source, 'setting');
    assert.equal(h.lost, 0);
    h.manager.reportInvalid('ajuste-123456');
    await h.manager.whenIdle();
    assert.equal(h.manager.current(), null);
    assert.equal(h.lost, 1);
    // Otra sesion heredada nueva que tambien falla: no se repite el aviso.
    h.state.setting = 'ajuste-nuevo-7890';
    h.manager.reportInvalid('ajuste-nuevo-7890');
    await h.manager.whenIdle();
    assert.equal(h.lost, 1);
    assertNoSecretsInLogs(h);
  });

  it('un rechazo de otra sesion (no la actual) no dispara la recuperacion', async () => {
    const h = harness({ secret: serializeStoredEditorSession(record(), NOW) });
    await h.manager.initialize();
    h.manager.reportInvalid(SESSION_C);
    h.manager.reportInvalid('');
    await h.manager.whenIdle();
    assert.equal(h.manager.currentSessionId(), SESSION_A);
    assert.equal(h.deletes, 0);
    assert.equal(h.lost, 0);
  });

  it('una sesion emparejada en otro backend no se manda, ni se olvida ni avisa', async () => {
    // Mac con el backend local encendido: la sesion de produccion no va a 127.0.0.1.
    const h = harness({
      secret: serializeStoredEditorSession(record({ backendUrl: BACKEND }), NOW),
      backendUrl: 'http://127.0.0.1:3000',
    });
    await h.manager.initialize();
    assert.equal(h.manager.current(), null);
    assert.equal(h.manager.currentSessionId(), '');
    assert.equal(h.deletes, 0);
    assert.equal(h.lost, 0);
    // Se apaga el backend local: vuelve a valer sin reiniciar VS Code.
    h.state.backendUrl = `${BACKEND}/`;
    h.manager.refresh();
    assert.equal(h.manager.currentSessionId(), SESSION_A);
    assert.deepEqual(h.changes.map((change) => change.id), ['', SESSION_A]);
    // Un rechazo de ese backend si la olvida (y la borra: es el suyo).
    h.manager.reportInvalid(SESSION_A);
    await h.manager.whenIdle();
    assert.equal(h.deletes, 1);
    assert.equal(h.lost, 1);
  });

  it('el tunel escribe una sesion nueva despues del rechazo: se usa', async () => {
    const h = harness({ file: fileText() });
    await h.manager.initialize();
    h.manager.reportInvalid(SESSION_B);
    await h.manager.whenIdle();
    assert.equal(h.manager.current(), null);
    h.state.file = fileText({ sessionId: SESSION_C });
    assert.equal(await h.manager.reloadFile(), true);
    assert.equal(h.manager.currentSessionId(), SESSION_C);
    assert.equal(await h.manager.reloadFile(), false);
  });

  it('arranque sin sesion: GitHub en silencio (nunca interactivo)', async () => {
    const h = harness({ githubToken: GITHUB_TOKEN, githubClaim: claimOk(SESSION_C, 'github') });
    await h.manager.initialize();
    await h.manager.startup();
    assert.deepEqual(h.tokenModes, ['silent']);
    assert.equal(h.manager.current()?.label, 'github');
  });

  it('arranque sin sesion ni cuenta de GitHub: queda sin conectar y no avisa', async () => {
    const h = harness({ githubToken: null });
    await h.manager.initialize();
    await h.manager.startup();
    assert.deepEqual(h.claims, []);
    assert.equal(h.manager.current(), null);
    assert.equal(h.lost, 0);
  });

  it('arranque con sesion heredada: /api/auth/me da el nombre o la descubre muerta', async () => {
    const ok = harness({ setting: 'ajuste-123456', check: { status: 'ok', userName: 'Ana', userEmail: 'a@x.co' } });
    await ok.manager.initialize();
    await ok.manager.startup();
    assert.deepEqual(ok.checks, ['ajuste-123456']);
    assert.equal(ok.manager.current()?.userName, 'Ana');

    // Muerta al arrancar (p. ej. el anterior cerro sesion con VS Code cerrado):
    // se avisa y no se prueba GitHub en silencio.
    const dead = harness({ setting: 'ajuste-123456', check: { status: 'invalid' }, githubToken: GITHUB_TOKEN });
    await dead.manager.initialize();
    await dead.manager.startup();
    assert.equal(dead.manager.current(), null);
    assert.deepEqual(dead.tokenModes, []);
    assert.equal(dead.lost, 1);
    assert.equal(dead.state.unlinked, true);
  });

  it('tras un rechazo, el siguiente arranque no usa GitHub en silencio hasta una conexion a mano', async () => {
    const options = { githubToken: GITHUB_TOKEN, githubClaim: claimOk(SESSION_C, 'github'), codeClaim: claimOk(SESSION_B, 'vscode-local') };
    const first = harness({ ...options, secret: serializeStoredEditorSession(record(), NOW) });
    await first.manager.initialize();
    first.manager.reportInvalid(SESSION_A);
    await first.manager.whenIdle();
    assert.equal(first.state.unlinked, true);

    // Otro dia (otra ventana, mismo globalState): sin sesion y con la marca.
    const next = harness({ ...options, unlinked: true });
    await next.manager.initialize();
    await next.manager.startup();
    assert.deepEqual(next.tokenModes, []);
    assert.equal(next.manager.current(), null);
    assert.equal(next.lost, 0);
    // El boton del navegador (conexion a mano) quita la marca.
    assert.ok((await next.manager.connectWithCode('K7P4-M2QX', 'vscode-local')).ok);
    assert.equal(next.state.unlinked, false);

    // Y el arranque siguiente, sin sesion ni marca, vuelve a probar GitHub en silencio.
    const later = harness({ ...options, unlinked: next.state.unlinked });
    await later.manager.initialize();
    await later.manager.startup();
    assert.deepEqual(later.tokenModes, ['silent']);
    assert.equal(later.manager.currentSessionId(), SESSION_C);
    // Silencioso no quita ni pone la marca.
    assert.equal(later.state.unlinked, false);
  });

  it('codigo: normaliza, manda editorHost y label, y guarda en SecretStorage', async () => {
    const h = harness({ codeClaim: claimOk(SESSION_C, 'vscode-local') });
    await h.manager.initialize();
    const outcome = await h.manager.connectWithCode('k7p4 m2qx', 'vscode-local');
    assert.ok(outcome.ok);
    assert.deepEqual(h.claims, [{ kind: 'code', body: { code: 'K7P4-M2QX', editorHost: 'local', label: 'vscode-local' }, label: 'vscode-local' }]);
    const stored = parseStoredEditorSession(h.state.secret || '', NOW);
    assert.ok(stored.ok);
    assert.equal(stored.session.sessionId, SESSION_C);
    assert.equal((await h.manager.connectWithCode('K7P4')).ok, false);
    assert.equal(h.claims.length, 1);
    assertNoSecretsInLogs(h);
  });

  it('una conexion a mano vuelve a habilitar el aviso', async () => {
    const h = harness({ setting: 'ajuste-123456', codeClaim: claimOk(SESSION_C, 'codigo') });
    await h.manager.initialize();
    h.manager.reportInvalid('ajuste-123456');
    await h.manager.whenIdle();
    assert.equal(h.lost, 1);
    await h.manager.connectWithCode('K7P4-M2QX');
    h.manager.reportInvalid(SESSION_C);
    await h.manager.whenIdle();
    assert.equal(h.lost, 2);
  });

  it('sesion pegada: no se guarda si el backend dice que ya no vale', async () => {
    const dead = harness({ check: { status: 'invalid' } });
    await dead.manager.initialize();
    const outcome = await dead.manager.connectWithSessionId(SESSION_A);
    assert.equal(!outcome.ok && outcome.error, 'invalid_session');
    assert.equal(dead.state.secret, undefined);

    const alive = harness({ check: { status: 'ok', userName: 'Ana', userEmail: 'a@x.co' } });
    await alive.manager.initialize();
    const saved = await alive.manager.connectWithSessionId(SESSION_A);
    assert.ok(saved.ok);
    assert.equal(saved.session.label, 'manual');
    assert.equal(saved.session.userName, 'Ana');
    assert.equal(alive.manager.currentSessionId(), SESSION_A);
  });

  it('sin llavero la sesion vale en memoria durante la ventana', async () => {
    const h = harness({ failStore: true, codeClaim: claimOk(SESSION_C, 'codigo') });
    await h.manager.initialize();
    const outcome = await h.manager.connectWithCode('K7P4-M2QX');
    assert.ok(outcome.ok);
    assert.equal(h.manager.currentSessionId(), SESSION_C);
    assert.ok(h.logs.some((line) => /llavero/.test(line)));
  });
});
