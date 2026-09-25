import { normalizePairingCode, sameBackendUrl } from './editor-session';

/**
 * Enlaces del navegador a VS Code de escritorio (Mac del laboratorio),
 * docs/arquitectura/acceso-simplificado.md, seccion 3:
 *
 *   vscode://adaceen.adaceen/abrir?code=XXXX-XXXX&repo=owner/repo
 *   vscode://adaceen.adaceen/conectar?code=XXXX-XXXX
 *
 * - El codigo se canjea contra el backend YA resuelto por la extension. Un
 *   parametro backend en el enlace se ignora salvo que coincida con ese
 *   backend: asi un enlace malicioso no desvia el codigo a otro servidor.
 * - Con repo: si ya se clono en este equipo (mapa repo -> carpeta en
 *   globalState) se abre esa carpeta; si no, se pide la carpeta padre y se
 *   clona https://github.com/<owner>/<repo>.git.
 *
 * No importa vscode, para poder probarlo con node:test.
 */

export type AdaceenUriAction = 'abrir' | 'conectar';

export type AdaceenUriRequest = {
  /** null: ruta desconocida. */
  action: AdaceenUriAction | null;
  /** Codigo normalizado XXXX-XXXX. */
  code: string | null;
  /** Vino un code pero no tiene el formato. */
  codeInvalid: boolean;
  /** owner/repo (sin .git). */
  repo: string | null;
  /** Vino un repo pero no es owner/repo de GitHub. */
  repoInvalid: boolean;
  /** backend del enlace que NO coincide con el de la extension (se ignora). */
  ignoredBackend: string | null;
};

const ACTIONS: Record<string, AdaceenUriAction> = {
  abrir: 'abrir',
  open: 'abrir',
  conectar: 'conectar',
  connect: 'conectar',
};

/** Usuario u organizacion de GitHub: alfanumerico y guiones, maximo 39. */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Acepta "owner/repo" y, por comodidad, la URL del repo en GitHub. Devuelve
 * "owner/repo" o null.
 */
export function normalizeRepoParam(value: unknown): string | null {
  let text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return null;
  }
  const fromUrl = text.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i);
  if (fromUrl) {
    text = fromUrl[1];
  }
  text = text.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const parts = text.split('/');
  if (parts.length !== 2) {
    return null;
  }
  const [owner, name] = parts;
  if (!OWNER_PATTERN.test(owner) || !REPO_NAME_PATTERN.test(name) || /^\.+$/.test(name)) {
    return null;
  }
  return `${owner}/${name}`;
}

/**
 * Lee la ruta y la query de un Uri de VS Code (uri.path, uri.query).
 * resolvedBackendUrl es el backend al que ya habla la extension.
 */
export function parseAdaceenUri(uri: { path: string; query: string }, resolvedBackendUrl: string): AdaceenUriRequest {
  const route = String(uri.path || '').replace(/^\/+|\/+$/g, '').toLowerCase();
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(String(uri.query || ''));
  } catch {
    params = new URLSearchParams();
  }
  const rawCode = params.get('code');
  const code = rawCode ? normalizePairingCode(rawCode) : null;
  const rawRepo = params.get('repo');
  const repo = rawRepo ? normalizeRepoParam(rawRepo) : null;
  const rawBackend = (params.get('backend') || '').trim();
  return {
    action: ACTIONS[route] ?? null,
    code,
    codeInvalid: Boolean(rawCode && rawCode.trim()) && !code,
    repo,
    repoInvalid: Boolean(rawRepo && rawRepo.trim()) && !repo,
    ignoredBackend: rawBackend && !sameBackendUrl(rawBackend, resolvedBackendUrl) ? rawBackend.slice(0, 200) : null,
  };
}

// ---------------------------------------------------------------------------
// Enlaces de a uno: gana el ultimo

/**
 * Atiende los enlaces de a uno. Si llega otro mientras se atiende uno, no se
 * descarta: queda en espera (reemplaza al que esperaba) y se atiende al
 * terminar. Cada clic en el navegador pide un codigo NUEVO y el backend
 * invalida los anteriores sin usar, asi que el ultimo enlace es el que vale
 * (con VS Code cerrado, un doble clic entrega los dos enlaces al arrancar).
 *
 * El manejador puede preguntar hasNewer() para dejar su enlace a medias (por
 * ejemplo, no mostrar el error de un codigo que ya reemplazo el siguiente).
 */
export class LatestLinkQueue<T> {
  private busy = false;
  private waiting: { item: T } | null = null;

  constructor(
    private readonly handler: (item: T, hasNewer: () => boolean) => Promise<void>,
    /** Llego un enlace mientras se atendia otro (replaced: reemplazo a uno que esperaba). */
    private readonly onQueued?: (replaced: boolean) => void,
  ) {}

  hasNewer() {
    return this.waiting !== null;
  }

  /** Termina cuando ya no queda ningun enlace pendiente. Nunca lanza. */
  async push(item: T): Promise<void> {
    if (this.busy) {
      const replaced = this.waiting !== null;
      this.waiting = { item };
      try {
        this.onQueued?.(replaced);
      } catch {
        // Solo es un registro.
      }
      return;
    }
    this.busy = true;
    try {
      let next: { item: T } | null = { item };
      while (next) {
        this.waiting = null;
        try {
          await this.handler(next.item, () => this.hasNewer());
        } catch {
          // El manejador informa sus errores; el siguiente enlace se atiende igual.
        }
        next = this.waiting;
      }
    } finally {
      this.busy = false;
      this.waiting = null;
    }
  }
}

export function repoCloneUrl(repo: string) {
  return `https://github.com/${repo}.git`;
}

/** Nombre de la carpeta del clon: el del repositorio. */
export function repoFolderName(repo: string) {
  return repo.split('/')[1] || repo;
}

// ---------------------------------------------------------------------------
// Mapa repo -> carpeta clonada (globalState)

export const REPO_FOLDERS_STORAGE_KEY = 'adaceen.repoFolders.v1';
export const REPO_PARENT_STORAGE_KEY = 'adaceen.repoParentFolder';
const REPO_FOLDERS_MAX = 50;

export type RepoFolderMap = Record<string, string>;

export function repoFolderKey(repo: string) {
  return repo.trim().toLowerCase();
}

/** Limpia lo que venga de globalState (tipos raros o entradas vacias). */
export function readRepoFolderMap(value: unknown): RepoFolderMap {
  const map: RepoFolderMap = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return map;
  }
  for (const [key, folder] of Object.entries(value as Record<string, unknown>)) {
    const repo = normalizeRepoParam(key);
    if (repo && typeof folder === 'string' && folder.trim()) {
      map[repoFolderKey(repo)] = folder.trim();
    }
  }
  return map;
}

/** Nuevo mapa con repo -> folder al final (el mas reciente); guarda como mucho 50. */
export function withRepoFolder(map: RepoFolderMap, repo: string, folder: string): RepoFolderMap {
  const key = repoFolderKey(repo);
  const entries = Object.entries(map).filter(([existing]) => existing !== key);
  entries.push([key, folder]);
  return Object.fromEntries(entries.slice(-REPO_FOLDERS_MAX));
}

export function withoutRepoFolder(map: RepoFolderMap, repo: string): RepoFolderMap {
  const key = repoFolderKey(repo);
  return Object.fromEntries(Object.entries(map).filter(([existing]) => existing !== key));
}

// ---------------------------------------------------------------------------
// git ausente

/**
 * Como instalar git en cada sistema. En la Mac, xcode-select --install abre
 * el instalador de Apple (las herramientas de linea de comandos traen git).
 */
export function gitInstallHint(platform: string) {
  if (platform === 'darwin') {
    return {
      command: 'xcode-select --install',
      explanation: 'En la Mac, git viene con las herramientas de linea de comandos de Apple: el comando abre su instalador.',
      downloadUrl: 'https://git-scm.com/download/mac',
    };
  }
  if (platform === 'win32') {
    return {
      command: 'winget install --id Git.Git -e --source winget',
      explanation: 'En Windows se instala Git for Windows (tambien se puede descargar de git-scm.com).',
      downloadUrl: 'https://git-scm.com/download/win',
    };
  }
  return {
    command: 'sudo apt install -y git',
    explanation: 'En Linux se instala con el gestor de paquetes del sistema.',
    downloadUrl: 'https://git-scm.com/download/linux',
  };
}
