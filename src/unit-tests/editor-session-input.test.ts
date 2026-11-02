// Pruebas de editor-session-input.ts: codigos, sesiones pegadas, «ADACEEN: Conectar» y avisos.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { classifyConnectInput, CONNECT_CODE_CHOICE, CONNECT_CODE_PROMPT, connectChoices, connectFailureActions, connectInputProblem, normalizePairingCode, sessionLostWarning } from '../editor-session-input';
import type { EditorSessionLabel } from '../editor-session-records';
import { describeClaimError, interpretClaimResponse } from '../editor-session-claim';
import { BACKEND, SESSION_A } from './editor-session-fixtures';

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
