// ADACEEN (VS Code): registro de la sesion del editor: lectura del archivo y de SecretStorage, que sesion se usa y como se describe.
// Movido sin cambios desde src/editor-session.ts (solo se agrego "export" y los imports).

export const EDITOR_SESSION_FILE_VERSION = 1;
/** El archivo real pesa unos 300 bytes; algo mucho mayor no es nuestro. */
export const EDITOR_SESSION_FILE_MAX_BYTES = 64 * 1024;

/** Va en una cabecera HTTP: nada de espacios ni saltos de linea. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{8,200}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function cleanText(value: unknown, maxChars = TEXT_FIELD_MAX_CHARS) {
  return typeof value === 'string' ? value.trim().slice(0, maxChars) : '';
}

/** Sin recortar: un id demasiado largo tiene que fallar la validacion, no acortarse. */
export function rawSessionId(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isSafeSessionId(value: unknown): boolean {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

export function isLegacySessionUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_PATTERN.test(value.trim());
}

/** Solo http(s); cualquier otra cosa se descarta (el campo es informativo). */
export function cleanBackendUrl(value: unknown) {
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
export function parseExpiresAt(value: unknown): number | null {
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

/**
 * Lo que dice la barra de estado sin sesion. Contrato con el navegador (0.8.4): en vscode.dev la
 * guia del tunel (readVscodeStatusBarAdaceen, browser-ext-prod/services/tunnel-entry-guide.service.js)
 * busca un item con «ADACEEN» y «sin conectar» para decir «la extension esta, pero sin conectar
 * a tu cuenta» y senalar este boton. Si cambia, hay que cambiar tambien esa busqueda.
 */
export const SESSION_STATUS_UNCONNECTED_TEXT = 'ADACEEN: sin conectar';

/** Texto y tooltip de la barra de estado de la sesion. */
export function describeSessionStatus(session: ResolvedEditorSession | null) {
  if (!session) {
    return {
      connected: false,
      text: `$(debug-disconnect) ${SESSION_STATUS_UNCONNECTED_TEXT}`,
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
