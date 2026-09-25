/**
 * A que backend habla la extension.
 *
 * La conexion local de siempre se conserva: si hay un backend de ADACEEN
 * corriendo en esta maquina (npm run dev:local, o el rol local de las Mac del
 * laboratorio), se usa http://127.0.0.1:3000. Si no lo hay, la extension va a
 * produccion: asi VS Code instalado en las Mac del laboratorio (o en Windows)
 * funciona sin configurar nada. El orden es:
 *
 *   1. adaceen.backend.baseUrl escrito por alguien (usuario, espacio de trabajo
 *      o maquina: nuevo-tunel.sh lo fija en la VM de editores).
 *   2. Variable de entorno ADACEEN_BACKEND_URL.
 *   3. Codespaces: produccion.
 *   4. Backend local detectado en 127.0.0.1:3000: local.
 *   5. Nada de lo anterior: produccion.
 *
 * Mientras no se ha probado el backend local (null) se usa el local, como
 * antes; la extension espera la prueba al activarse, asi que casi nunca se ve.
 *
 * No importa vscode, para poder probarlo con node:test.
 */

export const LOCAL_BACKEND_BASE_URL = 'http://127.0.0.1:3000';
export const PRODUCTION_BACKEND_BASE_URL = 'https://app-adaceen-api-eyder05232002.azurewebsites.net';

export type BackendUrlSource = 'setting' | 'env' | 'codespaces' | 'local' | 'production' | 'local-sin-probar';

export type BackendUrlInput = {
  /** Valor de adaceen.backend.baseUrl escrito en algun ambito (no el valor por defecto). */
  configured?: string;
  /** ADACEEN_BACKEND_URL. */
  envUrl?: string;
  codespace: boolean;
  /** true: respondio el backend local; false: no hay; null: aun no se ha probado. */
  localBackendDetected: boolean | null;
};

function cleanUrl(value: string | undefined) {
  return String(value ?? '').trim().replace(/\/+$/, '');
}

export function resolveBackendBaseUrl(input: BackendUrlInput): { baseUrl: string; source: BackendUrlSource } {
  const configured = cleanUrl(input.configured);
  if (configured) {
    return { baseUrl: configured, source: 'setting' };
  }
  const envUrl = cleanUrl(input.envUrl);
  if (envUrl) {
    return { baseUrl: envUrl, source: 'env' };
  }
  if (input.codespace) {
    return { baseUrl: PRODUCTION_BACKEND_BASE_URL, source: 'codespaces' };
  }
  if (input.localBackendDetected === true) {
    return { baseUrl: LOCAL_BACKEND_BASE_URL, source: 'local' };
  }
  if (input.localBackendDetected === false) {
    return { baseUrl: PRODUCTION_BACKEND_BASE_URL, source: 'production' };
  }
  return { baseUrl: LOCAL_BACKEND_BASE_URL, source: 'local-sin-probar' };
}

/** La deteccion solo tiene sentido si nadie eligio el backend y no es Codespaces. */
export function needsLocalBackendProbe(input: Omit<BackendUrlInput, 'localBackendDetected'>) {
  return !cleanUrl(input.configured) && !cleanUrl(input.envUrl) && !input.codespace;
}

export function describeBackendUrlSource(source: BackendUrlSource) {
  switch (source) {
    case 'setting':
      return 'ajuste adaceen.backend.baseUrl';
    case 'env':
      return 'variable ADACEEN_BACKEND_URL';
    case 'codespaces':
      return 'produccion (Codespaces)';
    case 'local':
      return 'backend local detectado en esta maquina';
    case 'production':
      return 'produccion (no hay backend local)';
    default:
      return 'backend local (sin comprobar)';
  }
}

/**
 * Respuesta de GET /health de ADACEEN: { ok: true, mode, database_provider, ... }.
 * Evita confundirlo con otra aplicacion del estudiante que use el puerto 3000.
 */
export function isAdaceenHealth(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return false;
  }
  const record = body as Record<string, unknown>;
  return record.ok === true && typeof record.mode === 'string' && 'database_provider' in record;
}

type FetchLike = (url: string, init: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Nunca lanza: cualquier fallo (nada escucha, otra aplicacion, tiempo agotado) es "no hay". */
export async function probeLocalBackend(
  fetchImpl: FetchLike,
  baseUrl = LOCAL_BACKEND_BASE_URL,
  timeoutMs = 800,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${cleanUrl(baseUrl)}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      return false;
    }
    return isAdaceenHealth(await response.json());
  } catch {
    return false;
  }
}

/**
 * Donde corre el editor, para la telemetria (metadata.editorHost):
 *   local       VS Code instalado en el equipo (por ejemplo una Mac del laboratorio)
 *   tunnel      VS Code Tunnels (vscode.dev o VS Code conectado a un tunel)
 *   codespaces  GitHub Codespaces
 *   remote      otro remoto (SSH, WSL, contenedor)
 */
export type EditorHost = 'local' | 'tunnel' | 'codespaces' | 'remote';

export function detectEditorHost(input: { remoteName?: string | null; codespace: boolean }): EditorHost {
  if (input.codespace) {
    return 'codespaces';
  }
  const remote = String(input.remoteName ?? '').trim().toLowerCase();
  if (!remote) {
    return 'local';
  }
  if (remote === 'tunnel' || remote.startsWith('tunnel')) {
    return 'tunnel';
  }
  return 'remote';
}
