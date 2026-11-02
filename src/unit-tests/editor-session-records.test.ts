// Pruebas de editor-session-records.ts: archivo del tunel, orden de resolucion, fechas y personas.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { describeSessionStatus, SESSION_STATUS_UNCONNECTED_TEXT, isDifferentUser, resolveEditorSession, parseEditorSessionFile, parseStoredEditorSession, sameBackendUrl, serializeStoredEditorSession } from '../editor-session-records';
import { NOW, BACKEND, SESSION_A, SESSION_B, fileText, record } from './editor-session-fixtures';

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
    // La guia del tunel del navegador lee la barra: «ADACEEN» y «sin conectar» solo sin sesion.
    assert.equal(SESSION_STATUS_UNCONNECTED_TEXT, 'ADACEEN: sin conectar');
    assert.ok(describeSessionStatus(null).text.endsWith(SESSION_STATUS_UNCONNECTED_TEXT));
    assert.match(status.text, /\bADACEEN\b/);
    assert.doesNotMatch(status.text, /sin conectar/i);
    assert.match(status.tooltip, /Conectado como Ana Estudiante \(ana@correounivalle.edu.co\)/);
    assert.match(status.tooltip, /cuenta de GitHub de VS Code/);
    assert.doesNotMatch(status.tooltip, new RegExp(SESSION_A));
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
