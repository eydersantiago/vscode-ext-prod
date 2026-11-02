// ADACEEN (VS Code): canje de la sesion del editor con el backend (codigo, GitHub, sesion pegada) y comprobacion de una sesion.
// Movido sin cambios desde src/editor-session.ts (solo se agrego "export" y los imports).
import { SESSION_STATUS_HEADER } from './client-identity';
import { isPlainObject, cleanText, rawSessionId, parseExpiresAt, isSafeSessionId, cleanBackendUrl } from './editor-session-records';
import type { EditorSessionRecord, EditorSessionLabel } from './editor-session-records';

export const EDITOR_CLAIM_PATHS = {
  code: '/api/auth/editor/claim',
  github: '/api/auth/editor/github',
} as const;
export const SESSION_CHECK_PATH = '/api/auth/me';

const DEFAULT_CLAIM_TIMEOUT_MS = 15000;

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
