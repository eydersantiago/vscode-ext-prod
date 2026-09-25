/**
 * Identidad del cliente frente al backend ADACEEN.
 *
 * Sin sesion (lo habitual en el piloto) el backend reconoce al estudiante por
 * la cabecera x-adaceen-client-id: un id aleatorio que se genera una sola vez
 * y queda guardado en globalState. Si ademas hay sesion compartida se manda
 * x-session-id, y en el backend gana la sesion.
 *
 * Lo usan TODAS las llamadas al backend (sugerencias, metricas, apply-check,
 * indicador de GPU, worker y quiz). La clave de almacenamiento es la que ya
 * usaba la vista de quiz, asi que los estudiantes conservan su id.
 *
 * Este modulo no importa vscode: solo necesita algo con get/update (un
 * Memento), para poder probarlo con node:test.
 */

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

const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

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

let activeClientId = '';

/** Se llama una vez al activar la extension, antes de cualquier llamada al backend. */
export function initClientIdentity(store: ClientIdStore): string {
  activeClientId = getOrCreateClientId(store);
  return activeClientId;
}

/** Id de esta instalacion ('' si todavia no se inicializo). */
export function currentClientId(): string {
  return activeClientId;
}

/**
 * Cabeceras de identidad para el backend: x-adaceen-client-id siempre que
 * haya un id valido y x-session-id cuando exista sesion.
 */
export function buildIdentityHeaders(sessionId = '', clientId: string = activeClientId): Record<string, string> {
  const headers: Record<string, string> = {};
  if (isValidClientId(clientId)) {
    headers[CLIENT_ID_HEADER] = clientId;
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
