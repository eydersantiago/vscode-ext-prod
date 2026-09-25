import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  classifyConnectInput,
  CONNECT_CODE_CHOICE,
  CONNECT_CODE_PROMPT,
  connectChoices,
  connectFailureActions,
  connectInputProblem,
  describeClaimError,
  describeSessionStatus,
  EditorClaimKind,
  EditorClaimResult,
  EditorSessionLabel,
  EditorSessionManager,
  EditorSessionManagerDeps,
  EditorSessionRecord,
  interpretClaimResponse,
  interpretSessionCheck,
  isDifferentUser,
  normalizePairingCode,
  parseEditorSessionFile,
  parseStoredEditorSession,
  requestEditorClaim,
  resolveEditorSession,
  sameBackendUrl,
  serializeStoredEditorSession,
  SessionCheck,
  sessionLostWarning,
} from '../editor-session';

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const BACKEND = 'https://app-adaceen-api-eyder05232002.azurewebsites.net';
const SESSION_A = '11111111-2222-4333-8444-555555555555';
const SESSION_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const SESSION_C = 'cccccccc-dddd-4eee-8fff-000000000000';
const GITHUB_TOKEN = 'gho_TOKENSECRETO123';

function fileText(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    sessionId: SESSION_B,
    backendUrl: `${BACKEND}/`,
    expiresAt: '2026-10-20T00:00:00.000Z',
    userName: 'Ana Estudiante',
    userEmail: 'ana@correounivalle.edu.co',
    writtenAt: '2026-09-25T11:00:00.000Z',
    ...overrides,
  });
}

function record(overrides: Partial<EditorSessionRecord> = {}): EditorSessionRecord {
  return {
    sessionId: SESSION_A,
    backendUrl: BACKEND,
    expiresAt: Date.parse('2026-10-25T00:00:00.000Z'),
    userName: 'Ana Estudiante',
    userEmail: 'ana@correounivalle.edu.co',
    label: 'github',
    ...overrides,
  };
}

describe('archivo de sesion del tunel', () => {
  it('lee el formato del contrato', () => {
    const parsed = parseEditorSessionFile(fileText(), NOW);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.session, {
      sessionId: SESSION_B,
      backendUrl: BACKEND,
      expiresAt: Date.parse('2026-10-20T00:00:00.000Z'),
      userName: 'Ana Estudiante',
      userEmail: 'ana@correounivalle.edu.co',
      label: 'tunnel',
    });
  });

  it('descarta la sesion vencida', () => {
    assert.deepEqual(parseEditorSessionFile(fileText({ expiresAt: '2026-09-25T11:59:59.000Z' }), NOW), { ok: false, problem: 'vencida' });
  });

  it('exige version 1', () => {
    assert.deepEqual(parseEditorSessionFile(fileText({ version: 2 }), NOW), { ok: false, problem: 'version' });
    assert.deepEqual(parseEditorSessionFile(fileText({ version: '1' }), NOW), { ok: false, problem: 'version' });
    const sinVersion = JSON.parse(fileText());
    delete sinVersion.version;
    assert.deepEqual(parseEditorSessionFile(JSON.stringify(sinVersion), NOW), { ok: false, problem: 'version' });
  });

  it('valida los campos: sessionId apto para cabecera y fecha legible', () => {
    for (const bad of [
      { sessionId: '' },
      { sessionId: 42 },
      { sessionId: 'con espacio 1234' },
      { sessionId: 'linea\nnueva1234' },
      { sessionId: 'x'.repeat(201) },
      { expiresAt: 'manana' },
    ]) {
      assert.deepEqual(parseEditorSessionFile(fileText(bad), NOW), { ok: false, problem: 'campos' }, JSON.stringify(bad));
    }
  });

  it('tolera BOM, campos opcionales ausentes y un backendUrl que no es http', () => {
    const parsed = parseEditorSessionFile(`﻿${JSON.stringify({ version: 1, sessionId: SESSION_B, backendUrl: 'javascript:alert(1)' })}`, NOW);
    assert.ok(parsed.ok);
    assert.equal(parsed.session.backendUrl, '');
    assert.equal(parsed.session.expiresAt, null);
    assert.equal(parsed.session.userName, '');
  });

  it('rechaza JSON roto, arreglos y archivos enormes', () => {
    assert.deepEqual(parseEditorSessionFile('{', NOW), { ok: false, problem: 'json' });
    assert.deepEqual(parseEditorSessionFile('[1]', NOW), { ok: false, problem: 'json' });
    assert.deepEqual(parseEditorSessionFile(' '.repeat(70 * 1024), NOW), { ok: false, problem: 'grande' });
  });

  it('el registro de SecretStorage ida y vuelta', () => {
    const original = record({ label: 'vscode-local' });
    const parsed = parseStoredEditorSession(serializeStoredEditorSession(original, NOW), NOW);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.session, original);
    const raro = parseStoredEditorSession(JSON.stringify({ version: 1, sessionId: SESSION_A, label: 'otro' }), NOW);
    assert.ok(raro.ok);
    assert.equal(raro.session.label, 'codigo');
  });
});

describe('codigos y sesiones pegadas', () => {
  it('normaliza el codigo del navegador', () => {
    assert.equal(normalizePairingCode('K7P4-M2QX'), 'K7P4-M2QX');
    assert.equal(normalizePairingCode(' k7p4m2qx '), 'K7P4-M2QX');
    assert.equal(normalizePairingCode('k7p4 m2qx'), 'K7P4-M2QX');
    assert.equal(normalizePairingCode('K7P4–M2QX'), 'K7P4-M2QX');
  });

  it('rechaza caracteres fuera del alfabeto y largos distintos de 8', () => {
    for (const bad of ['K7P4-M2Q0', 'K7P4-M2QO', 'K7P4-M2QI', 'K7P4-M2QL', 'K7P4-M2Q1', 'K7P4-M2Q', 'K7P4-M2QXX', '', 'K7P4-M2Q?']) {
      assert.equal(normalizePairingCode(bad), null, bad);
    }
    assert.equal(normalizePairingCode(12345678), null);
  });

  it('clasifica lo que se escribe o pega', () => {
    assert.deepEqual(classifyConnectInput('k7p4-m2qx'), { kind: 'code', code: 'K7P4-M2QX' });
    assert.deepEqual(classifyConnectInput(`  "${SESSION_A.toUpperCase()}" `), { kind: 'session', sessionId: SESSION_A });
    assert.deepEqual(classifyConnectInput('sesion_larga_de_prueba_0123456789'), { kind: 'session', sessionId: 'sesion_larga_de_prueba_0123456789' });
    assert.deepEqual(classifyConnectInput('   '), { kind: 'empty' });
    // Un codigo mal escrito no se toma por sesion.
    assert.deepEqual(classifyConnectInput('K7P4-M2QI'), { kind: 'invalid' });
    assert.deepEqual(classifyConnectInput('hola mundo'), { kind: 'invalid' });
  });

  it('validateInput: vacio no es error, lo invalido si', () => {
    assert.equal(connectInputProblem(''), undefined);
    assert.equal(connectInputProblem('K7P4-M2QX'), undefined);
    assert.equal(connectInputProblem(SESSION_A), undefined);
    assert.match(connectInputProblem('K7P4') || '', /XXXX-XXXX/);
  });
});

describe('«ADACEEN: Conectar» y avisos', () => {
  const sinIcono = (label: string) => label.replace(/^\$\([^)]+\)\s*/, '');

  it('una sola opcion para escribir o pegar: «Tengo un código o sesión»', () => {
    const choices = connectChoices({ canDisconnect: false });
    assert.deepEqual(choices.map((choice) => choice.id), ['github', 'code']);
    assert.deepEqual(choices.map((choice) => sinIcono(choice.label)), ['Con mi cuenta de GitHub (recomendado)', 'Tengo un código o sesión']);
    // Nada de «Pegar sesión» ni «Tengo un código del navegador» por separado.
    for (const choice of choices) {
      assert.doesNotMatch(choice.label, /Pegar sesión|del navegador/);
    }
  });

  it('el detalle no dice que el overlay copia el ID de sesion', () => {
    const code = connectChoices({ canDisconnect: false }).find((choice) => choice.id === 'code');
    assert.ok(code);
    assert.match(code.detail, /XXXX-XXXX/);
    assert.match(code.detail, /ID de sesión de versiones anteriores/);
    for (const choice of connectChoices({ canDisconnect: true })) {
      assert.doesNotMatch(choice.detail, /copia el overlay|copiado del overlay/);
    }
    assert.doesNotMatch(CONNECT_CODE_PROMPT.prompt, /copia el overlay|copiado del overlay/);
  });

  it('«Desconectar este equipo» solo con sesion guardada en este VS Code', () => {
    const choices = connectChoices({ canDisconnect: true });
    assert.deepEqual(choices.map((choice) => choice.id), ['github', 'code', 'disconnect']);
    assert.equal(sinIcono(choices[2].label), 'Desconectar este equipo');
  });

  it('la misma caja acepta el codigo y el ID de sesion', () => {
    assert.equal(CONNECT_CODE_PROMPT.title, 'ADACEEN: Tengo un código o sesión');
    assert.match(CONNECT_CODE_PROMPT.placeHolder, /XXXX-XXXX/);
    assert.match(CONNECT_CODE_PROMPT.placeHolder, /ID de sesión/);
    assert.equal(connectInputProblem('k7p4-m2qx'), undefined);
    assert.equal(connectInputProblem(SESSION_A), undefined);
    assert.equal(classifyConnectInput('k7p4-m2qx').kind, 'code');
    assert.equal(classifyConnectInput(SESSION_A).kind, 'session');
  });

  it('el aviso de sesion perdida nombra el boton que ofrece', () => {
    for (const fromTunnel of [true, false]) {
      const warning = sessionLostWarning(fromTunnel);
      assert.equal(warning.action, 'Conectar');
      assert.ok(warning.message.includes(`«${warning.action}»`), warning.message);
      assert.ok(warning.message.startsWith('ADACEEN: tu sesión dejó de valer (por ejemplo, cerraste sesión en el navegador).'));
    }
    // En el tunel tambien sirve volver a «Abrir mi editor» (la VM escribe otra sesion).
    assert.match(sessionLostWarning(true).message, /«Abrir mi editor» en el navegador/);
    assert.doesNotMatch(sessionLostWarning(false).message, /Abrir mi editor/);
    // Ya no manda solo al navegador con un boton que dice otra cosa.
    assert.doesNotMatch(sessionLostWarning(true).message, /^[^«]*Vuelve a pulsar «Abrir mi editor»/);
  });

  it('backend sin la ruta de canje: manda a la opcion que acepta el ID de sesion', () => {
    const text = describeClaimError('backend_outdated', BACKEND);
    assert.match(text, /todavía no permite conectar VS Code así/);
    assert.match(text, /«Tengo un código o sesión»/);
    assert.doesNotMatch(text, /Pegar sesión/);
  });

  it('la opcion, la caja y los avisos usan el mismo nombre', () => {
    assert.equal(CONNECT_CODE_CHOICE, 'Tengo un código o sesión');
    assert.equal(sinIcono(connectChoices({ canDisconnect: false })[1].label), CONNECT_CODE_CHOICE);
    assert.equal(CONNECT_CODE_PROMPT.title, `ADACEEN: ${CONNECT_CODE_CHOICE}`);
  });

  it('docente con GitHub: texto local con los botones de hoy, sin «Reintentar»', () => {
    const context = { backendUrl: BACKEND, label: 'github' as EditorSessionLabel };
    // Lo que responde el backend (src/routes/editor-auth-routes.ts): su texto cita la opcion de la 0.0.31.
    const staff = interpretClaimResponse(404, {
      ok: false,
      error: 'github_login_not_linked',
      reason: 'staff_requires_code',
      message: 'Las cuentas de docente y administrador se vinculan con un codigo del navegador: en el overlay usa "Abrir en VS Code de este equipo" o "Copiar codigo para VS Code" y elige "Tengo un codigo del navegador".',
    }, context);
    assert.ok(!staff.ok);
    assert.equal(staff.error, 'staff_requires_code');
    assert.equal(staff.status, 404);
    // El comienzo es el del backend, que cita la guia.
    assert.ok(staff.message.startsWith('Las cuentas de docente y administrador se vinculan con un codigo del navegador'), staff.message);
    assert.ok(staff.message.includes(`«${CONNECT_CODE_CHOICE}»`), staff.message);
    assert.match(staff.message, /«Copiar codigo para VS Code»/);
    assert.doesNotMatch(staff.message, /Tengo un codigo del navegador|Copiar sesion/);
    // Nada que reintentar: el boton abre la caja del codigo.
    assert.deepEqual(connectFailureActions(staff.error, true), [CONNECT_CODE_CHOICE]);
    assert.deepEqual(connectFailureActions(staff.error, false), [CONNECT_CODE_CHOICE]);

    // Un estudiante sin vincular sigue viendo el mensaje del backend y puede reintentar.
    const student = interpretClaimResponse(404, {
      ok: false,
      error: 'github_login_not_linked',
      message: 'Conecta tu cuenta de GitHub en ADACEEN (overlay del navegador) y vuelve a intentar.',
    }, context);
    assert.ok(!student.ok);
    assert.equal(student.error, 'github_login_not_linked');
    assert.deepEqual(connectFailureActions(student.error, true), ['Reintentar', 'Conectar de otra forma']);
    assert.deepEqual(connectFailureActions('code_not_found', false), ['Conectar de otra forma']);
  });
});

describe('orden de resolucion', () => {
  const secret = record({ sessionId: SESSION_A });
  const file = record({ sessionId: SESSION_B, label: 'tunnel' });

  it('SecretStorage, luego archivo, luego ajuste y variable', () => {
    assert.equal(resolveEditorSession({ secret, file, setting: 'ajuste-123456', env: 'env-12345678' }, { now: NOW })?.source, 'secret');
    assert.equal(resolveEditorSession({ secret: null, file, setting: 'ajuste-123456' }, { now: NOW })?.source, 'file');
    assert.deepEqual(resolveEditorSession({ setting: ' ajuste-123456 ', env: 'env-12345678' }, { now: NOW }), {
      sessionId: 'ajuste-123456',
      backendUrl: '',
      expiresAt: null,
      userName: '',
      userEmail: '',
      label: 'heredada',
      source: 'setting',
    });
    assert.equal(resolveEditorSession({ setting: '  ', env: 'env-12345678' }, { now: NOW })?.source, 'env');
    assert.equal(resolveEditorSession({}, { now: NOW }), null);
  });

  it('salta las vencidas y las que el backend rechazo', () => {
    const vencida = record({ expiresAt: NOW - 1 });
    assert.equal(resolveEditorSession({ secret: vencida, file }, { now: NOW })?.sessionId, SESSION_B);
    const ignored = new Set([SESSION_A, SESSION_B]);
    assert.equal(resolveEditorSession({ secret, file, setting: 'ajuste-123456' }, { now: NOW, ignored })?.source, 'setting');
    assert.equal(resolveEditorSession({ secret, file, setting: 'ajuste-123456' }, { now: NOW, ignored: new Set([...ignored, 'ajuste-123456']) }), null);
  });

  it('compara backends sin fijarse en mayusculas ni barra final', () => {
    assert.equal(sameBackendUrl(`${BACKEND}/`, BACKEND.toUpperCase()), true);
    assert.equal(sameBackendUrl('http://127.0.0.1:3000', 'http://localhost:3000'), false);
    assert.equal(sameBackendUrl('https://a.test:443/', 'https://a.test'), true);
    assert.equal(sameBackendUrl('', BACKEND), false);
  });

  it('barra de estado: sin conectar o conectado como', () => {
    assert.match(describeSessionStatus(null).text, /sin conectar/);
    const status = describeSessionStatus({ ...record(), source: 'secret' });
    assert.equal(status.connected, true);
    assert.equal(status.text, '$(account) ADACEEN: Ana Estudiante');
    assert.match(status.tooltip, /Conectado como Ana Estudiante \(ana@correounivalle.edu.co\)/);
    assert.match(status.tooltip, /cuenta de GitHub de VS Code/);
    assert.doesNotMatch(status.tooltip, new RegExp(SESSION_A));
  });
});

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

// ---------------------------------------------------------------------------
// EditorSessionManager con dependencias falsas

type Harness = ReturnType<typeof harness>;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function harness(options: {
  secret?: string;
  file?: string | null;
  setting?: string;
  env?: string;
  githubToken?: string | null;
  githubClaim?: EditorClaimResult;
  codeClaim?: EditorClaimResult;
  check?: SessionCheck;
  failStore?: boolean;
  backendUrl?: string;
  editorHost?: string;
  unlinked?: boolean;
  silentGithubAllowed?: boolean;
  /** Demora de cada canje (ms), para las carreras. */
  claimDelayMs?: { github?: number; code?: number };
  /** Demora de SecretStorage al leer (ms) y espera maxima del gestor. */
  secretDelayMs?: number;
  secretReadTimeoutMs?: number;
} = {}) {
  const state = {
    secret: options.secret as string | undefined,
    file: options.file ?? null,
    setting: options.setting,
    backendUrl: options.backendUrl ?? BACKEND,
    unlinked: options.unlinked ?? false,
    now: NOW,
  };
  const logs: string[] = [];
  const claims: Array<{ kind: EditorClaimKind; body: Record<string, unknown>; label: EditorSessionLabel }> = [];
  const tokenModes: string[] = [];
  const checks: string[] = [];
  const changes: Array<{ id: string; idChanged: boolean }> = [];
  let lost = 0;
  let deletes = 0;
  const deps: EditorSessionManagerDeps = {
    secrets: {
      get: async () => {
        const value = state.secret;
        if (options.secretDelayMs) {
          await sleep(options.secretDelayMs);
        }
        return value;
      },
      store: async (value) => {
        if (options.failStore) {
          throw new Error('sin llavero');
        }
        state.secret = value;
      },
      delete: async () => {
        deletes += 1;
        state.secret = undefined;
      },
    },
    readSessionFile: async () => state.file,
    readSetting: () => state.setting,
    readEnv: () => options.env,
    backendUrl: () => state.backendUrl,
    editorHost: () => options.editorHost ?? 'local',
    unlinkedMark: {
      get: () => state.unlinked,
      set: (value) => {
        state.unlinked = value;
      },
    },
    silentGithubAllowed: options.silentGithubAllowed === undefined ? undefined : () => options.silentGithubAllowed === true,
    secretReadTimeoutMs: options.secretReadTimeoutMs,
    getGithubToken: async (mode) => {
      tokenModes.push(mode);
      return options.githubToken === undefined ? null : options.githubToken;
    },
    claim: async (kind, body, label) => {
      claims.push({ kind, body, label });
      const delay = options.claimDelayMs?.[kind];
      if (delay) {
        await sleep(delay);
      }
      const result = kind === 'github' ? options.githubClaim : options.codeClaim;
      return result ?? { ok: false, error: 'network', message: 'sin red', status: 0 };
    },
    checkSession: async (sessionId) => {
      checks.push(sessionId);
      return options.check ?? { status: 'unknown' };
    },
    now: () => state.now,
    log: (line) => logs.push(line),
    onDidChange: (session, idChanged) => changes.push({ id: session?.sessionId ?? '', idChanged }),
    onSessionLost: () => {
      lost += 1;
    },
  };
  const manager = new EditorSessionManager(deps);
  return {
    manager,
    state,
    logs,
    claims,
    tokenModes,
    checks,
    changes,
    get lost() {
      return lost;
    },
    get deletes() {
      return deletes;
    },
  };
}

function claimOk(sessionId: string, label: EditorSessionLabel): EditorClaimResult {
  return { ok: true, githubLogin: 'ana-gh', session: record({ sessionId, label, userName: 'Ana' }) };
}

function assertNoSecretsInLogs(h: Harness) {
  const text = h.logs.join('\n');
  for (const secret of [SESSION_A, SESSION_B, SESSION_C, GITHUB_TOKEN, 'K7P4', 'ajuste-123456']) {
    assert.equal(text.includes(secret), false, `el log contiene ${secret}`);
  }
}

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

describe('fechas de escritura y personas', () => {
  it('lee writtenAt del archivo y savedAt del registro; una fecha rara no invalida', () => {
    const file = parseEditorSessionFile(fileText(), NOW);
    assert.ok(file.ok);
    assert.equal(file.writtenAt, Date.parse('2026-09-25T11:00:00.000Z'));
    const stored = parseStoredEditorSession(serializeStoredEditorSession(record(), NOW), NOW);
    assert.ok(stored.ok);
    assert.equal(stored.writtenAt, NOW);
    const raro = parseEditorSessionFile(fileText({ writtenAt: 'ayer' }), NOW);
    assert.ok(raro.ok);
    assert.equal(raro.writtenAt, null);
  });

  it('isDifferentUser compara correo (sin mayusculas) y, si falta, el nombre', () => {
    assert.equal(isDifferentUser({ userName: 'A', userEmail: 'a@x.co' }, { userName: 'B', userEmail: 'b@x.co' }), true);
    assert.equal(isDifferentUser({ userName: 'A', userEmail: 'A@X.co' }, { userName: 'Ana', userEmail: 'a@x.co ' }), false);
    assert.equal(isDifferentUser({ userName: 'Ana', userEmail: '' }, { userName: 'Beto', userEmail: 'b@x.co' }), true);
    assert.equal(isDifferentUser({ userName: '', userEmail: '' }, { userName: 'Beto', userEmail: 'b@x.co' }), false);
    assert.equal(isDifferentUser(null, { userName: 'Beto', userEmail: 'b@x.co' }), false);
  });
});
