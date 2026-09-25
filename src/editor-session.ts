/**
 * Sesion de ADACEEN en VS Code (docs/arquitectura/acceso-simplificado.md, seccion 3).
 *
 * La sesion que viaja en x-session-id sale de, en este orden:
 *
 *   1. SecretStorage adaceen.editorSession: la sesion emparejada en este
 *      equipo (cuenta de GitHub de VS Code, codigo del navegador o ID de
 *      sesion pegado). Nunca va en settings y el token de GitHub no se guarda.
 *   2. ~/.adaceen/editor-session.json: lo escribe la VM de editores (tunel)
 *      cada vez que el estudiante prepara su editor. Solo existe en el host
 *      Node de la extension; la extension web no tiene disco.
 *   3. Ajuste heredado adaceen.backend.sessionId y variable ADACEEN_SESSION_ID
 *      («Configurar sesion compartida» sigue en la paleta: abre la misma caja
 *      que «Tengo un codigo o sesion» y guarda en SecretStorage).
 *
 * La sesion emparejada solo se usa con el backend donde se obtuvo. En el
 * tunel, un archivo escrito despues de guardarla gana (la VM es del estudiante).
 *
 * Sin sesion, al arrancar se intenta, en silencio, canjear la cuenta de GitHub
 * que VS Code ya tiene (POST /api/auth/editor/github): cero clics si la
 * extension ya tenia permiso. Cuando el backend responde x-adaceen-session:
 * invalid se olvida esa sesion, se relee el archivo y, si no queda ninguna, se
 * avisa una sola vez por ventana (boton Conectar). Tras un rechazo (o
 * «Desconectar») no se vuelve a conectar en silencio con GitHub hasta una
 * conexion hecha a mano: en un equipo compartido esa cuenta puede ser de otro.
 *
 * No importa vscode: SecretStorage, el archivo, GitHub y el backend llegan
 * como dependencias, para probar todo con node:test. Nada de aqui escribe en
 * el log ids de sesion, codigos ni tokens.
 */

import { SESSION_STATUS_HEADER } from './client-identity';

export const EDITOR_SESSION_SECRET_KEY = 'adaceen.editorSession';
export const EDITOR_SESSION_FILE_VERSION = 1;
/** El archivo real pesa unos 300 bytes; algo mucho mayor no es nuestro. */
export const EDITOR_SESSION_FILE_MAX_BYTES = 64 * 1024;
export const GITHUB_AUTH_PROVIDER = 'github';
export const GITHUB_SCOPES = ['read:user'];
/** Alfabeto de los codigos de emparejamiento (sin I, L, O, 0 ni 1). */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const EDITOR_CLAIM_PATHS = {
  code: '/api/auth/editor/claim',
  github: '/api/auth/editor/github',
} as const;
export const SESSION_CHECK_PATH = '/api/auth/me';
/**
 * Marca en globalState: en este equipo se cerro sesion (el backend rechazo la
 * sesion) o se pulso «Desconectar». Mientras exista no hay GitHub en silencio.
 */
export const EDITOR_UNLINKED_STORAGE_KEY = 'adaceen.editorSession.desvinculado';

const SECRET_READ_TIMEOUT_MS = 3000;
const DEFAULT_CLAIM_TIMEOUT_MS = 15000;

/** Va en una cabecera HTTP: nada de espacios ni saltos de linea. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{8,200}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Una sesion pegada que no es UUID tiene que ser larga: si no, es un codigo mal escrito. */
const PASTED_SESSION_MIN_CHARS = 24;
const TEXT_FIELD_MAX_CHARS = 200;

export type EditorSessionSource = 'secret' | 'file' | 'setting' | 'env';

/**
 * Origen legible (label de app_sessions en el backend):
 *   github        cuenta de GitHub de VS Code
 *   codigo        codigo XXXX-XXXX escrito a mano
 *   vscode-local  boton «Abrir en VS Code de este equipo» del navegador
 *   tunnel        archivo que escribe la VM de editores
 *   manual        ID de sesion pegado (UUID que copiaba «Copiar sesion»)
 *   heredada      ajuste adaceen.backend.sessionId o ADACEEN_SESSION_ID
 */
export type EditorSessionLabel = 'github' | 'codigo' | 'vscode-local' | 'tunnel' | 'manual' | 'heredada';

const KNOWN_LABELS: ReadonlySet<string> = new Set(['github', 'codigo', 'vscode-local', 'tunnel', 'manual', 'heredada']);

export type EditorSessionRecord = {
  sessionId: string;
  /** Backend donde se obtuvo ('' si no se sabe). */
  backendUrl: string;
  /** Vencimiento en ms; null = sin vencimiento (sesiones heredadas). */
  expiresAt: number | null;
  userName: string;
  userEmail: string;
  label: EditorSessionLabel;
};

export type ResolvedEditorSession = EditorSessionRecord & { source: EditorSessionSource };

// ---------------------------------------------------------------------------
// Validacion

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value: unknown, maxChars = TEXT_FIELD_MAX_CHARS) {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

/** Sin recortar: un id demasiado largo tiene que fallar la validacion, no acortarse. */
function rawSessionId(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isSafeSessionId(value: unknown): boolean {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

export function isLegacySessionUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_PATTERN.test(value.trim());
}

/** Solo http(s); cualquier otra cosa se descarta (el campo es informativo). */
function cleanBackendUrl(value: unknown) {
  const text = cleanText(value, 500);
  if (!text) {
    return '';
  }
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? text.replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

/**
 * undefined, null o '' -> null (sin vencimiento). Una fecha que no se puede
 * leer -> NaN, que el llamador trata como campo invalido.
 */
function parseExpiresAt(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return Number.NaN;
  }
  return Date.parse(value);
}

export function isSessionExpired(record: Pick<EditorSessionRecord, 'expiresAt'>, now = Date.now()) {
  return record.expiresAt !== null && record.expiresAt <= now;
}

/**
 * Normaliza la URL de un backend para compararla: esquema y host en
 * minusculas, sin puerto por defecto ni barra final.
 */
export function normalizeBackendUrl(value: string) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  try {
    const parsed = new URL(text);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host}${path}`.toLowerCase();
  } catch {
    return text.replace(/\/+$/, '').toLowerCase();
  }
}

export function sameBackendUrl(a: string, b: string) {
  const left = normalizeBackendUrl(a);
  return Boolean(left) && left === normalizeBackendUrl(b);
}

// ---------------------------------------------------------------------------
// Archivo del tunel y registro en SecretStorage

/** Por que se descarta un archivo o un registro guardado. */
export type SessionDocumentProblem = 'json' | 'version' | 'campos' | 'vencida' | 'grande';

export type ParsedSessionDocument =
  /** writtenAt: cuando se escribio (writtenAt del archivo, savedAt del registro); null si no se sabe. */
  | { ok: true; session: EditorSessionRecord; writtenAt: number | null }
  | { ok: false; problem: SessionDocumentProblem };

export function describeSessionDocumentProblem(problem: SessionDocumentProblem) {
  switch (problem) {
    case 'json':
      return 'no es JSON valido';
    case 'version':
      return `version distinta de ${EDITOR_SESSION_FILE_VERSION}`;
    case 'campos':
      return 'falta sessionId o un campo no tiene el formato esperado';
    case 'vencida':
      return 'la sesion ya vencio';
    default:
      return 'demasiado grande';
  }
}

/**
 * Lee el formato comun del archivo del tunel y del registro de SecretStorage:
 *
 *   { "version": 1, "sessionId": "...", "backendUrl": "https://...",
 *     "expiresAt": "ISO", "userName": "...", "userEmail": "...", ... }
 */
function parseSessionDocument(
  text: string,
  now: number,
  label: (raw: unknown) => EditorSessionLabel,
  writtenAtField: 'writtenAt' | 'savedAt',
): ParsedSessionDocument {
  if (text.length > EDITOR_SESSION_FILE_MAX_BYTES) {
    return { ok: false, problem: 'grande' };
  }
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { ok: false, problem: 'json' };
  }
  if (!isPlainObject(data)) {
    return { ok: false, problem: 'json' };
  }
  if (data.version !== EDITOR_SESSION_FILE_VERSION) {
    return { ok: false, problem: 'version' };
  }
  const sessionId = rawSessionId(data.sessionId);
  const expiresAt = parseExpiresAt(data.expiresAt);
  if (!isSafeSessionId(sessionId) || Number.isNaN(expiresAt)) {
    return { ok: false, problem: 'campos' };
  }
  const session: EditorSessionRecord = {
    sessionId,
    backendUrl: cleanBackendUrl(data.backendUrl),
    expiresAt,
    userName: cleanText(data.userName),
    userEmail: cleanText(data.userEmail),
    label: label(data.label),
  };
  if (isSessionExpired(session, now)) {
    return { ok: false, problem: 'vencida' };
  }
  // Solo sirve para comparar archivo y llavero en el tunel: si no se lee, no invalida nada.
  const writtenAt = parseExpiresAt(data[writtenAtField]);
  return { ok: true, session, writtenAt: writtenAt === null || Number.isNaN(writtenAt) ? null : writtenAt };
}

/** ~/.adaceen/editor-session.json (lo escribe el agente de la VM de editores). */
export function parseEditorSessionFile(text: string, now = Date.now()): ParsedSessionDocument {
  return parseSessionDocument(text, now, () => 'tunnel', 'writtenAt');
}

/** Registro guardado en SecretStorage (adaceen.editorSession). */
export function parseStoredEditorSession(text: string, now = Date.now()): ParsedSessionDocument {
  return parseSessionDocument(text, now, (raw) => (
    typeof raw === 'string' && KNOWN_LABELS.has(raw) ? raw as EditorSessionLabel : 'codigo'
  ), 'savedAt');
}

export function serializeStoredEditorSession(record: EditorSessionRecord, now = Date.now()) {
  return JSON.stringify({
    version: EDITOR_SESSION_FILE_VERSION,
    sessionId: record.sessionId,
    backendUrl: record.backendUrl,
    expiresAt: record.expiresAt === null ? null : new Date(record.expiresAt).toISOString(),
    userName: record.userName,
    userEmail: record.userEmail,
    label: record.label,
    savedAt: new Date(now).toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Codigos de emparejamiento y sesiones pegadas

/**
 * Codigo de un solo uso del navegador: 8 caracteres del alfabeto en dos
 * grupos. Acepta minusculas, espacios y guiones (tambien los tipograficos que
 * aparecen al copiar); devuelve "XXXX-XXXX" o null.
 */
export function normalizePairingCode(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const compact = value.toUpperCase().replace(/[\s\-‐-―_.]+/g, '');
  if (compact.length !== 8) {
    return null;
  }
  for (const char of compact) {
    if (!PAIRING_CODE_ALPHABET.includes(char)) {
      return null;
    }
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export type ConnectInput =
  | { kind: 'code'; code: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'empty' }
  | { kind: 'invalid' };

/**
 * Lo que el estudiante escribe o pega en «Tengo un codigo o sesion» (o en
 * «Configurar sesion compartida», que abre la misma caja): un codigo XXXX-XXXX
 * (se canjea) o, por compatibilidad, el UUID de sesion que copiaba el navegador.
 */
export function classifyConnectInput(value: unknown): ConnectInput {
  const text = String(value ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!text) {
    return { kind: 'empty' };
  }
  const code = normalizePairingCode(text);
  if (code) {
    return { kind: 'code', code };
  }
  if (isLegacySessionUuid(text)) {
    return { kind: 'session', sessionId: text.toLowerCase() };
  }
  if (isSafeSessionId(text) && text.length >= PASTED_SESSION_MIN_CHARS) {
    return { kind: 'session', sessionId: text };
  }
  return { kind: 'invalid' };
}

/** Mensaje para validateInput de la caja de texto (undefined = valido). */
export function connectInputProblem(value: string): string | undefined {
  const input = classifyConnectInput(value);
  if (input.kind === 'code' || input.kind === 'session') {
    return undefined;
  }
  // Vacio no es error: la caja recien abierta no debe salir en rojo.
  return input.kind === 'empty'
    ? undefined
    : 'El código tiene 8 letras o números (XXXX-XXXX). También sirve el ID de sesión copiado del navegador.';
}

// ---------------------------------------------------------------------------
// Textos de «ADACEEN: Conectar» y del aviso de sesion perdida (editor-connect.ts
// los muestra; aqui se prueban sin vscode)

export type ConnectChoiceId = 'github' | 'code' | 'disconnect';

export type ConnectChoice = {
  id: ConnectChoiceId;
  /** Con icono de VS Code ($(...)); la guia cita el texto sin el icono. */
  label: string;
  detail: string;
};

/** Opcion de «ADACEEN: Conectar» para escribir o pegar (sin el icono). */
export const CONNECT_CODE_CHOICE = 'Tengo un código o sesión';

/** Caja de texto de «Tengo un codigo o sesion» (y de «Configurar sesion compartida»). */
export const CONNECT_CODE_PROMPT = {
  // Literal (no con CONNECT_CODE_CHOICE): la guia y sus pruebas buscan el texto tal cual.
  title: 'ADACEEN: Tengo un código o sesión',
  prompt: 'Escribe el código de 8 caracteres que muestra el navegador (por ejemplo K7P4-M2QX). También puedes pegar un ID de sesión de versiones anteriores.',
  placeHolder: 'XXXX-XXXX o ID de sesión',
} as const;

/**
 * Opciones de «ADACEEN: Conectar». Escribir o pegar es una sola opcion
 * («Tengo un codigo o sesion»): la caja acepta el codigo XXXX-XXXX o el ID de
 * sesion de antes (classifyConnectInput decide). «Desconectar este equipo» solo
 * aparece si la sesion vigente esta guardada en este VS Code.
 */
export function connectChoices(options: { canDisconnect: boolean }): ConnectChoice[] {
  const choices: ConnectChoice[] = [
    {
      id: 'github',
      label: '$(github) Con mi cuenta de GitHub (recomendado)',
      detail: 'Un clic en «Permitir». Usa la cuenta de GitHub que conectaste en ADACEEN.',
    },
    {
      id: 'code',
      label: '$(key) Tengo un código o sesión',
      detail: 'El código XXXX-XXXX que muestra el overlay de ADACEEN (dura 10 minutos). También acepta el ID de sesión de versiones anteriores.',
    },
  ];
  if (options.canDisconnect) {
    choices.push({
      id: 'disconnect',
      label: '$(debug-disconnect) Desconectar este equipo',
      detail: 'Olvida la sesión guardada en VS Code (por ejemplo, en un equipo compartido o si no eres tú).',
    });
  }
  return choices;
}

/**
 * Botones del aviso «ADACEEN: no se pudo conectar…». Un docente que probo con
 * GitHub (staff_requires_code) no tiene nada que reintentar: su boton abre
 * directamente la caja del codigo.
 */
export function connectFailureActions(error: string, canRetry: boolean): string[] {
  if (error === 'staff_requires_code') {
    return [CONNECT_CODE_CHOICE];
  }
  return canRetry ? ['Reintentar', 'Conectar de otra forma'] : ['Conectar de otra forma'];
}

/** Boton del aviso de sesion perdida (abre «ADACEEN: Conectar»). */
export const SESSION_LOST_ACTION = 'Conectar';

/**
 * Aviso unico cuando la sesion deja de valer. El texto nombra el boton que
 * ofrece («Conectar»); en el tunel recuerda ademas que «Abrir mi editor» en el
 * navegador escribe una sesion nueva y VS Code la toma solo.
 */
export function sessionLostWarning(fromTunnel: boolean): { message: string; action: string } {
  const lead = 'ADACEEN: tu sesión dejó de valer (por ejemplo, cerraste sesión en el navegador).';
  return {
    message: fromTunnel
      ? `${lead} Pulsa «${SESSION_LOST_ACTION}» o vuelve a pulsar «Abrir mi editor» en el navegador para que tus sugerencias y métricas queden a tu nombre.`
      : `${lead} Pulsa «${SESSION_LOST_ACTION}» para que tus sugerencias y métricas queden a tu nombre.`,
    action: SESSION_LOST_ACTION,
  };
}

// ---------------------------------------------------------------------------
// Orden de resolucion

export type EditorSessionCandidates = {
  secret?: EditorSessionRecord | null;
  /** savedAt del registro de SecretStorage (ms). */
  secretSavedAt?: number | null;
  file?: EditorSessionRecord | null;
  /** writtenAt del archivo del tunel (ms). */
  fileWrittenAt?: number | null;
  /** adaceen.backend.sessionId */
  setting?: string;
  /** ADACEEN_SESSION_ID */
  env?: string;
};

export type ResolveEditorSessionOptions = {
  ignored?: ReadonlySet<string>;
  now?: number;
  /**
   * Backend al que habla la extension ahora. La sesion emparejada solo se usa
   * con el backend donde se obtuvo: no se manda al backend local de la Mac ni
   * a un adaceen.backend.baseUrl que traiga un repositorio ajeno.
   */
  backendUrl?: string;
  /**
   * Tunel: la VM es del estudiante y escribe el archivo en cada «Abrir mi
   * editor»; si lo escribio despues de guardar la sesion emparejada, gana el
   * archivo (el llavero de vscode.dev puede ser de un perfil compartido).
   */
  preferNewerFile?: boolean;
};

function legacySession(sessionId: string, source: 'setting' | 'env'): ResolvedEditorSession {
  return { sessionId, backendUrl: '', expiresAt: null, userName: '', userEmail: '', label: 'heredada', source };
}

/**
 * SecretStorage -> archivo del tunel -> ajuste -> variable. Se saltan las
 * vencidas y las que el backend ya rechazo en esta ventana (ignored).
 */
export function resolveEditorSession(
  candidates: EditorSessionCandidates,
  options: ResolveEditorSessionOptions = {},
): ResolvedEditorSession | null {
  const ignored = options.ignored ?? new Set<string>();
  const now = options.now ?? Date.now();
  const usable = (record: EditorSessionRecord | null | undefined): record is EditorSessionRecord =>
    Boolean(record) && !ignored.has(record!.sessionId) && !isSessionExpired(record!, now);
  const sameBackend = (record: EditorSessionRecord) =>
    !options.backendUrl || !record.backendUrl || sameBackendUrl(record.backendUrl, options.backendUrl);

  const secret = usable(candidates.secret) && sameBackend(candidates.secret) ? candidates.secret : null;
  const file = usable(candidates.file) ? candidates.file : null;
  const fileIsNewer = typeof candidates.fileWrittenAt === 'number'
    && typeof candidates.secretSavedAt === 'number'
    && candidates.fileWrittenAt > candidates.secretSavedAt;
  if (file && secret && options.preferNewerFile && fileIsNewer) {
    return { ...file, source: 'file' };
  }
  if (secret) {
    return { ...secret, source: 'secret' };
  }
  if (file) {
    return { ...file, source: 'file' };
  }
  const setting = String(candidates.setting ?? '').trim();
  if (setting && !ignored.has(setting)) {
    return legacySession(setting, 'setting');
  }
  const env = String(candidates.env ?? '').trim();
  if (env && !ignored.has(env)) {
    return legacySession(env, 'env');
  }
  return null;
}

type SessionPerson = Pick<EditorSessionRecord, 'userName' | 'userEmail'>;

/**
 * La sesion nueva es de otra persona que la anterior (un enlace o un codigo
 * que reemplaza la sesion de otro). Sin datos para comparar: false.
 */
export function isDifferentUser(before: SessionPerson | null | undefined, after: SessionPerson | null | undefined) {
  if (!before || !after) {
    return false;
  }
  const clean = (value: string) => String(value || '').trim().toLowerCase();
  if (clean(before.userEmail) && clean(after.userEmail)) {
    return clean(before.userEmail) !== clean(after.userEmail);
  }
  if (clean(before.userName) && clean(after.userName)) {
    return clean(before.userName) !== clean(after.userName);
  }
  return false;
}

export function describeSessionOrigin(session: Pick<ResolvedEditorSession, 'source' | 'label'>) {
  if (session.source === 'setting') {
    return 'ajuste adaceen.backend.sessionId';
  }
  if (session.source === 'env') {
    return 'variable ADACEEN_SESSION_ID';
  }
  if (session.source === 'file') {
    return 'editor preparado desde el navegador (túnel)';
  }
  switch (session.label) {
    case 'github':
      return 'cuenta de GitHub de VS Code';
    case 'vscode-local':
      return 'botón del navegador';
    case 'manual':
      return 'sesión pegada';
    default:
      return 'código del navegador';
  }
}

/** Texto y tooltip de la barra de estado de la sesion. */
export function describeSessionStatus(session: ResolvedEditorSession | null) {
  if (!session) {
    return {
      connected: false,
      text: '$(debug-disconnect) ADACEEN: sin conectar',
      tooltip: 'VS Code no está conectado a tu cuenta de ADACEEN: tus sugerencias y métricas no quedan a tu nombre.\nClic para conectar.',
    };
  }
  const name = session.userName || session.userEmail;
  const shortName = name.length > 28 ? `${name.slice(0, 27)}…` : name;
  const lines = [
    name ? `Conectado como ${session.userName || session.userEmail}${session.userName && session.userEmail ? ` (${session.userEmail})` : ''}` : 'Conectado a ADACEEN',
    `Origen: ${describeSessionOrigin(session)}`,
  ];
  if (session.expiresAt !== null) {
    lines.push(`Vence: ${new Date(session.expiresAt).toISOString().slice(0, 10)}`);
  }
  lines.push('Clic para conectar otra cuenta.');
  return {
    connected: true,
    text: `$(account) ADACEEN: ${shortName || 'conectado'}`,
    tooltip: lines.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Canje en el backend (contrato 2.1 y 2.2) y comprobacion con /api/auth/me

export type EditorClaimKind = keyof typeof EDITOR_CLAIM_PATHS;

export type EditorClaimError =
  | 'invalid_code'
  | 'code_not_found'
  | 'too_many_attempts'
  | 'missing_token'
  | 'github_token_invalid'
  | 'github_login_not_linked'
  /** github_login_not_linked con reason staff_requires_code: docente o administrador. */
  | 'staff_requires_code'
  | 'backend_outdated'
  | 'network'
  | 'backend_error';

export type EditorClaimResult =
  | { ok: true; session: EditorSessionRecord; githubLogin: string }
  | { ok: false; error: EditorClaimError; message: string; status: number };

const CLAIM_ERRORS: ReadonlySet<string> = new Set([
  'invalid_code',
  'code_not_found',
  'too_many_attempts',
  'missing_token',
  'github_token_invalid',
  'github_login_not_linked',
]);

/** Textos para el estudiante. */
export function describeClaimError(error: EditorClaimError, backendUrl = '') {
  const where = backendUrl ? ` (${backendUrl})` : '';
  switch (error) {
    case 'invalid_code':
      return 'El código no tiene el formato XXXX-XXXX.';
    case 'code_not_found':
      return 'El código no existe, ya se usó o venció (dura 10 minutos). Pide uno nuevo en el navegador.';
    case 'too_many_attempts':
      return 'Demasiados intentos seguidos. Espera un minuto y vuelve a intentar.';
    case 'missing_token':
    case 'github_token_invalid':
      return 'GitHub no aceptó el permiso de VS Code. Vuelve a intentarlo y pulsa «Permitir».';
    case 'github_login_not_linked':
      return 'Conecta tu cuenta de GitHub en ADACEEN (overlay del navegador) y vuelve a intentar.';
    case 'staff_requires_code':
      // El comienzo es el del backend (STAFF_REQUIRES_CODE_MESSAGE), que cita la guia; el resto
      // nombra los botones de hoy (el backend cita la opcion de la 0.0.31, «Tengo un codigo del navegador»).
      return 'Las cuentas de docente y administrador se vinculan con un codigo del navegador: en el overlay pulsa «Copiar codigo para VS Code» (o «Abrir en VS Code de este equipo» en la Mac) y aquí elige «Tengo un código o sesión».';
    case 'backend_outdated':
      return `El backend${where} todavía no permite conectar VS Code así. Usa «Tengo un código o sesión» con el ID de sesión que copia el navegador.`;
    case 'network':
      return `No se pudo contactar al backend${where}. Revisa tu conexión y vuelve a intentar.`;
    default:
      return `El backend${where} no pudo conectar VS Code. Vuelve a intentar en un momento.`;
  }
}

/**
 * Respuesta de POST /api/auth/editor/claim o /api/auth/editor/github:
 *   200 { ok, sessionId, expiresAt, user: { displayName, email }, githubLogin? }
 *   4xx { ok:false, error, message? }
 * Un 404 sin codigo de error es un backend anterior a la ruta.
 */
export function interpretClaimResponse(
  status: number,
  body: unknown,
  context: { backendUrl: string; label: EditorSessionLabel },
): EditorClaimResult {
  const data = isPlainObject(body) ? body : {};
  const errorCode = cleanText(data.error, 80);
  if (status >= 200 && status < 300 && data.ok !== false) {
    const sessionId = rawSessionId(data.sessionId);
    const expiresAt = parseExpiresAt(data.expiresAt);
    if (!isSafeSessionId(sessionId)) {
      return { ok: false, error: 'backend_error', message: describeClaimError('backend_error', context.backendUrl), status };
    }
    const user = isPlainObject(data.user) ? data.user : {};
    return {
      ok: true,
      githubLogin: cleanText(data.githubLogin, 80),
      session: {
        sessionId,
        backendUrl: cleanBackendUrl(context.backendUrl),
        expiresAt: Number.isNaN(expiresAt) ? null : expiresAt,
        userName: cleanText(user.displayName),
        userEmail: cleanText(user.email),
        label: context.label,
      },
    };
  }
  if (errorCode === 'github_login_not_linked' && cleanText(data.reason, 80) === 'staff_requires_code') {
    // Docente o administrador: GitHub no vale, solo el codigo del navegador. Texto local, que
    // no depende de la version del backend y nombra la opcion que existe en este VS Code.
    return { ok: false, error: 'staff_requires_code', message: describeClaimError('staff_requires_code'), status };
  }
  if (CLAIM_ERRORS.has(errorCode)) {
    const error = errorCode as EditorClaimError;
    const message = error === 'github_login_not_linked' && cleanText(data.message, 400)
      ? cleanText(data.message, 400)
      : describeClaimError(error, context.backendUrl);
    return { ok: false, error, message, status };
  }
  if (status === 429) {
    return { ok: false, error: 'too_many_attempts', message: describeClaimError('too_many_attempts'), status };
  }
  if (status === 404 || status === 405) {
    return { ok: false, error: 'backend_outdated', message: describeClaimError('backend_outdated', context.backendUrl), status };
  }
  return { ok: false, error: 'backend_error', message: describeClaimError('backend_error', context.backendUrl), status };
}

export type HttpFetch = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}>;

async function requestJson(
  fetchImpl: HttpFetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text().catch(() => '');
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    let sessionHeader = '';
    try {
      sessionHeader = String(response.headers?.get(SESSION_STATUS_HEADER) ?? '').trim().toLowerCase();
    } catch {
      sessionHeader = '';
    }
    return { status: response.status, data, sessionHeader };
  } finally {
    clearTimeout(timer);
  }
}

/** Canjea un codigo o el token de GitHub. Nunca lanza. */
export async function requestEditorClaim(
  fetchImpl: HttpFetch,
  input: {
    kind: EditorClaimKind;
    baseUrl: string;
    body: Record<string, unknown>;
    headers?: Record<string, string>;
    label: EditorSessionLabel;
    timeoutMs?: number;
  },
): Promise<EditorClaimResult> {
  const baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    return { ok: false, error: 'network', message: 'No hay backend configurado (adaceen.backend.baseUrl).', status: 0 };
  }
  try {
    const { status, data } = await requestJson(
      fetchImpl,
      `${baseUrl}${EDITOR_CLAIM_PATHS[input.kind]}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...(input.headers || {}) },
        body: JSON.stringify(input.body),
      },
      input.timeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS,
    );
    return interpretClaimResponse(status, data, { backendUrl: baseUrl, label: input.label });
  } catch {
    return { ok: false, error: 'network', message: describeClaimError('network', baseUrl), status: 0 };
  }
}

export type SessionCheck =
  | { status: 'ok'; userName: string; userEmail: string }
  | { status: 'invalid' }
  | { status: 'unknown' };

/**
 * GET /api/auth/me con la sesion: 200 da el nombre; 401 (o la cabecera
 * x-adaceen-session: invalid) quiere decir que la sesion no vale. Cualquier
 * otra cosa (red, 5xx) no dice nada.
 */
export function interpretSessionCheck(status: number, body: unknown, sessionHeader = ''): SessionCheck {
  if (sessionHeader.trim().toLowerCase() === 'invalid' || status === 401) {
    return { status: 'invalid' };
  }
  const data = isPlainObject(body) ? body : {};
  if (status === 200 && data.ok !== false) {
    const session = isPlainObject(data.session) ? data.session : {};
    const user = isPlainObject(session.user) ? session.user : {};
    return { status: 'ok', userName: cleanText(user.displayName), userEmail: cleanText(user.email) };
  }
  return { status: 'unknown' };
}

/** Nunca lanza. */
export async function requestSessionCheck(
  fetchImpl: HttpFetch,
  input: { baseUrl: string; headers: Record<string, string>; timeoutMs?: number },
): Promise<SessionCheck> {
  const baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    return { status: 'unknown' };
  }
  try {
    const { status, data, sessionHeader } = await requestJson(
      fetchImpl,
      `${baseUrl}${SESSION_CHECK_PATH}`,
      { method: 'GET', headers: input.headers },
      input.timeoutMs ?? 8000,
    );
    return interpretSessionCheck(status, data, sessionHeader);
  } catch {
    return { status: 'unknown' };
  }
}

// ---------------------------------------------------------------------------
// Estado de la sesion en esta ventana

/** superseded: un canje silencioso que termino despues de una conexion hecha a mano (se descarta). */
export type ConnectFailure = EditorClaimError | 'cancelled' | 'no_github' | 'invalid_session' | 'superseded';

export type ConnectOutcome =
  | { ok: true; session: ResolvedEditorSession }
  | { ok: false; error: ConnectFailure; message: string };

export type EditorSessionManagerDeps = {
  /** SecretStorage, solo la clave adaceen.editorSession. */
  secrets: {
    get(): PromiseLike<string | undefined>;
    store(value: string): PromiseLike<void>;
    delete(): PromiseLike<void>;
  };
  /** Texto de ~/.adaceen/editor-session.json; null si no existe o no hay disco (web). */
  readSessionFile(): Promise<string | null>;
  readSetting(): string | undefined;
  readEnv(): string | undefined;
  /** Backend ya resuelto (src/backend-url.ts). */
  backendUrl(): string;
  /** local | tunnel | codespaces | remote | web (editorHost del canje). */
  editorHost(): string;
  /**
   * Token de GitHub de VS Code: silent no pregunta nada; interactive muestra
   * «Permitir». null si no hay cuenta o el estudiante cancela. No se guarda.
   */
  getGithubToken(mode: 'silent' | 'interactive'): Promise<string | null>;
  claim(kind: EditorClaimKind, body: Record<string, unknown>, label: EditorSessionLabel): Promise<EditorClaimResult>;
  /** GET /api/auth/me (opcional): nombre del estudiante y sesiones muertas al arrancar. */
  checkSession?(sessionId: string): Promise<SessionCheck>;
  /**
   * Marca EDITOR_UNLINKED_STORAGE_KEY (globalState, compartida por las
   * ventanas del equipo). Sin ella, siempre se permite GitHub en silencio.
   */
  unlinkedMark?: {
    get(): boolean;
    set(value: boolean): PromiseLike<void> | void;
  };
  /**
   * false: no mandar en silencio el token de GitHub (adaceen.backend.baseUrl
   * lo fija el espacio de trabajo abierto, que puede ser un repo ajeno).
   */
  silentGithubAllowed?(): boolean;
  /** Espera maxima a SecretStorage antes de seguir sin la sesion guardada (pruebas). */
  secretReadTimeoutMs?: number;
  now?(): number;
  log?(line: string): void;
  /** Cambio la sesion resuelta; idChanged = cambio el x-session-id que se envia. */
  onDidChange?(session: ResolvedEditorSession | null, idChanged: boolean): void;
  /**
   * La sesion dejo de valer (rechazada o vencida) y no queda otra (a lo sumo
   * una vez por ventana). lost: la que se perdio.
   */
  onSessionLost?(lost: ResolvedEditorSession | null): void;
};

class SecretReadTimeout extends Error {}

/** Rechaza con SecretReadTimeout si la promesa no termina en `ms`. */
function withTimeout<T>(promise: PromiseLike<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SecretReadTimeout(message)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class EditorSessionManager {
  private secret: EditorSessionRecord | null = null;
  private secretSavedAt: number | null = null;
  private file: EditorSessionRecord | null = null;
  private fileWrittenAt: number | null = null;
  private lastFileText: string | null | undefined = undefined;
  /** Sesiones que el backend rechazo en esta ventana (solo en memoria). */
  private readonly ignored = new Set<string>();
  /** Nombre aprendido con /api/auth/me para sesiones que no lo traen. */
  private readonly names = new Map<string, { userName: string; userEmail: string }>();
  private readonly checked = new Set<string>();
  private recovering: Promise<void> | null = null;
  private lostWarned = false;
  private lastEmitted: { id: string; key: string; session: ResolvedEditorSession | null } | null = null;
  /**
   * Sube con cada conexion hecha a mano y con «Desconectar»: un canje
   * silencioso con GitHub que termina despues se descarta, no pisa esa sesion.
   */
  private explicitGeneration = 0;
  /**
   * Lecturas de SecretStorage iniciadas y cambios hechos aqui a la sesion
   * guardada: solo se aplica la lectura mas reciente, y no si mientras tanto
   * se conecto o se olvido la sesion en esta ventana.
   */
  private secretReads = 0;
  private secretWrites = 0;
  /** Lectura de SecretStorage que no contesto a tiempo; se aplica cuando conteste. */
  private secretPending: Promise<void> | null = null;

  constructor(private readonly deps: EditorSessionManagerDeps) {}

  private now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private log(line: string) {
    try {
      this.deps.log?.(line);
    } catch {
      // Canal cerrado: se descarta la linea.
    }
  }

  /** Lee SecretStorage y el archivo del tunel. Nunca lanza. */
  async initialize() {
    await Promise.all([this.reloadSecret(false), this.reloadFile(false)]);
    const session = this.current();
    this.log(session
      ? `[Sesion] Sesion desde ${describeSessionOrigin(session)}.`
      : '[Sesion] Sin sesion guardada en este equipo.');
    this.emitIfChanged();
  }

  /** Sesion resuelta ahora mismo (sincrono: la usan todas las peticiones). */
  current(): ResolvedEditorSession | null {
    let setting: string | undefined;
    let env: string | undefined;
    try {
      setting = this.deps.readSetting();
      env = this.deps.readEnv();
    } catch {
      setting = undefined;
    }
    let backendUrl = '';
    let preferNewerFile = false;
    try {
      backendUrl = this.deps.backendUrl();
      preferNewerFile = this.deps.editorHost() === 'tunnel';
    } catch {
      // Sin backend resuelto no se filtra por backend.
    }
    const session = resolveEditorSession(
      {
        secret: this.secret,
        secretSavedAt: this.secretSavedAt,
        file: this.file,
        fileWrittenAt: this.fileWrittenAt,
        setting,
        env,
      },
      { ignored: this.ignored, now: this.now(), backendUrl, preferNewerFile },
    );
    if (!session) {
      return null;
    }
    const known = this.names.get(session.sessionId);
    if (known && !session.userName && !session.userEmail) {
      return { ...session, ...known };
    }
    return session;
  }

  currentSessionId() {
    return this.current()?.sessionId ?? '';
  }

  /** Avisa a quien escucha si cambio la sesion (ajuste editado, otro backend...). */
  refresh() {
    this.emitIfChanged();
  }

  async reloadSecret(emit = true) {
    const read = ++this.secretReads;
    const writes = this.secretWrites;
    let pending: Promise<string | undefined> | null = null;
    let text: string | undefined;
    try {
      pending = Promise.resolve(this.deps.secrets.get());
      text = await withTimeout(pending, this.deps.secretReadTimeoutMs ?? SECRET_READ_TIMEOUT_MS, 'SecretStorage no respondio');
    } catch (error) {
      // Sin llavero se sigue con lo que habia en memoria.
      this.log(`[Sesion] No se pudo leer la sesion guardada: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof SecretReadTimeout && pending) {
        // Llavero lento (Mac tras actualizar, gnome-keyring colgado): la sesion
        // guardada se aplica cuando conteste, en vez de ignorarla toda la ventana.
        const late: Promise<void> = pending.then(
          (value) => this.applySecret(value, read, writes, true),
          () => undefined,
        ).catch(() => undefined).finally(() => {
          if (this.secretPending === late) {
            this.secretPending = null;
          }
        });
        this.secretPending = late;
      }
      return;
    }
    await this.applySecret(text, read, writes, emit);
  }

  private async applySecret(text: string | undefined, read: number, writes: number, emit: boolean) {
    if (read !== this.secretReads || writes !== this.secretWrites) {
      // Una lectura mas reciente o una conexion hecha aqui ya decidieron.
      return;
    }
    if (!text) {
      this.secret = null;
      this.secretSavedAt = null;
    } else {
      const parsed = parseStoredEditorSession(text, this.now());
      this.secret = parsed.ok ? parsed.session : null;
      this.secretSavedAt = parsed.ok ? parsed.writtenAt : null;
      if (!parsed.ok) {
        this.log(`[Sesion] Se descarta la sesion guardada: ${describeSessionDocumentProblem(parsed.problem)}.`);
        await this.deleteSecretQuietly();
      }
    }
    if (emit) {
      this.emitIfChanged();
    }
  }

  /** Relee ~/.adaceen/editor-session.json. true si su contenido cambio. */
  async reloadFile(emit = true) {
    let text: string | null;
    try {
      text = await this.deps.readSessionFile();
    } catch {
      text = null;
    }
    if (text === this.lastFileText) {
      return false;
    }
    const hadFile = Boolean(this.file);
    this.lastFileText = text;
    if (text === null) {
      this.file = null;
      this.fileWrittenAt = null;
      if (hadFile) {
        this.log('[Sesion] Ya no esta el archivo de sesion del tunel.');
      }
    } else {
      const parsed = parseEditorSessionFile(text, this.now());
      this.file = parsed.ok ? parsed.session : null;
      this.fileWrittenAt = parsed.ok ? parsed.writtenAt : null;
      if (parsed.ok) {
        const note = this.ignored.has(parsed.session.sessionId) ? ' (es la que el backend ya rechazo)' : '';
        this.log(`[Sesion] Archivo de sesion del tunel leido${note}.`);
      } else {
        this.log(`[Sesion] Se ignora ~/.adaceen/editor-session.json: ${describeSessionDocumentProblem(parsed.problem)}.`);
      }
    }
    if (emit) {
      this.emitIfChanged();
    }
    return true;
  }

  /**
   * Revision periodica (cada 20 s): relee el archivo del tunel y detecta la
   * sesion que vence con la ventana abierta. Esa deja de enviarse sin que el
   * backend la rechace, asi que nadie mas avisaria. Nunca lanza.
   */
  async poll() {
    try {
      const before = this.lastEmitted?.session ?? null;
      await this.reloadFile();
      if (!before || !isSessionExpired(before, this.now())) {
        return;
      }
      this.emitIfChanged();
      const remaining = this.current();
      if (remaining?.sessionId === before.sessionId) {
        return;
      }
      this.log(`[Sesion] Vencio la sesion (${describeSessionOrigin(before)}).`);
      if (!remaining) {
        this.notifyLost(before);
      }
    } catch (error) {
      this.log(`[Sesion] Error al revisar la sesion: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Tras activar: comprueba la sesion que hay (nombre y si sigue viva) o, sin
   * sesion, intenta GitHub en silencio. Nunca lanza.
   */
  async startup() {
    try {
      let session = this.current();
      if (!session && this.secretPending) {
        // Sin la respuesta del llavero no se sabe si hay sesion: no se conecta otra encima.
        this.log('[Sesion] Esperando al llavero de VS Code antes de conectar.');
        await this.secretPending;
        session = this.current();
      }
      if (session) {
        await this.verify(session);
        return;
      }
      if (this.isUnlinked()) {
        this.log('[Sesion] Sin conectar: en este equipo se cerro sesion o se desconecto VS Code. Usa «ADACEEN: Conectar» (barra de estado) o el boton del navegador.');
        return;
      }
      if (!(await this.trySilentGithub())) {
        this.log('[Sesion] Sin conectar: usa «ADACEEN: Conectar» (barra de estado) para que tus eventos queden a tu nombre.');
      }
    } catch (error) {
      this.log(`[Sesion] Error al revisar la sesion: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Espera a que termine una recuperacion en curso (pruebas y comandos). */
  async whenIdle() {
    while (this.recovering) {
      await this.recovering;
    }
  }

  /**
   * El backend respondio x-adaceen-session: invalid a una peticion que llevaba
   * esta sesion. Solo reacciona si es la sesion en uso; las repetidas (varias
   * peticiones en vuelo con la misma sesion) se ignoran.
   */
  reportInvalid(sessionId: string) {
    const clean = String(sessionId || '').trim();
    if (!clean || this.ignored.has(clean)) {
      return;
    }
    const lost = this.current();
    this.ignored.add(clean);
    if (!lost || lost.sessionId !== clean) {
      this.emitIfChanged();
      return;
    }
    const previous = this.recovering ?? Promise.resolve();
    const run = previous
      .then(() => this.recover(lost))
      .catch((error) => {
        this.log(`[Sesion] Error al recuperar la sesion: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (this.recovering === run) {
          this.recovering = null;
        }
      });
    this.recovering = run;
  }

  async connectWithGithub(mode: 'silent' | 'interactive'): Promise<ConnectOutcome> {
    // Un canje silencioso no pisa lo que se conecte mientras tanto (enlace del
    // navegador, codigo, sesion pegada, archivo del tunel u otra ventana).
    const generation = this.explicitGeneration;
    const superseded = () => mode === 'silent' && (generation !== this.explicitGeneration || this.current() !== null);
    let token: string | null;
    try {
      token = await this.deps.getGithubToken(mode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return mode === 'silent'
        ? { ok: false, error: 'no_github', message }
        : { ok: false, error: 'cancelled', message };
    }
    if (!token) {
      return mode === 'silent'
        ? { ok: false, error: 'no_github', message: 'VS Code no tiene permiso de GitHub para ADACEEN.' }
        : { ok: false, error: 'cancelled', message: 'No se autorizó GitHub.' };
    }
    if (superseded()) {
      return { ok: false, error: 'superseded', message: 'VS Code ya se conectó de otra forma.' };
    }
    const result = await this.deps.claim('github', { githubToken: token, editorHost: this.deps.editorHost() }, 'github');
    if (!result.ok) {
      return { ok: false, error: result.error, message: result.message };
    }
    if (superseded()) {
      // No se guarda: la sesion creada en el backend vence sola.
      return { ok: false, error: 'superseded', message: 'VS Code ya se conectó de otra forma.' };
    }
    return { ok: true, session: await this.adopt(result.session, mode === 'interactive') };
  }

  /** Canjea un codigo XXXX-XXXX del navegador (label codigo o vscode-local). */
  async connectWithCode(code: string, label: EditorSessionLabel = 'codigo'): Promise<ConnectOutcome> {
    const normalized = normalizePairingCode(code);
    if (!normalized) {
      return { ok: false, error: 'invalid_code', message: describeClaimError('invalid_code') };
    }
    const result = await this.deps.claim('code', { code: normalized, editorHost: this.deps.editorHost(), label }, label);
    if (!result.ok) {
      return { ok: false, error: result.error, message: result.message };
    }
    return { ok: true, session: await this.adopt(result.session, true) };
  }

  /**
   * Sesion pegada (UUID de «Copiar sesion»). Se comprueba con /api/auth/me:
   * si el backend dice que ya no vale, no se guarda.
   */
  async connectWithSessionId(sessionId: string): Promise<ConnectOutcome> {
    const clean = String(sessionId || '').trim();
    if (!isSafeSessionId(clean)) {
      return { ok: false, error: 'invalid_session', message: 'Eso no parece un ID de sesión de ADACEEN.' };
    }
    const record: EditorSessionRecord = {
      sessionId: clean,
      backendUrl: cleanBackendUrl(this.deps.backendUrl()),
      expiresAt: null,
      userName: '',
      userEmail: '',
      label: 'manual',
    };
    if (this.deps.checkSession) {
      const check = await this.deps.checkSession(clean);
      if (check.status === 'invalid') {
        return {
          ok: false,
          error: 'invalid_session',
          message: 'Esa sesión ya no es válida (el navegador la cerró o es de otro servidor). Pide un código en el navegador.',
        };
      }
      if (check.status === 'ok') {
        record.userName = check.userName;
        record.userEmail = check.userEmail;
        this.checked.add(clean);
      }
    }
    return { ok: true, session: await this.adopt(record, true) };
  }

  /**
   * «Desconectar»: olvida la sesion emparejada de este equipo (SecretStorage)
   * y no vuelve a conectar en silencio hasta una conexion hecha a mano. El
   * archivo del tunel y el ajuste heredado no se tocan. Devuelve la sesion que
   * queda (null si ninguna).
   */
  async disconnect(): Promise<ResolvedEditorSession | null> {
    this.explicitGeneration += 1;
    this.secretWrites += 1;
    const hadSecret = Boolean(this.secret);
    this.secret = null;
    this.secretSavedAt = null;
    await this.setUnlinked(true);
    await this.deleteSecretQuietly();
    this.log(hadSecret
      ? '[Sesion] Desconectado: se olvido la sesion guardada en este equipo.'
      : '[Sesion] Desconectar: no habia sesion guardada en este equipo.');
    this.emitIfChanged();
    return this.current();
  }

  // -------------------------------------------------------------------------

  private async adopt(record: EditorSessionRecord, explicit: boolean): Promise<ResolvedEditorSession> {
    const now = this.now();
    this.secret = record;
    this.secretSavedAt = now;
    this.secretWrites += 1;
    this.ignored.delete(record.sessionId);
    this.checked.add(record.sessionId);
    if (explicit) {
      this.explicitGeneration += 1;
      // Una conexion hecha a mano abre otro episodio: si vuelve a caerse, se avisa otra vez.
      this.lostWarned = false;
      await this.setUnlinked(false);
    }
    try {
      await this.deps.secrets.store(serializeStoredEditorSession(record, now));
    } catch (error) {
      this.log(`[Sesion] No se pudo guardar la sesion en el llavero de VS Code (vale solo para esta ventana): ${error instanceof Error ? error.message : String(error)}`);
    }
    this.log(`[Sesion] Conectado (${describeSessionOrigin({ source: 'secret', label: record.label })}).`);
    this.emitIfChanged();
    return { ...record, source: 'secret' };
  }

  private async deleteSecretQuietly() {
    try {
      await this.deps.secrets.delete();
    } catch {
      // Sin llavero: basta con olvidarla en memoria.
    }
  }

  private isUnlinked() {
    try {
      return Boolean(this.deps.unlinkedMark?.get());
    } catch {
      return false;
    }
  }

  private async setUnlinked(value: boolean) {
    if (!this.deps.unlinkedMark || this.isUnlinked() === value) {
      return;
    }
    try {
      await this.deps.unlinkedMark.set(value);
    } catch {
      // Solo afecta a GitHub en silencio al arrancar.
    }
  }

  private async verify(session: ResolvedEditorSession) {
    if (!this.deps.checkSession || this.checked.has(session.sessionId)) {
      return;
    }
    this.checked.add(session.sessionId);
    const check = await this.deps.checkSession(session.sessionId);
    if (check.status === 'invalid') {
      this.reportInvalid(session.sessionId);
      await this.whenIdle();
      return;
    }
    if (check.status === 'ok' && (check.userName || check.userEmail)) {
      this.names.set(session.sessionId, { userName: check.userName, userEmail: check.userEmail });
      this.emitIfChanged();
    }
  }

  /** Solo al arrancar sin sesion y sin la marca de desvinculado (startup). */
  private async trySilentGithub() {
    let allowed = true;
    try {
      allowed = this.deps.silentGithubAllowed ? this.deps.silentGithubAllowed() : true;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      this.log('[Sesion] No se prueba GitHub en silencio: adaceen.backend.baseUrl lo fija el espacio de trabajo abierto.');
      return false;
    }
    const outcome = await this.connectWithGithub('silent');
    if (outcome.ok) {
      this.log('[Sesion] Conectado sin clics con la cuenta de GitHub de VS Code.');
      return true;
    }
    if (outcome.error === 'superseded') {
      this.log('[Sesion] Se descarta el canje silencioso con GitHub: VS Code ya se conecto de otra forma.');
      return true;
    }
    if (outcome.error !== 'no_github') {
      this.log(`[Sesion] GitHub en silencio no conecto: ${outcome.message}`);
    }
    return false;
  }

  private async recover(lost: ResolvedEditorSession) {
    this.log(`[Sesion] El backend rechazo la sesion (${describeSessionOrigin(lost)}); se olvida.`);
    if (lost.source === 'secret' && this.secret?.sessionId === lost.sessionId) {
      // Una sesion de otro backend (p. ej. produccion mientras corre el local)
      // puede seguir valiendo alla: solo se olvida en esta ventana.
      const sameBackend = !lost.backendUrl || sameBackendUrl(lost.backendUrl, this.deps.backendUrl());
      if (sameBackend) {
        this.secret = null;
        this.secretSavedAt = null;
        this.secretWrites += 1;
        await this.deleteSecretQuietly();
      }
    }
    // Un rechazo suele ser un «Salir» en el navegador, que desvincula tambien
    // VS Code: no se vuelve a conectar en silencio con la cuenta de GitHub que
    // tenga VS Code (en un equipo compartido puede ser de otro estudiante).
    await this.setUnlinked(true);
    // El tunel pudo escribir una sesion nueva (otro «Abrir mi editor»).
    await this.reloadFile(false);
    this.emitIfChanged();
    if (!this.current()) {
      this.notifyLost(lost);
    }
  }

  private notifyLost(lost: ResolvedEditorSession | null) {
    if (this.lostWarned) {
      return;
    }
    this.lostWarned = true;
    try {
      this.deps.onSessionLost?.(lost);
    } catch {
      // El aviso es cosmetico.
    }
  }

  private emitIfChanged() {
    const session = this.current();
    const id = session?.sessionId ?? '';
    const key = session ? `${id}|${session.source}|${session.userName}|${session.userEmail}` : '';
    if (this.lastEmitted && this.lastEmitted.key === key) {
      return;
    }
    const idChanged = !this.lastEmitted || this.lastEmitted.id !== id;
    this.lastEmitted = { id, key, session };
    try {
      this.deps.onDidChange?.(session, idChanged);
    } catch {
      // Quien escucha no debe romper la resolucion.
    }
  }
}
