// Pruebas de EditorSessionManager: carreras entre canjes y casos de las revisiones.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseStoredEditorSession, serializeStoredEditorSession } from '../editor-session-records';
import { NOW, SESSION_A, SESSION_B, SESSION_C, GITHUB_TOKEN, fileText, record, sleep, harness, claimOk, assertNoSecretsInLogs } from './editor-session-fixtures';

describe('EditorSessionManager: carreras y casos de revision', () => {
  it('el canje silencioso con GitHub no pisa el codigo del enlace que termino antes', async () => {
    // Mac compartida, VS Code arranca por el enlace de B: startup() prueba GitHub
    // en silencio (permiso de A) a la vez que se canjea el codigo de B.
    const h = harness({
      githubToken: GITHUB_TOKEN,
      githubClaim: { ok: true, githubLogin: 'a-gh', session: record({ sessionId: SESSION_A, label: 'github', userName: 'Estudiante A', userEmail: 'a@x.co' }) },
      codeClaim: { ok: true, githubLogin: '', session: record({ sessionId: SESSION_C, label: 'vscode-local', userName: 'Estudiante B', userEmail: 'b@x.co' }) },
      claimDelayMs: { github: 40, code: 5 },
    });
    await h.manager.initialize();
    const startup = h.manager.startup();
    const link = await h.manager.connectWithCode('K7P4-M2QX', 'vscode-local');
    assert.ok(link.ok);
    assert.equal(link.session.userName, 'Estudiante B');
    await startup;
    assert.equal(h.manager.currentSessionId(), SESSION_C);
    assert.equal(h.manager.current()?.userName, 'Estudiante B');
    const stored = parseStoredEditorSession(h.state.secret || '', NOW);
    assert.ok(stored.ok);
    assert.equal(stored.session.sessionId, SESSION_C);
    assert.ok(h.logs.some((line) => /Se descarta el canje silencioso/.test(line)));
    assertNoSecretsInLogs(h);
  });

  it('el canje silencioso se descarta si mientras tanto aparece el archivo del tunel', async () => {
    const h = harness({
      githubToken: GITHUB_TOKEN,
      githubClaim: claimOk(SESSION_C, 'github'),
      claimDelayMs: { github: 30 },
    });
    await h.manager.initialize();
    const startup = h.manager.startup();
    h.state.file = fileText();
    await h.manager.reloadFile();
    await startup;
    assert.equal(h.manager.current()?.source, 'file');
    assert.equal(h.state.secret, undefined);
  });

  it('sin permiso para el backend del espacio de trabajo no pide el token de GitHub', async () => {
    const h = harness({ githubToken: GITHUB_TOKEN, githubClaim: claimOk(SESSION_C, 'github'), silentGithubAllowed: false });
    await h.manager.initialize();
    await h.manager.startup();
    assert.deepEqual(h.tokenModes, []);
    assert.deepEqual(h.claims, []);
    assert.equal(h.manager.current(), null);
    // A mano si (el estudiante elige la opcion).
    assert.ok((await h.manager.connectWithGithub('interactive')).ok);
  });

  it('una sesion que vence con la ventana abierta se deja de mostrar y avisa una vez', async () => {
    const h = harness({ secret: serializeStoredEditorSession(record({ expiresAt: NOW + 60_000 }), NOW) });
    await h.manager.initialize();
    assert.equal(h.manager.currentSessionId(), SESSION_A);
    await h.manager.poll();
    assert.equal(h.lost, 0);
    h.state.now = NOW + 61_000;
    await h.manager.poll();
    assert.equal(h.manager.current(), null);
    assert.deepEqual(h.changes.map((change) => change.id), [SESSION_A, '']);
    assert.equal(h.lost, 1);
    await h.manager.poll();
    assert.equal(h.lost, 1);
    // Vencer no es cerrar sesion: no pone la marca.
    assert.equal(h.state.unlinked, false);
  });

  it('si vence y queda el archivo del tunel, cambia a el sin avisar', async () => {
    const h = harness({
      secret: serializeStoredEditorSession(record({ expiresAt: NOW + 60_000 }), NOW),
      file: fileText(),
    });
    await h.manager.initialize();
    h.state.now = NOW + 61_000;
    await h.manager.poll();
    assert.equal(h.manager.currentSessionId(), SESSION_B);
    assert.equal(h.lost, 0);
  });

  it('llavero lento: la sesion guardada se aplica cuando contesta y el arranque la espera', async () => {
    const h = harness({
      secret: serializeStoredEditorSession(record(), NOW),
      secretDelayMs: 40,
      secretReadTimeoutMs: 5,
      githubToken: GITHUB_TOKEN,
      githubClaim: claimOk(SESSION_C, 'github'),
    });
    await h.manager.initialize();
    assert.equal(h.manager.current(), null);
    await h.manager.startup();
    // No conecto GitHub encima: espero al llavero y uso la sesion guardada.
    assert.deepEqual(h.tokenModes, []);
    assert.equal(h.manager.currentSessionId(), SESSION_A);
    assert.equal(h.changes.at(-1)?.id, SESSION_A);
  });

  it('llavero lento: una conexion hecha mientras tanto no la pisa la lectura tardia', async () => {
    const h = harness({
      secret: serializeStoredEditorSession(record(), NOW),
      secretDelayMs: 40,
      secretReadTimeoutMs: 5,
      codeClaim: claimOk(SESSION_C, 'codigo'),
    });
    await h.manager.initialize();
    assert.ok((await h.manager.connectWithCode('K7P4-M2QX')).ok);
    await sleep(60);
    assert.equal(h.manager.currentSessionId(), SESSION_C);
  });

  it('tunel: un archivo escrito despues de guardar la sesion emparejada gana; fuera del tunel no', async () => {
    const savedAt = NOW - 60 * 60_000;
    const secret = serializeStoredEditorSession(record({ userName: 'Otro perfil' }), savedAt);
    const newerFile = fileText({ writtenAt: new Date(NOW - 60_000).toISOString() });
    const olderFile = fileText({ writtenAt: new Date(savedAt - 60_000).toISOString() });

    const tunnel = harness({ editorHost: 'tunnel', secret, file: newerFile });
    await tunnel.manager.initialize();
    assert.equal(tunnel.manager.current()?.source, 'file');
    assert.equal(tunnel.manager.currentSessionId(), SESSION_B);

    const older = harness({ editorHost: 'tunnel', secret, file: olderFile });
    await older.manager.initialize();
    assert.equal(older.manager.current()?.source, 'secret');

    const local = harness({ editorHost: 'local', secret, file: newerFile });
    await local.manager.initialize();
    assert.equal(local.manager.current()?.source, 'secret');

    // Sin writtenAt (agente anterior) manda el orden del contrato.
    const unknown = harness({ editorHost: 'tunnel', secret, file: fileText({ writtenAt: undefined }) });
    await unknown.manager.initialize();
    assert.equal(unknown.manager.current()?.source, 'secret');

    // Una conexion a mano en el tunel gana al archivo anterior.
    const manual = harness({ editorHost: 'tunnel', file: newerFile, codeClaim: claimOk(SESSION_C, 'codigo') });
    await manual.manager.initialize();
    assert.ok((await manual.manager.connectWithCode('K7P4-M2QX')).ok);
    assert.equal(manual.manager.currentSessionId(), SESSION_C);
  });

  it('Desconectar: borra la sesion guardada, marca el equipo y no vuelve con GitHub en silencio', async () => {
    const h = harness({
      secret: serializeStoredEditorSession(record(), NOW),
      githubToken: GITHUB_TOKEN,
      githubClaim: claimOk(SESSION_C, 'github'),
    });
    await h.manager.initialize();
    assert.equal(await h.manager.disconnect(), null);
    assert.equal(h.state.secret, undefined);
    assert.equal(h.deletes, 1);
    assert.equal(h.state.unlinked, true);
    assert.equal(h.changes.at(-1)?.id, '');
    await h.manager.startup();
    assert.deepEqual(h.tokenModes, []);
    assert.equal(h.lost, 0);
    assertNoSecretsInLogs(h);
  });

  it('Desconectar deja la sesion del tunel (no es del llavero)', async () => {
    const h = harness({ secret: serializeStoredEditorSession(record(), NOW), file: fileText() });
    await h.manager.initialize();
    const remaining = await h.manager.disconnect();
    assert.equal(remaining?.source, 'file');
    assert.equal(h.manager.currentSessionId(), SESSION_B);
  });
});
