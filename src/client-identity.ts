/**
 * Identidad del cliente frente al backend ADACEEN.
 *
 * Sin sesion (lo habitual en el piloto) el backend reconoce al estudiante por
 * la cabecera x-adaceen-client-id: un id aleatorio que se genera una sola vez
 * y queda guardado en globalState. Si ademas hay sesion compartida se manda
 * x-session-id, y en el backend gana la sesion.
 *
 * Desde la 0.0.37 cada llamada dice tambien que version de ADACEEN es esta
 * (x-adaceen-client-version) y donde corre el editor (x-adaceen-editor-host):
 * con eso el backend sabe que extension tiene el VS Code de cada estudiante en
 * cada tipo de editor, y la guia del navegador comprueba que en el tunel este
 * la ultima. Las tres se fijan una vez, en initClientIdentity.
 *
 * Lo usan TODAS las llamadas al backend (sugerencias, metricas, apply-check,
 * indicador de GPU, worker y quiz). La clave de almacenamiento es la que ya
 * usaba la vista de quiz, asi que los estudiantes conservan su id.
 *
 * Este modulo no importa vscode: solo necesita algo con get/update (un
 * Memento), para poder probarlo con node:test.
 */

import { isEditorHost } from './backend-url';
import type { EditorHost } from './backend-url';

/** Clave historica en globalState (la creo la vista de quiz en la 0.0.26). */
export const CLIENT_ID_STORAGE_KEY = 'adaceen.quiz.clientId';
export const CLIENT_ID_HEADER = 'x-adaceen-client-id';
export const SESSION_ID_HEADER = 'x-session-id';
/**
 * Con la que el backend avisa que el x-session-id enviado es invalido, esta
 * inactivo o vencio (valor "invalid"). Contrato: docs/arquitectura/acceso-simplificado.md.
 */
export const SESSION_STATUS_HEADER = 'x-adaceen-session';
/** Mismo patron que valida el backend. */
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
/** Version de esta extension (la del package.json), como x-adaceen-client-id: del cliente. */
export const CLIENT_VERSION_HEADER = 'x-adaceen-client-version';
/** Donde corre el editor: local, tunnel, codespaces o remote (detectEditorHost). */
export const EDITOR_HOST_HEADER = 'x-adaceen-editor-host';
const CLIENT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Version x.y.z del package.json, o null si no lo es (y entonces no se manda). */
export function cleanClientVersion(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return CLIENT_VERSION_PATTERN.test(text) ? text : null;
}

export type ClientIdStore = {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
};

export function randomToken(length: number, random: () => number = Math.random) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += TOKEN_ALPHABET[Math.floor(random() * TOKEN_ALPHABET.length) % TOKEN_ALPHABET.length];
  }
  return out;
}

export function isValidClientId(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_ID_PATTERN.test(value);
}

/** Mismo formato que generaba la vista de quiz: "vsc" + 24 caracteres. */
export function generateClientId(random: () => number = Math.random) {
  return `vsc${randomToken(24, random)}`;
}

/**
 * Devuelve el id guardado o crea uno nuevo y lo persiste. Un valor invalido
 * guardado (vacio, corrupto) se reemplaza.
 */
export function getOrCreateClientId(store: ClientIdStore, random: () => number = Math.random): string {
  const stored = store.get<string>(CLIENT_ID_STORAGE_KEY);
  if (isValidClientId(stored)) {
    return stored;
  }
  const id = generateClientId(random);
  try {
    void Promise.resolve(store.update(CLIENT_ID_STORAGE_KEY, id)).catch(() => undefined);
  } catch {
    // Sin almacenamiento se sigue con el id en memoria durante esta activacion.
  }
  return id;
}

export type ClientIdentityOptions = {
  /** Version del package.json; si no es x.y.z, la llamada no lleva x-adaceen-client-version. */
  extensionVersion?: unknown;
  /** Donde corre el editor (detectEditorHost); sin valor valido no se manda x-adaceen-editor-host. */
  editorHost?: unknown;
};

/** Lo que se acepto al activar: null en lo que no traia un valor valido (y no se manda). */
export type ClientIdentity = { clientId: string; extensionVersion: string | null; editorHost: EditorHost | null };

let activeIdentity: ClientIdentity = { clientId: '', extensionVersion: null, editorHost: null };

/**
 * Se llama una vez al activar la extension, antes de cualquier llamada al backend. Devuelve lo
 * que quedo fijado: quien llama ve si la version o el tipo de editor no se aceptaron.
 */
export function initClientIdentity(store: ClientIdStore, options: ClientIdentityOptions = {}): ClientIdentity {
  activeIdentity = {
    clientId: getOrCreateClientId(store),
    extensionVersion: cleanClientVersion(options.extensionVersion),
    editorHost: isEditorHost(options.editorHost) ? options.editorHost : null,
  };
  return { ...activeIdentity };
}

/** Id de esta instalacion ('' si todavia no se inicializo). */
export function currentClientId(): string {
  return activeIdentity.clientId;
}

/**
 * Cabeceras de identidad para el backend: x-adaceen-client-id siempre que haya un id valido,
 * x-adaceen-client-version y x-adaceen-editor-host con lo fijado en initClientIdentity, y
 * x-session-id cuando exista sesion.
 */
export function buildIdentityHeaders(sessionId = '', clientId: string = activeIdentity.clientId): Record<string, string> {
  const headers: Record<string, string> = {};
  if (isValidClientId(clientId)) {
    headers[CLIENT_ID_HEADER] = clientId;
  }
  if (activeIdentity.extensionVersion) {
    headers[CLIENT_VERSION_HEADER] = activeIdentity.extensionVersion;
  }
  if (activeIdentity.editorHost) {
    headers[EDITOR_HOST_HEADER] = activeIdentity.editorHost;
  }
  const cleanSession = sessionId.trim();
  if (cleanSession) {
    headers[SESSION_ID_HEADER] = cleanSession;
  }
  return headers;
}

type HeaderSource = { get(name: string): string | null } | Record<string, unknown> | null | undefined;

function readHeader(headers: HeaderSource, name: string): string {
  if (!headers) {
    return '';
  }
  try {
    if (typeof (headers as { get?: unknown }).get === 'function') {
      return String((headers as { get(name: string): string | null }).get(name) ?? '').trim();
    }
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === wanted && typeof value === 'string') {
        return value.trim();
      }
    }
  } catch {
    return '';
  }
  return '';
}

/**
 * Si la respuesta trae x-adaceen-session: invalid, devuelve el x-session-id
 * que se envio en la peticion (para olvidarlo); si no, ''.
 */
export function rejectedSessionId(sentHeaders: HeaderSource, responseHeaders: HeaderSource): string {
  if (readHeader(responseHeaders, SESSION_STATUS_HEADER).toLowerCase() !== 'invalid') {
    return '';
  }
  return readHeader(sentHeaders, SESSION_ID_HEADER);
}
