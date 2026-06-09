import * as vscode from 'vscode';

const DEFAULT_INCLUDE_GLOB =
  '**/*.{ts,tsx,js,jsx,mjs,cjs,py,java,cpp,c,h,hpp,cs,go,rs,php,rb,md,json,yml,yaml,html,css,scss,sql,xml}';

const DEFAULT_DOCUMENT_INCLUDE_GLOB =
  '**/*.{pdf,docx,txt,md,markdown,png,jpg,jpeg,webp,gif,bmp,tiff}';

const DEFAULT_EXCLUDE_GLOB =
  '**/{node_modules,.git,dist,build,out,coverage,.next,target,bin,obj,vendor,__pycache__}/**';

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_FILE_BYTES = 300 * 1024; // 300 KB por archivo
const DEFAULT_MAX_DOCUMENTS = 12;
const DEFAULT_MAX_DOCUMENT_BYTES = 1024 * 1024;
const DEFAULT_BACKEND_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_WORKER_POLL_MS = 8000;
const DEFAULT_ACTIVE_SUGGESTION_DEBOUNCE_MS = 900;
const DEFAULT_ACTIVE_SUGGESTION_MAX_CODE_CHARS = 24000;
const DEFAULT_ACTIVE_SUGGESTION_TIMEOUT_MS = 180000;
const WORKER_TICK_MS = 4000;
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'txt', 'md', 'markdown', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff']);

type ScanMode = 'auto' | 'local' | 'codespace' | 'all';

type ScannedFile = {
  path: string;
  bytes: number;
  lines: number;
  preview: string;
  content: string;
};

type ScannedDocument = {
  uri: vscode.Uri;
  path: string;
  fileName: string;
  extension: string;
  bytes: number;
};

type ScanCommandArgs = Partial<{
  mode: ScanMode | 'codespaces' | string;
  includeGlob: string;
  excludeGlob: string;
  maxFiles: number | string;
  maxFileBytes: number | string;
  maxFileKB: number | string;
  documentIncludeGlob: string;
  maxDocuments: number | string;
  maxDocumentBytes: number | string;
  maxDocumentKB: number | string;
}>;

type ScanOptions = {
  mode: ScanMode;
  includeGlob: string;
  excludeGlob: string;
  maxFiles: number;
  maxFileBytes: number;
  documentIncludeGlob: string;
  maxDocuments: number;
  maxDocumentBytes: number;
};

type ScanPayload = {
  repoFullName: string;
  runtime: {
    remoteName: string | null;
    isCodespace: boolean;
  };
  mode: {
    requested: ScanMode;
    applied: Exclude<ScanMode, 'auto'>;
  };
  workspaceFolders: Array<{ name: string; scheme: string }>;
  selectedFolders: Array<{ name: string; scheme: string }>;
  scannedAt: string;
  totalFiles: number;
  skippedBySize: number;
  files: ScannedFile[];
};

type ScanComputation = {
  payload: ScanPayload;
  options: ScanOptions;
  selection: {
    mode: Exclude<ScanMode, 'auto'>;
    folders: readonly vscode.WorkspaceFolder[];
    notes: string[];
  };
  documents: ScannedDocument[];
};

type BackendSettings = {
  baseUrl: string;
  scanWorkerKey: string;
  autoWorkerEnabled: boolean;
  workerPollMs: number;
  workerId: string;
  requestTimeoutMs: number;
};

type ActiveSuggestionSettings = {
  enabled: boolean;
  useBackend: boolean;
  debounceMs: number;
  maxCodeChars: number;
  backendTimeoutMs: number;
};

type ActiveEditorSnapshot = {
  uriString: string;
  filePath: string;
  fileName: string;
  language: string;
  repoFullName: string;
  workspaceName: string;
  line: number;
  column: number;
  lineCount: number;
  selectedText: string;
  visibleText: string;
  content: string;
  currentLineText: string;
  generatedAt: string;
  cacheKey: string;
};

type ActiveSuggestionModel = {
  uriString: string;
  filePath: string;
  fileName: string;
  language: string;
  repoFullName: string;
  title: string;
  summary: string;
  suggestions: string[];
  nextSteps: string[];
  chips: string[];
  source: 'local' | 'backend' | 'local-fallback';
  backendError: string;
  updatedAt: string;
  line: number;
  column: number;
};

type PendingScanRequest = {
  id: string;
  repoFullName: string;
};

type GitRemoteRef = {
  name?: string;
  fetchUrl?: string;
  pushUrl?: string;
};

type GitRepositoryRef = {
  rootUri?: vscode.Uri;
  state?: {
    remotes?: GitRemoteRef[];
  };
};

type GitApiRef = {
  repositories?: GitRepositoryRef[];
};

type GitExtensionExports = {
  getAPI(version: number): GitApiRef;
};

function getEnv(name: string): string | undefined {
  const processLike = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return processLike?.env?.[name];
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toPositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const clean = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(clean)) return true;
  if (['0', 'false', 'no', 'off'].includes(clean)) return false;
  return undefined;
}

function parseMode(value: unknown): ScanMode | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case 'auto':
      return 'auto';
    case 'local':
      return 'local';
    case 'codespace':
    case 'codespaces':
      return 'codespace';
    case 'all':
      return 'all';
    default:
      return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeBackendBaseUrl(value: string | undefined): string {
  const fallback = DEFAULT_BACKEND_BASE_URL;
  const clean = toOptionalString(value);
  if (!clean) return fallback;
  return clean.replace(/\/+$/, '');
}

function isCodespaceRuntime(): boolean {
  const remoteName = (vscode.env.remoteName ?? '').toLowerCase();
  if (remoteName.includes('codespace')) {
    return true;
  }

  const envFlag = (getEnv('CODESPACES') ?? '').toLowerCase();
  return envFlag === 'true' || envFlag === '1';
}

function resolveScanOptions(args: ScanCommandArgs | undefined): ScanOptions {
  const config = vscode.workspace.getConfiguration('adaceen');

  const mode =
    parseMode(args?.mode) ??
    parseMode(getEnv('ADACEEN_SCAN_MODE')) ??
    parseMode(config.get<string>('scan.mode')) ??
    'auto';

  const includeGlob =
    toOptionalString(args?.includeGlob) ??
    toOptionalString(getEnv('ADACEEN_INCLUDE_GLOB')) ??
    toOptionalString(config.get<string>('scan.includeGlob')) ??
    DEFAULT_INCLUDE_GLOB;

  const excludeGlob =
    toOptionalString(args?.excludeGlob) ??
    toOptionalString(getEnv('ADACEEN_EXCLUDE_GLOB')) ??
    toOptionalString(config.get<string>('scan.excludeGlob')) ??
    DEFAULT_EXCLUDE_GLOB;

  const documentIncludeGlob =
    toOptionalString(args?.documentIncludeGlob) ??
    toOptionalString(getEnv('ADACEEN_DOCUMENT_INCLUDE_GLOB')) ??
    DEFAULT_DOCUMENT_INCLUDE_GLOB;

  const maxFiles =
    toPositiveInt(args?.maxFiles) ??
    toPositiveInt(getEnv('ADACEEN_MAX_FILES')) ??
    toPositiveInt(config.get<number>('scan.maxFiles')) ??
    DEFAULT_MAX_FILES;

  const argsMaxFileBytes = toPositiveInt(args?.maxFileBytes);
  const argsMaxFileKB = toPositiveInt(args?.maxFileKB);
  const envMaxFileBytes = toPositiveInt(getEnv('ADACEEN_MAX_FILE_BYTES'));
  const envMaxFileKB = toPositiveInt(getEnv('ADACEEN_MAX_FILE_KB'));
  const configMaxFileKB = toPositiveInt(config.get<number>('scan.maxFileKB'));

  const maxFileBytes =
    argsMaxFileBytes ??
    (argsMaxFileKB ? argsMaxFileKB * 1024 : undefined) ??
    envMaxFileBytes ??
    (envMaxFileKB ? envMaxFileKB * 1024 : undefined) ??
    (configMaxFileKB ? configMaxFileKB * 1024 : undefined) ??
    DEFAULT_MAX_FILE_BYTES;

  const argsMaxDocumentBytes = toPositiveInt(args?.maxDocumentBytes);
  const argsMaxDocumentKB = toPositiveInt(args?.maxDocumentKB);
  const envMaxDocumentBytes = toPositiveInt(getEnv('ADACEEN_MAX_DOCUMENT_BYTES'));
  const envMaxDocumentKB = toPositiveInt(getEnv('ADACEEN_MAX_DOCUMENT_KB'));
  const maxDocumentBytes =
    argsMaxDocumentBytes ??
    (argsMaxDocumentKB ? argsMaxDocumentKB * 1024 : undefined) ??
    envMaxDocumentBytes ??
    (envMaxDocumentKB ? envMaxDocumentKB * 1024 : undefined) ??
    DEFAULT_MAX_DOCUMENT_BYTES;

  const maxDocuments =
    toPositiveInt(args?.maxDocuments) ??
    toPositiveInt(getEnv('ADACEEN_MAX_DOCUMENTS')) ??
    DEFAULT_MAX_DOCUMENTS;

  return {
    mode,
    includeGlob,
    excludeGlob,
    maxFiles,
    maxFileBytes,
    documentIncludeGlob,
    maxDocuments,
    maxDocumentBytes,
  };
}

function resolveBackendSettings(): BackendSettings {
  const config = vscode.workspace.getConfiguration('adaceen');

  const baseUrl = normalizeBackendBaseUrl(
    toOptionalString(config.get<string>('backend.baseUrl')) ??
      toOptionalString(getEnv('ADACEEN_BACKEND_URL')),
  );

  const scanWorkerKey =
    toOptionalString(config.get<string>('backend.scanWorkerKey')) ??
    toOptionalString(getEnv('ADACEEN_SCAN_WORKER_KEY')) ??
    '';

  const autoWorkerEnabled =
    toBoolean(config.get<boolean>('backend.autoWorkerEnabled')) ??
    toBoolean(getEnv('ADACEEN_SCAN_WORKER_ENABLED')) ??
    true;

  const workerPollMs = Math.max(
    2000,
    toPositiveInt(config.get<number>('backend.workerPollMs')) ??
      toPositiveInt(getEnv('ADACEEN_SCAN_WORKER_POLL_MS')) ??
      DEFAULT_WORKER_POLL_MS,
  );

  const workerId =
    toOptionalString(getEnv('ADACEEN_SCAN_WORKER_ID')) ??
    `adaceen-vscode-${vscode.env.remoteName || 'local'}`;

  return {
    baseUrl,
    scanWorkerKey,
    autoWorkerEnabled,
    workerPollMs,
    workerId,
    requestTimeoutMs: 120000,
  };
}

function resolveActiveSuggestionSettings(): ActiveSuggestionSettings {
  const config = vscode.workspace.getConfiguration('adaceen');

  const enabled =
    toBoolean(config.get<boolean>('suggestions.enabled')) ??
    toBoolean(getEnv('ADACEEN_SUGGESTIONS_ENABLED')) ??
    true;

  const useBackend =
    toBoolean(config.get<boolean>('suggestions.useBackend')) ??
    toBoolean(getEnv('ADACEEN_SUGGESTIONS_USE_BACKEND')) ??
    true;

  const debounceMs = Math.max(
    250,
    toPositiveInt(config.get<number>('suggestions.debounceMs')) ??
      toPositiveInt(getEnv('ADACEEN_SUGGESTIONS_DEBOUNCE_MS')) ??
      DEFAULT_ACTIVE_SUGGESTION_DEBOUNCE_MS,
  );

  const maxCodeChars = Math.max(
    1000,
    toPositiveInt(config.get<number>('suggestions.maxCodeChars')) ??
      toPositiveInt(getEnv('ADACEEN_SUGGESTIONS_MAX_CODE_CHARS')) ??
      DEFAULT_ACTIVE_SUGGESTION_MAX_CODE_CHARS,
  );

  const backendTimeoutMs = Math.max(
    10000,
    toPositiveInt(config.get<number>('suggestions.backendTimeoutMs')) ??
      toPositiveInt(getEnv('ADACEEN_SUGGESTIONS_BACKEND_TIMEOUT_MS')) ??
      DEFAULT_ACTIVE_SUGGESTION_TIMEOUT_MS,
  );

  return {
    enabled,
    useBackend,
    debounceMs,
    maxCodeChars,
    backendTimeoutMs,
  };
}

function selectFolders(
  requestedMode: ScanMode,
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): {
  mode: Exclude<ScanMode, 'auto'>;
  folders: readonly vscode.WorkspaceFolder[];
  notes: string[];
} {
  const notes: string[] = [];
  const resolvedMode: Exclude<ScanMode, 'auto'> =
    requestedMode === 'auto'
      ? isCodespaceRuntime()
        ? 'codespace'
        : 'local'
      : requestedMode;

  let folders: readonly vscode.WorkspaceFolder[];

  switch (resolvedMode) {
    case 'local':
      folders = workspaceFolders.filter((folder) => folder.uri.scheme === 'file');
      break;
    case 'codespace':
      folders = workspaceFolders.filter((folder) => folder.uri.scheme !== 'file');
      break;
    case 'all':
      folders = workspaceFolders;
      break;
  }

  if (!folders.length) {
    notes.push(`No se encontraron carpetas para modo "${resolvedMode}". Se usará todo el workspace.`);
    folders = workspaceFolders;
  }

  return { mode: resolvedMode, folders, notes };
}

async function findWorkspaceFiles(
  folders: readonly vscode.WorkspaceFolder[],
  options: ScanOptions,
): Promise<vscode.Uri[]> {
  const found = new Map<string, vscode.Uri>();

  for (const folder of folders) {
    const remaining = options.maxFiles - found.size;
    if (remaining <= 0) {
      break;
    }

    const includePattern = new vscode.RelativePattern(folder, options.includeGlob);
    const excludePattern = new vscode.RelativePattern(folder, options.excludeGlob);
    const files = await vscode.workspace.findFiles(
      includePattern,
      excludePattern,
      remaining,
    );

    for (const fileUri of files) {
      const key = fileUri.toString();
      if (!found.has(key)) {
        found.set(key, fileUri);
      }
    }
  }

  return [...found.values()];
}

function getDocumentExtension(uri: vscode.Uri) {
  const lastSegment = uri.path.split('/').pop() || '';
  const index = lastSegment.lastIndexOf('.');
  return index >= 0 ? lastSegment.slice(index + 1).toLowerCase() : '';
}

function normalizeDocumentName(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function scoreDocumentName(value: string) {
  const text = normalizeDocumentName(value);
  let score = 0;
  if (/\bbitacora\b/.test(text)) score += 120;
  if (/\blogbook\b/.test(text)) score += 100;
  if (/diario[-_\s]+de[-_\s]+campo/.test(text)) score += 95;
  if (/registro[-_\s]+(de[-_\s]+)?actividades/.test(text)) score += 90;
  if (/seguimiento[-_\s]+semanal/.test(text)) score += 85;
  if (/registro[-_\s]+(de[-_\s]+)?avance/.test(text)) score += 80;
  if (/\bavance(s)?\b/.test(text)) score += 25;
  if (/\bsemana[-_\s]*\d{1,2}\b/.test(text)) score += 20;
  return score;
}

async function findWorkspaceDocuments(
  folders: readonly vscode.WorkspaceFolder[],
  options: ScanOptions,
  output: vscode.OutputChannel,
): Promise<ScannedDocument[]> {
  const found = new Map<string, vscode.Uri>();

  for (const folder of folders) {
    const remaining = options.maxDocuments - found.size;
    if (remaining <= 0) break;

    const includePattern = new vscode.RelativePattern(folder, options.documentIncludeGlob);
    const excludePattern = new vscode.RelativePattern(folder, options.excludeGlob);
    const files = await vscode.workspace.findFiles(includePattern, excludePattern, remaining * 3);

    for (const fileUri of files) {
      const extension = getDocumentExtension(fileUri);
      if (!DOCUMENT_EXTENSIONS.has(extension)) continue;
      const key = fileUri.toString();
      if (!found.has(key)) found.set(key, fileUri);
      if (found.size >= options.maxDocuments) break;
    }
  }

  const documents: ScannedDocument[] = [];
  for (const uri of found.values()) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > options.maxDocumentBytes) {
        output.appendLine(`Documento omitido por tamano: ${vscode.workspace.asRelativePath(uri, false)} (${stat.size} bytes)`);
        continue;
      }

      const relativePath = vscode.workspace.asRelativePath(uri, false);
      documents.push({
        uri,
        path: relativePath,
        fileName: relativePath.split(/[\\/]/).pop() || relativePath,
        extension: getDocumentExtension(uri),
        bytes: stat.size,
      });
    } catch (error) {
      output.appendLine(`No se pudo preparar documento ${vscode.workspace.asRelativePath(uri, false)}: ${String(error)}`);
    }
  }

  return documents
    .sort((left, right) => scoreDocumentName(right.path) - scoreDocumentName(left.path) || left.path.localeCompare(right.path))
    .slice(0, options.maxDocuments);
}

async function performWorkspaceScan(args: ScanCommandArgs | undefined, output: vscode.OutputChannel): Promise<ScanComputation> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    throw new Error('Abre una carpeta o workspace antes de escanear.');
  }

  const options = resolveScanOptions(args);
  const selection = selectFolders(options.mode, workspaceFolders);
  const files = await findWorkspaceFiles(selection.folders, options);
  const documents = await findWorkspaceDocuments(selection.folders, options, output);

  const results: ScannedFile[] = [];
  let skippedBySize = 0;

  for (const uri of files) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);

      if (bytes.byteLength > options.maxFileBytes) {
        skippedBySize += 1;
        continue;
      }

      const textDocument = await vscode.workspace.openTextDocument(uri);
      const text = textDocument.getText();
      const lines = text.length ? text.split(/\r?\n/).length : 0;

      results.push({
        path: vscode.workspace.asRelativePath(uri, false),
        bytes: bytes.byteLength,
        lines,
        preview: text.slice(0, 300).replace(/\s+/g, ' ').trim(),
        content: text,
      });
    } catch (error) {
      output.appendLine(`No se pudo leer ${vscode.workspace.asRelativePath(uri, false)}: ${String(error)}`);
    }
  }

  const payload: ScanPayload = {
    repoFullName: '',
    runtime: {
      remoteName: vscode.env.remoteName ?? null,
      isCodespace: isCodespaceRuntime(),
    },
    mode: {
      requested: options.mode,
      applied: selection.mode,
    },
    workspaceFolders: workspaceFolders.map((folder) => ({
      name: folder.name,
      scheme: folder.uri.scheme,
    })),
    selectedFolders: selection.folders.map((folder) => ({
      name: folder.name,
      scheme: folder.uri.scheme,
    })),
    scannedAt: new Date().toISOString(),
    totalFiles: results.length,
    skippedBySize,
    files: results,
  };

  return {
    payload,
    options,
    selection,
    documents,
  };
}

function renderScanOutput(output: vscode.OutputChannel, scan: ScanComputation) {
  output.clear();
  output.appendLine('=== ADACEEN / Resumen del workspace ===');
  output.appendLine(`Entorno detectado: ${isCodespaceRuntime() ? 'Codespace/remoto' : 'Local'}`);
  output.appendLine(`Modo solicitado: ${scan.options.mode} | Modo aplicado: ${scan.selection.mode}`);
  output.appendLine(`Include: ${scan.options.includeGlob} | Exclude: ${scan.options.excludeGlob}`);
  output.appendLine(
    `Límites: ${scan.options.maxFiles} archivos, ${Math.round(scan.options.maxFileBytes / 1024)} KB por archivo`,
  );
  output.appendLine(
    `Carpetas usadas: ${scan.selection.folders
      .map((folder) => `${folder.name} [${folder.uri.scheme}]`)
      .join(', ')}`,
  );
  for (const note of scan.selection.notes) {
    output.appendLine(`Nota: ${note}`);
  }
  output.appendLine(`Archivos leídos: ${scan.payload.totalFiles}`);
  output.appendLine(`Archivos omitidos por tamaño: ${scan.payload.skippedBySize}`);
  output.appendLine(`Documentos candidatos: ${scan.documents.length}`);
  output.appendLine('');

  for (const file of scan.payload.files) {
    output.appendLine(`• ${file.path}`);
    output.appendLine(`  Líneas: ${file.lines} | Bytes: ${file.bytes}`);
    output.appendLine(`  Preview: ${file.preview || '(sin contenido visible)'}`);
    output.appendLine('');
  }

  for (const document of scan.documents) {
    output.appendLine(`Documento candidato: ${document.path}`);
    output.appendLine(`  Tipo: ${document.extension} | Bytes: ${document.bytes}`);
    output.appendLine('');
  }

  output.appendLine('=== JSON listo para enviar a backend ===');
  output.appendLine(JSON.stringify(scan.payload, null, 2));
}

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const text = await response.text();
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = {};
      }
    }
    if (!response.ok) {
      const structuredError = toOptionalString(asRecord(data).error);
      const rawError = toOptionalString(text);
      throw new Error(structuredError || rawError || `HTTP ${response.status}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function buildWorkerHeaders(settings: BackendSettings, includeJsonContentType: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'x-adaceen-worker-id': settings.workerId,
  };
  if (settings.scanWorkerKey) {
    headers['x-adaceen-worker-key'] = settings.scanWorkerKey;
  }
  if (includeJsonContentType) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }
  return headers;
}

function extractRepoFromGitUrl(url: string): string | undefined {
  const clean = url.trim();
  const patterns = [
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
  ];

  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (!match) continue;
    return `${match[1]}/${match[2]}`.toLowerCase();
  }

  return undefined;
}

function parseRepoFromGitConfig(raw: string): string | undefined {
  const originSection = raw.match(/\[remote\s+"origin"\]([\s\S]*?)(?:\n\[|$)/i)?.[1] || '';
  const originUrl = originSection.match(/^\s*url\s*=\s*(.+)\s*$/im)?.[1];
  const fromOrigin = originUrl ? extractRepoFromGitUrl(originUrl) : undefined;
  if (fromOrigin) return fromOrigin;

  const allUrls = raw.match(/^\s*url\s*=\s*(.+)\s*$/gim) || [];
  for (const line of allUrls) {
    const value = line.replace(/^\s*url\s*=\s*/i, '').trim();
    const parsed = extractRepoFromGitUrl(value);
    if (parsed) return parsed;
  }
  return undefined;
}

function resolveGitDirUri(baseUri: vscode.Uri, gitDirRaw: string): vscode.Uri | undefined {
  const clean = gitDirRaw.trim().replace(/^"+|"+$/g, '');
  if (!clean) return undefined;

  if (/^[a-z]+:\/\//i.test(clean)) {
    try {
      return vscode.Uri.parse(clean);
    } catch {
      return undefined;
    }
  }

  if (/^[a-zA-Z]:[\\/]/.test(clean)) {
    try {
      return vscode.Uri.file(clean);
    } catch {
      return undefined;
    }
  }

  if (clean.startsWith('/')) {
    return baseUri.with({ path: clean });
  }

  return vscode.Uri.joinPath(baseUri, clean);
}

async function readGitConfigText(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
  try {
    const gitConfigUri = vscode.Uri.joinPath(folder.uri, '.git', 'config');
    const gitConfigDoc = await vscode.workspace.openTextDocument(gitConfigUri);
    return gitConfigDoc.getText();
  } catch {
    // Continuar con fallback cuando .git es un archivo de apuntador.
  }

  try {
    const gitEntryUri = vscode.Uri.joinPath(folder.uri, '.git');
    const gitEntryDoc = await vscode.workspace.openTextDocument(gitEntryUri);
    const gitDirRaw = gitEntryDoc.getText().match(/^\s*gitdir:\s*(.+)\s*$/im)?.[1];
    if (!gitDirRaw) return undefined;

    const gitDirUri = resolveGitDirUri(folder.uri, gitDirRaw);
    if (!gitDirUri) return undefined;

    const pointedConfigUri = vscode.Uri.joinPath(gitDirUri, 'config');
    const pointedConfigDoc = await vscode.workspace.openTextDocument(pointedConfigUri);
    return pointedConfigDoc.getText();
  } catch {
    return undefined;
  }
}

async function detectRepoFromGitExtension(
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): Promise<string | undefined> {
  try {
    const gitExtension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!gitExtension) return undefined;

    const gitExports = (gitExtension.isActive
      ? gitExtension.exports
      : await gitExtension.activate()) as GitExtensionExports | undefined;
    if (!gitExports || typeof gitExports.getAPI !== 'function') return undefined;

    const api = gitExports.getAPI(1);
    const repositories = Array.isArray(api.repositories) ? api.repositories : [];
    const workspaceUris = workspaceFolders.map((folder) => folder.uri.toString().toLowerCase());

    for (const repo of repositories) {
      const rootUri = repo.rootUri;
      if (!rootUri) continue;

      const rootRef = rootUri.toString().toLowerCase();
      const belongsToWorkspace = workspaceUris.some(
        (workspaceUri) => rootRef.startsWith(workspaceUri) || workspaceUri.startsWith(rootRef),
      );
      if (!belongsToWorkspace) continue;

      const remotes = Array.isArray(repo.state?.remotes) ? [...repo.state.remotes] : [];
      remotes.sort((a, b) => {
        const aIsOrigin = (a.name || '').toLowerCase() === 'origin';
        const bIsOrigin = (b.name || '').toLowerCase() === 'origin';
        if (aIsOrigin === bIsOrigin) return 0;
        return aIsOrigin ? -1 : 1;
      });

      for (const remote of remotes) {
        const candidate = remote.fetchUrl || remote.pushUrl;
        if (!candidate) continue;
        const parsed = extractRepoFromGitUrl(candidate);
        if (parsed) return parsed;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function detectRepoFullName(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<string | undefined> {
  for (const folder of workspaceFolders) {
    const gitConfigText = await readGitConfigText(folder);
    if (!gitConfigText) continue;
    const parsed = parseRepoFromGitConfig(gitConfigText);
    if (parsed) return parsed;
  }
  return detectRepoFromGitExtension(workspaceFolders);
}

async function claimNextScanRequest(
  settings: BackendSettings,
  repoFullName: string,
): Promise<PendingScanRequest | null> {
  const query = `?repoFullName=${encodeURIComponent(repoFullName)}`;
  const response = await fetchJsonWithTimeout(
    `${settings.baseUrl}/api/projects/scan/request/next${query}`,
    {
      method: 'GET',
      headers: buildWorkerHeaders(settings, false),
    },
    settings.requestTimeoutMs,
  );

  const data = asRecord(response);
  const request = asRecord(data.request);
  const id = toOptionalString(request.id);
  const repo = toOptionalString(request.repoFullName);
  if (!id || !repo) return null;
  return {
    id,
    repoFullName: repo.toLowerCase(),
  };
}

async function sendScanResult(
  settings: BackendSettings,
  requestId: string,
  payload: ScanPayload,
) {
  return fetchJsonWithTimeout(
    `${settings.baseUrl}/api/projects/scan/request/${encodeURIComponent(requestId)}/result`,
    {
      method: 'POST',
      headers: buildWorkerHeaders(settings, true),
      body: JSON.stringify(payload),
    },
    settings.requestTimeoutMs,
  );
}

function mimeTypeForDocument(extension: string) {
  switch (extension.toLowerCase()) {
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'txt':
      return 'text/plain';
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    case 'tiff':
      return 'image/tiff';
    default:
      return 'application/octet-stream';
  }
}

function bytesToBase64(bytes: Uint8Array) {
  const maybeBuffer = (globalThis as unknown as {
    Buffer?: { from(value: Uint8Array): { toString(encoding: string): string } };
  }).Buffer;
  if (maybeBuffer?.from) {
    return maybeBuffer.from(bytes).toString('base64');
  }

  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.slice(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function shouldUseModelForDocument(document: ScannedDocument, index: number) {
  return index < 3 || scoreDocumentName(document.path) >= 25;
}

async function sendDocumentClassification(
  settings: BackendSettings,
  input: {
    repoFullName: string;
    requestId: string;
    snapshotId: string;
    document: ScannedDocument;
    useModel: boolean;
  },
) {
  const bytes = await vscode.workspace.fs.readFile(input.document.uri);
  return fetchJsonWithTimeout(
    `${settings.baseUrl}/api/documents/classify`,
    {
      method: 'POST',
      headers: buildWorkerHeaders(settings, true),
      body: JSON.stringify({
        repoFullName: input.repoFullName,
        requestId: input.requestId,
        snapshotId: input.snapshotId,
        filePath: input.document.path,
        fileName: input.document.fileName,
        extension: input.document.extension,
        mimeType: mimeTypeForDocument(input.document.extension),
        contentBase64: bytesToBase64(bytes),
        useModel: input.useModel,
      }),
    },
    settings.requestTimeoutMs,
  );
}

async function classifyScannedDocuments(
  settings: BackendSettings,
  params: {
    repoFullName: string;
    requestId: string;
    snapshotId: string;
    documents: ScannedDocument[];
  },
  output: vscode.OutputChannel,
) {
  if (!params.snapshotId || params.documents.length === 0) {
    return;
  }

  output.appendLine(`[Worker] Clasificando ${params.documents.length} documento(s) candidato(s)...`);
  for (let index = 0; index < params.documents.length; index += 1) {
    const document = params.documents[index];
    try {
      const response = await sendDocumentClassification(settings, {
        repoFullName: params.repoFullName,
        requestId: params.requestId,
        snapshotId: params.snapshotId,
        document,
        useModel: shouldUseModelForDocument(document, index),
      });
      const classification = asRecord(asRecord(response).classification);
      const label = toOptionalString(classification.label) || 'OTRO';
      const confidence = Number(classification.confidence) || 0;
      output.appendLine(`[Worker] Documento clasificado: ${label} ${Math.round(confidence * 100)}% | ${document.path}`);
    } catch (error) {
      output.appendLine(`[Worker] No se pudo clasificar ${document.path}: ${String(error)}`);
    }
  }
}

async function sendScanFailure(
  settings: BackendSettings,
  requestId: string,
  errorMessage: string,
) {
  try {
    await fetchJsonWithTimeout(
      `${settings.baseUrl}/api/projects/scan/request/${encodeURIComponent(requestId)}/fail`,
      {
        method: 'POST',
        headers: buildWorkerHeaders(settings, true),
        body: JSON.stringify({ error: errorMessage.slice(0, 1200) }),
      },
      settings.requestTimeoutMs,
    );
  } catch {
    // No-op: el worker intenta reportar, pero no debe romper el ciclo si esto falla.
  }
}

function pathBaseName(value: string) {
  const clean = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return clean[clean.length - 1] || value || 'archivo';
}

function pathExtension(value: string) {
  const baseName = pathBaseName(value).toLowerCase();
  const index = baseName.lastIndexOf('.');
  return index >= 0 ? baseName.slice(index + 1) : '';
}

function inferActiveLanguage(filePath: string, languageId: string) {
  const cleanLanguageId = toOptionalString(languageId);
  if (cleanLanguageId && cleanLanguageId !== 'plaintext') {
    return cleanLanguageId;
  }

  switch (pathExtension(filePath)) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'py':
      return 'python';
    case 'java':
      return 'java';
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'c':
    case 'hpp':
    case 'h':
      return 'cpp';
    case 'cs':
      return 'csharp';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'php':
      return 'php';
    case 'rb':
      return 'ruby';
    case 'html':
      return 'html';
    case 'css':
    case 'scss':
      return 'css';
    case 'json':
      return 'json';
    case 'md':
    case 'markdown':
      return 'markdown';
    default:
      return 'general';
  }
}

function truncateInline(value: string, max = 120) {
  const text = toOptionalString(value) || '';
  if (!text || max <= 0) return '';
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function uniqueCompactStrings(items: string[], limit: number) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const clean = item.replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(clean);
    if (output.length >= limit) break;
  }
  return output;
}

function stableStringHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSupportedActiveDocument(document: vscode.TextDocument) {
  if (document.uri.scheme === 'output' || document.uri.scheme === 'debug' || document.uri.scheme === 'vscode-chat') {
    return false;
  }
  if (document.isUntitled && !document.getText().trim()) {
    return false;
  }
  return true;
}

function getVisibleEditorText(editor: vscode.TextEditor, maxChars: number) {
  const chunks: string[] = [];
  let size = 0;
  for (const range of editor.visibleRanges) {
    const text = editor.document.getText(range);
    if (!text) continue;
    chunks.push(text);
    size += text.length + 1;
    if (size >= maxChars) break;
  }
  return chunks.join('\n').slice(0, maxChars);
}

async function buildActiveEditorSnapshot(settings: ActiveSuggestionSettings): Promise<ActiveEditorSnapshot | null> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isSupportedActiveDocument(editor.document)) {
    return null;
  }

  const document = editor.document;
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const workspaceName = workspaceFolder?.name || workspaceFolders[0]?.name || '';
  const repoFullName = workspaceFolders.length
    ? (await detectRepoFullName(workspaceFolders).catch(() => undefined)) || ''
    : '';
  const filePath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
  const fileName = pathBaseName(filePath);
  const content = document.getText().slice(0, settings.maxCodeChars);
  const selectedText = editor.selection.isEmpty
    ? ''
    : document.getText(editor.selection).slice(0, Math.min(settings.maxCodeChars, 8000));
  const activeLine = editor.selection.active.line;
  const currentLineText = activeLine >= 0 && activeLine < document.lineCount
    ? document.lineAt(activeLine).text
    : '';
  const visibleText = getVisibleEditorText(editor, Math.min(settings.maxCodeChars, 12000));
  const language = inferActiveLanguage(filePath, document.languageId);
  const generatedAt = new Date().toISOString();
  const line = editor.selection.active.line + 1;
  const column = editor.selection.active.character + 1;
  const cacheKey = stableStringHash([
    repoFullName,
    filePath,
    language,
    line,
    column,
    selectedText,
    content,
  ].join('\n---adaceen---\n'));

  return {
    uriString: document.uri.toString(),
    filePath,
    fileName,
    language,
    repoFullName,
    workspaceName,
    line,
    column,
    lineCount: document.lineCount,
    selectedText,
    visibleText,
    content,
    currentLineText,
    generatedAt,
    cacheKey,
  };
}

function countMatches(value: string, pattern: RegExp) {
  return (value.match(pattern) || []).length;
}

function buildLocalActiveSuggestion(snapshot: ActiveEditorSnapshot): ActiveSuggestionModel {
  const code = snapshot.content;
  const lowerPath = snapshot.filePath.toLowerCase();
  const language = snapshot.language.toLowerCase();
  const suggestions: string[] = [];
  const nextSteps: string[] = [];

  if (snapshot.selectedText) {
    suggestions.push('La seleccion actual ya da buen foco: trabaja solo ese bloque y valida el cambio antes de tocar el resto.');
    nextSteps.push('Convierte la seleccion en una prueba mental: entrada, proceso esperado y salida.');
  }

  if (/\b(TODO|FIXME)\b/i.test(code)) {
    const todoCount = countMatches(code, /\b(TODO|FIXME)\b/gi);
    suggestions.push(`Hay ${todoCount} marcador(es) TODO/FIXME; conviertelos en pasos pequenos y verificables.`);
  }

  if (snapshot.currentLineText.trim()) {
    nextSteps.push(`Revisa la linea ${snapshot.line}: confirma que su responsabilidad sea clara antes de continuar.`);
  }

  if (language === 'python' || lowerPath.endsWith('.py')) {
    if (/except\s+Exception\s*:\s*\n\s*pass\b/i.test(code) || /except\s*:\s*\n\s*pass\b/i.test(code)) {
      suggestions.push('Hay un bloque que silencia excepciones con pass; agrega al menos un comentario, log o condicion para no ocultar errores reales.');
    }
    if (/\bclass\s+\w+/.test(code) && !/\bdef\s+__repr__\b/.test(code)) {
      suggestions.push('Si esta clase representa datos del dominio, considera un __repr__ breve para depurar mejor en terminal.');
    }
    if (/urlpatterns\s*=/.test(code)) {
      suggestions.push('Archivo de rutas detectado: verifica que cada vista tenga nombre claro y que el flujo principal este cubierto.');
    }
    if (lowerPath.endsWith('manage.py')) {
      suggestions.push('Este parece el punto de entrada Django; valida settings, migraciones y comando de arranque antes de cambiar logica.');
    }
    if (lowerPath.endsWith('sitecustomize.py')) {
      suggestions.push('Este archivo parchea compatibilidad del entorno; mantenlo minimo y evita que esconda fallos de dependencias.');
    }
  }

  if (language.includes('javascript') || language.includes('typescript') || /\.(mjs|cjs|jsx|tsx?)$/i.test(lowerPath)) {
    if (/\bany\b/.test(code) && language.includes('typescript')) {
      suggestions.push('Hay tipos any visibles; reemplaza uno por un tipo concreto donde mas reduzca incertidumbre.');
    }
    if (/\bfetch\s*\(/.test(code) && !/catch\s*\(/.test(code)) {
      suggestions.push('Hay llamadas fetch; confirma manejo de error y estado de carga para evitar fallos silenciosos.');
    }
    if (/\buseEffect\s*\(/.test(code)) {
      suggestions.push('Revisa dependencias de useEffect y separa efectos de datos, eventos y render cuando sea posible.');
    }
  }

  if (/requirements\.txt$|pyproject\.toml$|package\.json$/i.test(lowerPath)) {
    suggestions.push('Archivo de dependencias detectado: compara versiones, scripts de arranque y librerias realmente usadas.');
    nextSteps.push('Ejecuta el comando minimo de instalacion o arranque y observa el primer error concreto.');
  }

  if (/(^|\/)(test|tests|__tests__|spec|specs)\//i.test(lowerPath) || /\.(test|spec)\./i.test(lowerPath)) {
    suggestions.push('Estas en pruebas: agrega un caso pequeno que falle primero y luego corrige la implementacion.');
  } else if (/\b(function|def|class|public\s+\w+|private\s+\w+)\b/.test(code) && !/\b(describe\(|it\(|pytest|unittest|assert\s|@Test)\b/i.test(code)) {
    suggestions.push('No se ven pruebas cerca; agrega una verificacion minima para proteger el siguiente cambio.');
  }

  const functionCount = countMatches(code, /\b(function|def|public\s+\w+|private\s+\w+)\b/g);
  if (functionCount >= 12 || snapshot.lineCount >= 350) {
    suggestions.push('El archivo se ve cargado; busca una funcion pequena que puedas extraer o probar sin reestructurar todo.');
  }

  if (suggestions.length === 0) {
    suggestions.push(`Trabaja sobre ${snapshot.fileName}: identifica entrada, estado que cambia y salida antes del siguiente cambio.`);
  }
  if (nextSteps.length === 0) {
    nextSteps.push('Haz un cambio pequeno, ejecuta una validacion corta y vuelve a leer el resultado.');
    nextSteps.push('Si aparece error, copia la primera linea util y enfoca la siguiente pista alli.');
  }

  const chips = uniqueCompactStrings([
    snapshot.repoFullName ? `repo ${snapshot.repoFullName}` : snapshot.workspaceName || 'workspace',
    snapshot.language,
    `${snapshot.lineCount} lineas`,
    snapshot.selectedText ? 'seleccion activa' : `linea ${snapshot.line}`,
    isCodespaceRuntime() ? 'Codespaces' : 'VS Code',
  ], 5);

  return {
    uriString: snapshot.uriString,
    filePath: snapshot.filePath,
    fileName: snapshot.fileName,
    language: snapshot.language,
    repoFullName: snapshot.repoFullName,
    title: `Sugerencias para ${snapshot.fileName}`,
    summary: `Archivo activo: ${snapshot.filePath} (${snapshot.language}, linea ${snapshot.line}).`,
    suggestions: uniqueCompactStrings(suggestions, 4),
    nextSteps: uniqueCompactStrings(nextSteps, 3),
    chips,
    source: 'local',
    backendError: '',
    updatedAt: new Date().toISOString(),
    line: snapshot.line,
    column: snapshot.column,
  };
}

function buildBackendSuggestionContent(snapshot: ActiveEditorSnapshot) {
  return [
    `Repositorio: ${snapshot.repoFullName || '(sin repo detectado)'}`,
    `Workspace: ${snapshot.workspaceName || '(sin workspace)'}`,
    `Archivo activo: ${snapshot.filePath}`,
    `Lenguaje: ${snapshot.language}`,
    `Cursor: linea ${snapshot.line}, columna ${snapshot.column}`,
    `Lineas del archivo: ${snapshot.lineCount}`,
    snapshot.selectedText ? `Seleccion activa:\n${snapshot.selectedText}` : '',
    snapshot.currentLineText ? `Linea actual:\n${snapshot.currentLineText}` : '',
    snapshot.visibleText ? `Texto visible del editor:\n${snapshot.visibleText}` : '',
    `Codigo del archivo activo:\n${snapshot.content}`,
  ].filter(Boolean).join('\n\n');
}

function parseBackendSuggestionLines(output: string) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^\s*(?:[-*]|\d+[.)])\s+/g, '')
      .replace(/^#+\s*/g, '')
      .replace(/\*\*/g, '')
      .trim())
    .filter((line) => line.length >= 8)
    .filter((line) => !/^(sugerencias|acciones|resumen|analisis|análisis)\s*:?\s*$/i.test(line));

  return uniqueCompactStrings(lines, 6);
}

async function requestBackendActiveSuggestion(
  settings: ActiveSuggestionSettings,
  snapshot: ActiveEditorSnapshot,
): Promise<ActiveSuggestionModel | null> {
  if (!settings.useBackend) return null;

  const backend = resolveBackendSettings();
  if (!backend.baseUrl) return null;

  const response = await fetchJsonWithTimeout(
    `${backend.baseUrl}/suggest-tab`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        tab_content: buildBackendSuggestionContent(snapshot),
        question: 'Da 3 sugerencias breves y accionables para continuar en el archivo activo. No des solucion completa.',
        tab_title: snapshot.filePath,
        tab_url: `vscode://${snapshot.repoFullName || snapshot.workspaceName || 'workspace'}/${snapshot.filePath}`,
      }),
    },
    settings.backendTimeoutMs,
  );

  const data = asRecord(response);
  const outputText = toOptionalString(data.output_text) || toOptionalString(data.outputText) || '';
  if (!outputText) return null;

  const lines = parseBackendSuggestionLines(outputText);
  if (lines.length === 0) return null;

  const localFallback = buildLocalActiveSuggestion(snapshot);
  return {
    ...localFallback,
    title: `ADACEEN en ${snapshot.fileName}`,
    summary: truncateInline(outputText.replace(/\s+/g, ' '), 260),
    suggestions: lines.slice(0, 4),
    nextSteps: lines.slice(1, 4).length > 0 ? lines.slice(1, 4) : localFallback.nextSteps,
    source: 'backend',
    backendError: '',
    updatedAt: new Date().toISOString(),
  };
}

class AdaceenActiveSuggestionPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private latestModel: ActiveSuggestionModel | null = null;

  reveal(model: ActiveSuggestionModel | null) {
    this.latestModel = model || this.latestModel;

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'adaceenActiveSuggestions',
        'ADACEEN sugerencias',
        vscode.ViewColumn.Beside,
        {
          enableScripts: false,
          retainContextWhenHidden: true,
        },
      );
      this.panel.onDidDispose(() => {
        this.panel = null;
      });
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    }

    this.render();
  }

  update(model: ActiveSuggestionModel | null) {
    this.latestModel = model;
    if (this.panel) {
      this.render();
    }
  }

  dispose() {
    this.panel?.dispose();
    this.panel = null;
  }

  private render() {
    if (!this.panel) return;
    this.panel.webview.html = this.buildHtml(this.latestModel);
  }

  private buildHtml(model: ActiveSuggestionModel | null) {
    const title = model?.title || 'Abre un archivo para recibir sugerencias';
    const summary = model?.summary || 'ADACEEN seguira la pestana activa y actualizara las pistas al navegar.';
    const suggestions = model?.suggestions?.length ? model.suggestions : ['Abre un archivo del proyecto o cambia de pestana en el editor.'];
    const nextSteps = model?.nextSteps?.length ? model.nextSteps : ['Cuando abras un archivo, ADACEEN mostrara el siguiente paso aqui.'];
    const chips = model?.chips?.length ? model.chips : ['VS Code', 'archivo activo'];
    const source = model?.source === 'backend'
      ? 'backend'
      : model?.source === 'local-fallback'
        ? 'fallback local'
        : 'local';

    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ADACEEN sugerencias</title>
  <style>
    body {
      margin: 0;
      padding: 18px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
    }
    .wrap { max-width: 760px; }
    .head {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      margin-bottom: 14px;
    }
    .diamond {
      width: 24px;
      height: 24px;
      margin-top: 4px;
      transform: rotate(45deg);
      border-radius: 5px 12px 5px 12px;
      background: linear-gradient(135deg, #c9f36f 0%, #33c789 52%, #0d847f 100%);
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.22);
      flex: 0 0 auto;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 18px;
      line-height: 1.25;
    }
    p {
      margin: 0;
      color: var(--vscode-descriptionForeground);
      line-height: 1.45;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 12px 0 16px;
    }
    .chip {
      border: 1px solid var(--vscode-badge-background);
      border-radius: 999px;
      padding: 4px 8px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      font-size: 11px;
      font-weight: 700;
    }
    section {
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 8px;
      background: var(--vscode-editorWidget-background);
      padding: 12px;
      margin-top: 12px;
    }
    h2 {
      margin: 0 0 8px;
      font-size: 12px;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }
    ol, ul {
      margin: 0;
      padding-left: 20px;
      display: grid;
      gap: 8px;
    }
    li { line-height: 1.45; }
    .meta {
      margin-top: 14px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <main class="wrap">
    <div class="head">
      <div class="diamond" aria-hidden="true"></div>
      <div>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(summary)}</p>
      </div>
    </div>
    <div class="chips">${chips.map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join('')}</div>
    <section>
      <h2>Sugerencias</h2>
      <ul>${suggestions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
    </section>
    <section>
      <h2>Continuar</h2>
      <ol>${nextSteps.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>
    </section>
    <p class="meta">Fuente: ${escapeHtml(source)}${model?.backendError ? ` | ${escapeHtml(model.backendError)}` : ''}</p>
  </main>
</body>
</html>`;
  }
}

class AdaceenSuggestionCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private model: ActiveSuggestionModel | null = null;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  update(model: ActiveSuggestionModel | null) {
    this.model = model;
    this.changeEmitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.model || document.uri.toString() !== this.model.uriString) {
      return [];
    }

    const headline = this.model.suggestions[0] || this.model.title;
    return [
      new vscode.CodeLens(
        new vscode.Range(0, 0, 0, 0),
        {
          title: `ADACEEN: ${truncateInline(headline, 96)}`,
          command: 'adaceen.openAssistant',
        },
      ),
    ];
  }

  dispose() {
    this.changeEmitter.dispose();
  }
}

function updateSuggestionStatusBar(statusBar: vscode.StatusBarItem, model: ActiveSuggestionModel | null, enabled: boolean) {
  if (!enabled) {
    statusBar.hide();
    return;
  }

  if (!model) {
    statusBar.text = '$(lightbulb) ADACEEN';
    statusBar.tooltip = 'Abre un archivo para recibir sugerencias ADACEEN.';
    statusBar.show();
    return;
  }

  statusBar.text = `$(lightbulb) ADACEEN: ${truncateInline(model.fileName, 22)}`;
  statusBar.tooltip = [
    model.summary,
    '',
    ...(model.suggestions || []).map((item) => `- ${item}`),
    model.backendError ? `Backend: ${model.backendError}` : '',
  ].filter(Boolean).join('\n');
  statusBar.show();
}

function clearSuggestionDecorations(decorationType: vscode.TextEditorDecorationType) {
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(decorationType, []);
  }
}

function applySuggestionDecoration(
  decorationType: vscode.TextEditorDecorationType,
  model: ActiveSuggestionModel | null,
) {
  clearSuggestionDecorations(decorationType);
  const editor = vscode.window.activeTextEditor;
  if (!editor || !model || editor.document.uri.toString() !== model.uriString) {
    return;
  }

  const lineIndex = Math.max(0, Math.min(editor.document.lineCount - 1, editor.selection.active.line));
  const line = editor.document.lineAt(lineIndex);
  const headline = model.suggestions[0] || model.title;
  editor.setDecorations(decorationType, [
    {
      range: new vscode.Range(lineIndex, line.text.length, lineIndex, line.text.length),
      hoverMessage: new vscode.MarkdownString([
        `**ADACEEN**`,
        '',
        ...(model.suggestions || []).map((item) => `- ${item}`),
      ].join('\n')),
      renderOptions: {
        after: {
          contentText: `  ADACEEN: ${truncateInline(headline, 84)}`,
        },
      },
    },
  ]);
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('ADACEEN');
  const startupSettings = resolveBackendSettings();
  output.appendLine(
    `[Worker] Inicializado | auto=${startupSettings.autoWorkerEnabled} | backend=${startupSettings.baseUrl} | pollMs=${startupSettings.workerPollMs} | workerId=${startupSettings.workerId}`,
  );

  const suggestionPanel = new AdaceenActiveSuggestionPanel();
  const suggestionCodeLensProvider = new AdaceenSuggestionCodeLensProvider();
  const suggestionStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  suggestionStatusBar.command = 'adaceen.openAssistant';
  const suggestionDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
      margin: '0 0 0 1rem',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const backendSuggestionCache = new Map<string, ActiveSuggestionModel>();
  let activeSuggestionModel: ActiveSuggestionModel | null = null;
  let suggestionTimer: ReturnType<typeof setTimeout> | null = null;
  let suggestionGeneration = 0;

  const publishSuggestionModel = (model: ActiveSuggestionModel | null, enabled = true) => {
    activeSuggestionModel = model;
    updateSuggestionStatusBar(suggestionStatusBar, model, enabled);
    suggestionPanel.update(model);
    suggestionCodeLensProvider.update(model);
    applySuggestionDecoration(suggestionDecorationType, model);
  };

  const refreshActiveSuggestion = async (reason = 'auto') => {
    const settings = resolveActiveSuggestionSettings();
    const generation = suggestionGeneration + 1;
    suggestionGeneration = generation;

    if (!settings.enabled) {
      publishSuggestionModel(null, false);
      return null;
    }

    const snapshot = await buildActiveEditorSnapshot(settings);
    if (generation !== suggestionGeneration) return activeSuggestionModel;

    if (!snapshot) {
      publishSuggestionModel(null, true);
      return null;
    }

    let model = buildLocalActiveSuggestion(snapshot);
    if (settings.useBackend) {
      const cached = backendSuggestionCache.get(snapshot.cacheKey);
      if (cached) {
        model = {
          ...cached,
          line: snapshot.line,
          column: snapshot.column,
          updatedAt: new Date().toISOString(),
        };
      } else {
        try {
          const backendModel = await requestBackendActiveSuggestion(settings, snapshot);
          if (backendModel) {
            model = backendModel;
            backendSuggestionCache.set(snapshot.cacheKey, backendModel);
          }
        } catch (error) {
          model = {
            ...model,
            source: 'local-fallback',
            backendError: truncateInline(String(error), 180),
          };
          output.appendLine(`[Suggestions] Backend no disponible (${reason}): ${String(error)}`);
        }
      }
    }

    if (generation !== suggestionGeneration) return activeSuggestionModel;
    publishSuggestionModel(model, true);
    output.appendLine(`[Suggestions] ${model.filePath} | fuente=${model.source} | linea=${model.line}`);
    return model;
  };

  const scheduleActiveSuggestionRefresh = (reason = 'auto') => {
    const settings = resolveActiveSuggestionSettings();
    if (!settings.enabled) {
      publishSuggestionModel(null, false);
      return;
    }
    if (suggestionTimer) {
      clearTimeout(suggestionTimer);
    }
    suggestionTimer = setTimeout(() => {
      suggestionTimer = null;
      void refreshActiveSuggestion(reason);
    }, settings.debounceMs);
  };

  const openAssistantDisposable = vscode.commands.registerCommand('adaceen.openAssistant', async () => {
    const model = activeSuggestionModel || await refreshActiveSuggestion('open-panel');
    if (!model) {
      vscode.window.showInformationMessage('ADACEEN: abre un archivo del proyecto para ver sugerencias.');
      return;
    }
    suggestionPanel.reveal(model);
  });

  const refreshSuggestionsDisposable = vscode.commands.registerCommand('adaceen.refreshSuggestions', async () => {
    const model = await refreshActiveSuggestion('manual-refresh');
    if (model) {
      suggestionPanel.reveal(model);
    }
  });

  const scanWorkspaceDisposable = vscode.commands.registerCommand(
    'adaceen.scanWorkspace',
    async (args?: ScanCommandArgs) => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) {
        vscode.window.showWarningMessage('ADACEEN: abre una carpeta o workspace antes de escanear.');
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'ADACEEN está leyendo el workspace...',
          cancellable: false,
        },
        async () => {
          const scan = await performWorkspaceScan(args, output);
          renderScanOutput(output, scan);
          output.show(true);
          vscode.window.showInformationMessage(
            `ADACEEN leyó ${scan.payload.totalFiles} archivos (${scan.selection.mode}). Revisa Output.`,
          );
        },
      );
    },
  );

  const textDocumentSelector: vscode.DocumentSelector = [
    { scheme: 'file' },
    { scheme: 'vscode-remote' },
    { scheme: 'untitled' },
  ];

  context.subscriptions.push(
    openAssistantDisposable,
    refreshSuggestionsDisposable,
    suggestionPanel,
    suggestionCodeLensProvider,
    suggestionStatusBar,
    suggestionDecorationType,
    vscode.languages.registerCodeLensProvider(textDocumentSelector, suggestionCodeLensProvider),
    vscode.window.onDidChangeActiveTextEditor(() => {
      scheduleActiveSuggestionRefresh('active-editor');
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (vscode.window.activeTextEditor?.document.uri.toString() === event.textEditor.document.uri.toString()) {
        scheduleActiveSuggestionRefresh('selection');
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (vscode.window.activeTextEditor?.document.uri.toString() === event.document.uri.toString()) {
        scheduleActiveSuggestionRefresh('text-change');
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('adaceen.suggestions') ||
        event.affectsConfiguration('adaceen.backend.baseUrl')
      ) {
        backendSuggestionCache.clear();
        scheduleActiveSuggestionRefresh('configuration');
      }
    }),
    {
      dispose: () => {
        if (suggestionTimer) {
          clearTimeout(suggestionTimer);
          suggestionTimer = null;
        }
        clearSuggestionDecorations(suggestionDecorationType);
      },
    },
  );

  let workerBusy = false;
  let workerNextPollAt = 0;
  let idlePollCount = 0;
  let missingWorkspacePollCount = 0;
  let missingRepoPollCount = 0;
  let authErrorNotified = false;

  const runWorkerCycle = async () => {
    const settings = resolveBackendSettings();
    if (!settings.autoWorkerEnabled) {
      return;
    }

    if (Date.now() < workerNextPollAt) {
      return;
    }
    workerNextPollAt = Date.now() + settings.workerPollMs;

    if (workerBusy) {
      return;
    }
    workerBusy = true;

    let requestId = '';
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) {
        missingWorkspacePollCount += 1;
        if (missingWorkspacePollCount % 15 === 0) {
          output.appendLine('[Worker] Sin workspace abierto; esperando para reclamar solicitudes.');
        }
        return;
      }
      missingWorkspacePollCount = 0;

      const repoFullName = await detectRepoFullName(workspaceFolders);
      if (!repoFullName) {
        missingRepoPollCount += 1;
        if (missingRepoPollCount % 10 === 0) {
          output.appendLine('[Worker] No se pudo detectar repo GitHub (owner/repo) desde este workspace.');
        }
        return;
      }
      missingRepoPollCount = 0;

      const request = await claimNextScanRequest(settings, repoFullName);
      if (!request) {
        idlePollCount += 1;
        if (idlePollCount % 15 === 0) {
          output.appendLine(`[Worker] Sin solicitudes pendientes para ${repoFullName}.`);
        }
        return;
      }
      idlePollCount = 0;

      requestId = request.id;
      output.appendLine(`[Worker] Solicitud reclamada: ${request.id} (${request.repoFullName}).`);
      output.show(true);

      const scan = await performWorkspaceScan(undefined, output);
      const payload: ScanPayload = {
        ...scan.payload,
        repoFullName: request.repoFullName,
      };
      const scanResponse = await sendScanResult(settings, request.id, payload);

      output.appendLine(
        `[Worker] Escaneo enviado al backend: ${request.repoFullName} (${payload.totalFiles} archivos).`,
      );

      const snapshotId = toOptionalString(asRecord(scanResponse).snapshotId);
      await classifyScannedDocuments(settings, {
        repoFullName: request.repoFullName,
        requestId: request.id,
        snapshotId: snapshotId || '',
        documents: scan.documents,
      }, output);
    } catch (error) {
      const errorMessage = String(error);
      output.appendLine(`[Worker] Error al procesar solicitud de escaneo: ${errorMessage}`);
      output.show(true);

      const normalized = errorMessage.toLowerCase();
      if (
        !authErrorNotified &&
        (normalized.includes('worker no autorizado') || normalized.includes('http 401') || normalized.includes('401'))
      ) {
        authErrorNotified = true;
        vscode.window.showWarningMessage(
          'ADACEEN Worker: backend rechazó la solicitud (401/no autorizado). Revisa adaceen.backend.scanWorkerKey.',
        );
      }

      if (requestId) {
        await sendScanFailure(settings, requestId, errorMessage);
      }
    } finally {
      workerBusy = false;
    }
  };

  const timer = setInterval(() => {
    void runWorkerCycle();
  }, WORKER_TICK_MS);

  context.subscriptions.push(
    scanWorkspaceDisposable,
    output,
    {
      dispose: () => clearInterval(timer),
    },
  );

  scheduleActiveSuggestionRefresh('activation');
  void runWorkerCycle();
}

export function deactivate() {}
