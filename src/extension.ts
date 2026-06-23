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
const ACTIVE_SUGGESTION_INDEX_TTL_MS = 60_000;
const ACTIVE_SUGGESTION_INDEX_MAX_FILES = 90;
const ACTIVE_SUGGESTION_INDEX_MAX_FILE_KB = 96;
const ACTIVE_SUGGESTION_INDEX_PREVIEW_CHARS = 220;
const ACTIVE_SUGGESTION_PROMPT_CODE_CHARS = 7200;
const ACTIVE_SUGGESTION_PROMPT_VISIBLE_CHARS = 1400;
const ACTIVE_SUGGESTION_PROMPT_SELECTION_CHARS = 2400;
const ACTIVE_SUGGESTION_PROMPT_INDEX_MAX_FILES = 24;
const ACTIVE_SUGGESTION_PROMPT_INDEX_PREVIEW_CHARS = 110;
const ACTIVE_SUGGESTION_CURSOR_IDLE_MS = 5000;
const ACTIVE_SUGGESTION_ACTION_IDLE_MS = 10000;
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
  autoRevealPanel: boolean;
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
  selectionText: string;
  selectionStartLine: number;
  selectionEndLine: number;
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
  fileOverview: string;
  suggestions: string[];
  nextSteps: string[];
  chips: string[];
  source: 'local' | 'backend' | 'local-fallback';
  backendError: string;
  updatedAt: string;
  line: number;
  column: number;
  completionText: string;
  triggerKind: 'file' | 'cursor';
  actionsVisible?: boolean;
  loading?: boolean;
};

type WorkspaceProjectIndexEntry = {
  path: string;
  language: string;
  bytes: number;
  lines: number;
  preview: string;
};

type WorkspaceProjectIndex = {
  cacheKey: string;
  generatedAt: string;
  totalFiles: number;
  files: WorkspaceProjectIndexEntry[];
  folders: string[];
};

type BackendSuggestionSections = {
  resumen: string[];
  sugerencias: string[];
  riesgos: string[];
  all: string[];
};

type BackendSuggestionScope = 'file' | 'cursor';
type BackendSuggestionRequestScope = 'file_summary' | 'cursor';

type BackendSuggestionInFlight = {
  key: string;
  request: Promise<string>;
};

type CursorIdleAnchor = {
  uriString: string;
  version: number;
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

  const autoRevealPanel =
    toBoolean(config.get<boolean>('suggestions.autoRevealPanel')) ??
    toBoolean(getEnv('ADACEEN_SUGGESTIONS_AUTO_REVEAL_PANEL')) ??
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
    autoRevealPanel,
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
      const looksLikeHtml = /^<!doctype html>|<html[\s>]/i.test(rawError || '');
      if (response.status === 524 || /524:\s*a timeout occurred|error code 524/i.test(rawError || '')) {
        throw new Error('Backend no respondio a tiempo por Cloudflare 524. Se usara fallback local.');
      }
      if (looksLikeHtml) {
        throw new Error(`Backend devolvio HTML en lugar de JSON (HTTP ${response.status}).`);
      }
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

function getWorkspaceProjectIndexIdentity() {
  const folders = vscode.workspace.workspaceFolders || [];
  return folders
    .map((folder) => `${folder.uri.scheme}:${folder.uri.toString()}`)
    .sort()
    .join('|');
}

function prioritizeWorkspaceIndexEntry(entry: WorkspaceProjectIndexEntry, activePath: string) {
  const lowerPath = entry.path.toLowerCase();
  const lowerActive = activePath.toLowerCase();
  const activeDir = lowerActive.includes('/') ? lowerActive.slice(0, lowerActive.lastIndexOf('/')) : '';
  let score = 0;

  if (lowerPath === lowerActive) {
    score += 1000;
  }
  if (activeDir && lowerPath.startsWith(`${activeDir}/`)) {
    score += 130;
  }
  if (/(^|\/)(readme|package|pyproject|requirements|pom|build\.gradle|angular|vite|next|tsconfig|webpack)\b/i.test(lowerPath)) {
    score += 70;
  }
  if (/(^|\/)(src|app|lib|services|components|routes|models|controllers)\//i.test(lowerPath)) {
    score += 45;
  }
  if (/(^|\/)(test|tests|__tests__|spec|specs)\//i.test(lowerPath) || /\.(test|spec)\./i.test(lowerPath)) {
    score += 20;
  }
  if (entry.preview) {
    score += 10;
  }
  return score;
}

async function buildWorkspaceProjectIndexForSuggestions(output: vscode.OutputChannel): Promise<WorkspaceProjectIndex | null> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    return null;
  }

  const options = resolveScanOptions({
    maxFiles: ACTIVE_SUGGESTION_INDEX_MAX_FILES,
    maxFileKB: ACTIVE_SUGGESTION_INDEX_MAX_FILE_KB,
    maxDocuments: 0,
  });
  const selection = selectFolders(options.mode, workspaceFolders);
  const files = await findWorkspaceFiles(selection.folders, options);
  const entries: WorkspaceProjectIndexEntry[] = [];

  for (const uri of files) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > options.maxFileBytes) {
        continue;
      }

      const document = await vscode.workspace.openTextDocument(uri);
      const text = document.getText();
      const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
      entries.push({
        path: relativePath,
        language: inferActiveLanguage(relativePath, document.languageId),
        bytes: stat.size,
        lines: text.length ? text.split(/\r?\n/).length : 0,
        preview: text.slice(0, ACTIVE_SUGGESTION_INDEX_PREVIEW_CHARS).replace(/\s+/g, ' ').trim(),
      });
    } catch (error) {
      output.appendLine(`[Suggestions] No se pudo indexar ${vscode.workspace.asRelativePath(uri, false)}: ${String(error)}`);
    }
  }

  const signature = entries
    .map((entry) => `${entry.path}|${entry.bytes}|${entry.lines}|${entry.preview}`)
    .join('\n');

  return {
    cacheKey: stableStringHash(`${getWorkspaceProjectIndexIdentity()}\n${signature}`),
    generatedAt: new Date().toISOString(),
    totalFiles: entries.length,
    files: entries,
    folders: selection.folders.map((folder) => `${folder.name} [${folder.uri.scheme}]`),
  };
}

function formatWorkspaceProjectIndexForPrompt(index: WorkspaceProjectIndex | null, activePath: string) {
  if (!index || index.files.length === 0) {
    return "Mapa local del proyecto: no disponible.";
  }

  const ranked = [...index.files]
    .sort((left, right) => {
      const scoreDiff = prioritizeWorkspaceIndexEntry(right, activePath) - prioritizeWorkspaceIndexEntry(left, activePath);
      return scoreDiff || left.path.localeCompare(right.path);
    })
    .slice(0, ACTIVE_SUGGESTION_PROMPT_INDEX_MAX_FILES);

  return [
    `Mapa local del proyecto generado por VS Code: ${index.totalFiles} archivo(s) indexado(s).`,
    `Carpetas: ${index.folders.join(', ') || '(sin carpetas)'}`,
    "Archivos relevantes del workspace:",
    ...ranked.map((entry) => [
      `- ${entry.path}`,
      `${entry.language}`,
      `${entry.lines} lineas`,
      `${entry.bytes} bytes`,
      entry.preview ? `preview: ${truncateInline(entry.preview, ACTIVE_SUGGESTION_PROMPT_INDEX_PREVIEW_CHARS)}` : "sin preview",
    ].join(' | ')),
  ].join('\n');
}

function extractSymbolNames(code: string, language: string) {
  const cleanLanguage = language.toLowerCase();
  const classNames = new Set<string>();
  const functionNames = new Set<string>();
  const importNames = new Set<string>();

  for (const match of code.matchAll(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    classNames.add(match[1]);
  }

  if (cleanLanguage === 'python') {
    for (const match of code.matchAll(/\bdef\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      functionNames.add(match[1]);
    }
    for (const match of code.matchAll(/^\s*(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.,\s]+))/gm)) {
      importNames.add((match[1] || match[2] || '').split(',')[0].trim());
    }
  } else {
    for (const match of code.matchAll(/\b(?:function\s+|const\s+|let\s+|var\s+|public\s+|private\s+|protected\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*(?:async\s*)?\([^)]*\)\s*=>|\([^)]*\)\s*\{)/g)) {
      functionNames.add(match[1]);
    }
    for (const match of code.matchAll(/^\s*import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/gm)) {
      importNames.add(match[1]);
    }
  }

  return {
    classes: [...classNames].slice(0, 5),
    functions: [...functionNames].filter((name) => !['if', 'for', 'while', 'switch'].includes(name)).slice(0, 8),
    imports: [...importNames].filter(Boolean).slice(0, 5),
  };
}

function inferFileRoleFromPath(filePath: string) {
  const lowerPath = filePath.toLowerCase();
  if (/(^|\/)(test|tests|__tests__|spec|specs)\//i.test(lowerPath) || /\.(test|spec)\./i.test(lowerPath)) {
    return "contiene pruebas o validaciones del proyecto";
  }
  if (/requirements\.txt$|pyproject\.toml$|package\.json$|pom\.xml$|build\.gradle$/i.test(lowerPath)) {
    return "declara dependencias, scripts o configuracion de construccion";
  }
  if (/readme|\.md$/i.test(lowerPath)) {
    return "documenta informacion del proyecto";
  }
  if (/routes?|controllers?|views?/.test(lowerPath)) {
    return "coordina rutas, vistas o entrada de peticiones";
  }
  if (/services?|api|client/.test(lowerPath)) {
    return "concentra logica de servicio o comunicacion con otras capas";
  }
  if (/models?|entities|schema/.test(lowerPath)) {
    return "define datos, entidades o estructura del dominio";
  }
  if (/components?|pages?/.test(lowerPath)) {
    return "forma parte de la interfaz o de una pagina visible";
  }
  if (/\.css$|\.scss$|styles?/.test(lowerPath)) {
    return "define estilos visuales";
  }
  return "aporta logica o configuracion al proyecto";
}

function findRelatedWorkspacePaths(index: WorkspaceProjectIndex | null, filePath: string) {
  if (!index) {
    return [];
  }
  const lowerPath = filePath.toLowerCase();
  const activeDir = lowerPath.includes('/') ? lowerPath.slice(0, lowerPath.lastIndexOf('/')) : '';
  return index.files
    .filter((entry) => entry.path.toLowerCase() !== lowerPath)
    .filter((entry) => {
      const entryPath = entry.path.toLowerCase();
      return activeDir ? entryPath.startsWith(`${activeDir}/`) : pathExtension(entryPath) === pathExtension(lowerPath);
    })
    .map((entry) => entry.path)
    .slice(0, 4);
}

function buildLocalFileOverview(snapshot: ActiveEditorSnapshot, index: WorkspaceProjectIndex | null = null) {
  const symbols = extractSymbolNames(snapshot.content, snapshot.language);
  const parts = [
    `${snapshot.fileName} es un archivo ${snapshot.language} que ${inferFileRoleFromPath(snapshot.filePath)}.`,
  ];

  if (symbols.classes.length > 0) {
    parts.push(`Define clase(s) como ${symbols.classes.join(', ')}.`);
  }
  if (symbols.functions.length > 0) {
    parts.push(`Incluye funciones/metodos como ${symbols.functions.join(', ')}.`);
  }
  if (symbols.imports.length > 0) {
    parts.push(`Se apoya en ${symbols.imports.join(', ')}.`);
  }

  const relatedPaths = findRelatedWorkspacePaths(index, snapshot.filePath);
  if (relatedPaths.length > 0) {
    parts.push(`En el contexto local se relaciona con ${relatedPaths.join(', ')}.`);
  } else if (index?.totalFiles) {
    parts.push(`Se analizo dentro de un workspace con ${index.totalFiles} archivo(s) indexado(s).`);
  }

  return truncateInline(parts.join(' '), 420);
}

function getBackendSuggestionScopeLabel(scope: BackendSuggestionScope) {
  return scope === 'cursor' ? 'cursor' : 'archivo';
}

function cleanBackendSuggestionLine(value: string) {
  return value
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/g, '')
    .replace(/^#+\s*/g, '')
    .replace(/\*\*/g, '')
    .trim();
}

function parseBackendSuggestionSections(output: string): BackendSuggestionSections {
  const sections: BackendSuggestionSections = {
    resumen: [],
    sugerencias: [],
    riesgos: [],
    all: [],
  };
  let current: keyof Omit<BackendSuggestionSections, 'all'> | '' = '';

  for (const rawLine of output.split(/\r?\n/)) {
    const clean = cleanBackendSuggestionLine(rawLine);
    if (!clean) {
      continue;
    }

    const normalized = clean
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    if (/^1\s*[).:-]?\s*resumen\b/.test(normalized) || /^resumen\b/.test(normalized)) {
      current = 'resumen';
      continue;
    }
    if (/^2\s*[).:-]?\s*sugerencias?\b/.test(normalized) || /^sugerencias?\b/.test(normalized)) {
      current = 'sugerencias';
      continue;
    }
    if (/^3\s*[).:-]?\s*(dudas?|riesgos?)/.test(normalized) || /^(dudas?|riesgos?)/.test(normalized)) {
      current = 'riesgos';
      continue;
    }
    if (/^enlaces?\s+relevantes?\b/.test(normalized)) {
      current = '';
      continue;
    }
    if (clean.length < 8) {
      continue;
    }

    sections.all.push(clean);
    if (current) {
      sections[current].push(clean);
    }
  }

  return {
    resumen: uniqueCompactStrings(sections.resumen, 5),
    sugerencias: uniqueCompactStrings(sections.sugerencias, 5),
    riesgos: uniqueCompactStrings(sections.riesgos, 4),
    all: uniqueCompactStrings(sections.all, 8),
  };
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

function getSelectedEditorText(editor: vscode.TextEditor, maxChars: number) {
  if (editor.selection.isEmpty) {
    return '';
  }
  return editor.document.getText(editor.selection).slice(0, maxChars);
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
  const activeLine = editor.selection.active.line;
  const currentLineText = activeLine >= 0 && activeLine < document.lineCount
    ? document.lineAt(activeLine).text
    : '';
  const selectionText = getSelectedEditorText(editor, ACTIVE_SUGGESTION_PROMPT_SELECTION_CHARS);
  const selectionStartLine = editor.selection.isEmpty ? 0 : editor.selection.start.line + 1;
  const selectionEndLine = editor.selection.isEmpty ? 0 : editor.selection.end.line + 1;
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
    selectionStartLine,
    selectionEndLine,
    selectionText,
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
    selectionText,
    selectionStartLine,
    selectionEndLine,
    visibleText,
    content,
    currentLineText,
    generatedAt,
    cacheKey,
  };
}

function isSnapshotStillActive(snapshot: ActiveEditorSnapshot, scope: BackendSuggestionScope) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== snapshot.uriString) {
    return false;
  }

  if (scope !== 'cursor') {
    return true;
  }

  return editor.selection.active.line + 1 === snapshot.line
    && editor.selection.active.character + 1 === snapshot.column;
}

function getCursorIdleAnchor(): CursorIdleAnchor | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isSupportedActiveDocument(editor.document)) {
    return null;
  }

  return {
    uriString: editor.document.uri.toString(),
    version: editor.document.version,
    line: editor.selection.active.line,
    column: editor.selection.active.character,
  };
}

function isCursorIdleAnchorStillActive(anchor: CursorIdleAnchor | null) {
  if (!anchor) {
    return false;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== anchor.uriString) {
    return false;
  }

  return editor.document.version === anchor.version
    && editor.selection.active.line === anchor.line
    && editor.selection.active.character === anchor.column;
}

function countMatches(value: string, pattern: RegExp) {
  return (value.match(pattern) || []).length;
}

function lineIndent(value: string) {
  return value.match(/^\s*/)?.[0] || '';
}

function commentPrefixForLanguage(language: string, filePath: string) {
  const normalized = language.toLowerCase();
  const lowerPath = filePath.toLowerCase();
  if (normalized === 'html' || lowerPath.endsWith('.html') || lowerPath.endsWith('.xml')) {
    return { open: '<!-- ', close: ' -->' };
  }
  if (normalized === 'css' || normalized === 'scss' || lowerPath.endsWith('.css') || lowerPath.endsWith('.scss')) {
    return { open: '/* ', close: ' */' };
  }
  return { open: '// ', close: '' };
}

function normalizeSuggestionForCode(value: string) {
  return truncateInline(value.replace(/\s+/g, ' ').replace(/[.;]\s*$/g, ''), 120);
}

function extractFirstCodeFence(value: string) {
  const match = value.match(/```(?:[A-Za-z0-9_+-]+)?\s*\r?\n([\s\S]*?)```/);
  return match?.[1]?.trimEnd() || '';
}

function buildSuggestedCompletion(snapshot: ActiveEditorSnapshot, suggestion = '', mode: 'insert' | 'replace' = 'insert') {
  const currentLine = snapshot.currentLineText || '';
  const indent = lineIndent(currentLine);
  const nestedIndent = `${indent}  `;
  const normalizedLanguage = snapshot.language.toLowerCase();
  const lowerPath = snapshot.filePath.toLowerCase();
  const cleanSuggestion = normalizeSuggestionForCode(suggestion || `continuar en ${snapshot.fileName}`);
  const currentTrimmed = currentLine.trimEnd();

  if ((normalizedLanguage === 'python' || lowerPath.endsWith('.py')) && currentTrimmed.endsWith(':')) {
    return `${indent}    # TODO: ${cleanSuggestion}\n${indent}    pass`;
  }

  if (
    (normalizedLanguage.includes('javascript') || normalizedLanguage.includes('typescript') || /\.(mjs|cjs|jsx|tsx?)$/i.test(lowerPath))
    && /[{\[]\s*$/.test(currentTrimmed)
  ) {
    return `${nestedIndent}// TODO: ${cleanSuggestion}`;
  }

  if (normalizedLanguage === 'python' || lowerPath.endsWith('.py')) {
    return `${indent}# TODO: ${cleanSuggestion}`;
  }

  const comment = commentPrefixForLanguage(snapshot.language, snapshot.filePath);
  const prefix = mode === 'replace' ? indent : indent;
  return `${prefix}${comment.open}TODO: ${cleanSuggestion}${comment.close}`;
}

function getDocumentEol(document: vscode.TextDocument) {
  return document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

function normalizeCompletionTextForEditor(rawText: string, indent: string, eol: string) {
  const normalized = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
  if (!normalized.trim()) {
    return '';
  }

  const lines = normalized.split('\n');
  const firstCodeLine = lines.find((line) => line.trim().length > 0) || '';
  if (indent && firstCodeLine && !/^\s/.test(firstCodeLine)) {
    return lines.map((line) => line.trim() ? `${indent}${line}` : '').join(eol);
  }

  return lines.join(eol);
}

function buildCompletionFallbackForModel(model: ActiveSuggestionModel, lineText: string) {
  const indent = lineIndent(lineText);
  const comment = commentPrefixForLanguage(model.language, model.filePath);
  const suggestion = normalizeSuggestionForCode(
    model.suggestions[0] || model.nextSteps[0] || `continuar en ${model.fileName}`,
  );
  return `${indent}${comment.open}TODO: ${suggestion}${comment.close}`;
}

function getSelectedFullLineRange(editor: vscode.TextEditor) {
  const selection = editor.selection;
  const startLine = Math.max(0, Math.min(selection.start.line, editor.document.lineCount - 1));
  let endLine = Math.max(0, Math.min(selection.end.line, editor.document.lineCount - 1));
  if (!selection.isEmpty && selection.end.character === 0 && endLine > startLine) {
    endLine -= 1;
  }

  return new vscode.Range(
    new vscode.Position(startLine, 0),
    editor.document.lineAt(endLine).range.end,
  );
}

function buildLocalActiveSuggestion(
  snapshot: ActiveEditorSnapshot,
  projectIndex: WorkspaceProjectIndex | null = null,
): ActiveSuggestionModel {
  const code = snapshot.content;
  const lowerPath = snapshot.filePath.toLowerCase();
  const language = snapshot.language.toLowerCase();
  const suggestions: string[] = [];
  const nextSteps: string[] = [];
  const fileOverview = buildLocalFileOverview(snapshot, projectIndex);

  if (snapshot.currentLineText.trim()) {
    suggestions.push(`El cursor quedo en la linea ${snapshot.line}; revisa ese punto como posible bloqueo antes de cambiar mas codigo.`);
    nextSteps.push(`Trabaja desde la linea ${snapshot.line}: completa una intencion pequena y valida el resultado.`);
  }

  if (/\b(TODO|FIXME)\b/i.test(code)) {
    const todoCount = countMatches(code, /\b(TODO|FIXME)\b/gi);
    suggestions.push(`Hay ${todoCount} marcador(es) TODO/FIXME; conviertelos en pasos pequenos y verificables.`);
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
    `cursor linea ${snapshot.line}`,
    isCodespaceRuntime() ? 'Codespaces' : 'VS Code',
  ], 5);
  const compactSuggestions = uniqueCompactStrings(suggestions, 4);

  return {
    uriString: snapshot.uriString,
    filePath: snapshot.filePath,
    fileName: snapshot.fileName,
    language: snapshot.language,
    repoFullName: snapshot.repoFullName,
    title: `Sugerencias para ${snapshot.fileName}`,
    summary: fileOverview || `Archivo activo: ${snapshot.filePath} (${snapshot.language}, linea ${snapshot.line}).`,
    fileOverview,
    suggestions: compactSuggestions,
    nextSteps: uniqueCompactStrings(nextSteps, 3),
    chips,
    source: 'local',
    backendError: '',
    updatedAt: new Date().toISOString(),
    line: snapshot.line,
    column: snapshot.column,
    completionText: buildSuggestedCompletion(snapshot, compactSuggestions[0] || nextSteps[0] || ''),
    triggerKind: 'cursor',
    actionsVisible: false,
  };
}

function buildBackendSuggestionContent(
  snapshot: ActiveEditorSnapshot,
  projectIndex: WorkspaceProjectIndex | null = null,
  scope: BackendSuggestionRequestScope = 'file_summary',
) {
  const selectionBlock = snapshot.selectionText.trim()
    ? [
      `Seleccion actual: lineas ${snapshot.selectionStartLine}-${snapshot.selectionEndLine}`,
      snapshot.selectionText.slice(0, ACTIVE_SUGGESTION_PROMPT_SELECTION_CHARS),
    ].join('\n')
    : '';

  return [
    `Repositorio: ${snapshot.repoFullName || '(sin repo detectado)'}`,
    `Workspace: ${snapshot.workspaceName || '(sin workspace)'}`,
    `Archivo activo: ${snapshot.filePath}`,
    `Lenguaje: ${snapshot.language}`,
    `Cursor: linea ${snapshot.line}, columna ${snapshot.column}`,
    scope === 'cursor' ? 'Disparador: cursor quieto durante 5 segundos; posible bloqueo del estudiante.' : '',
    selectionBlock,
    `Lineas del archivo: ${snapshot.lineCount}`,
    snapshot.currentLineText ? `Linea actual:\n${snapshot.currentLineText}` : '',
    snapshot.visibleText ? `Texto visible del editor:\n${snapshot.visibleText.slice(0, ACTIVE_SUGGESTION_PROMPT_VISIBLE_CHARS)}` : '',
    `Codigo del archivo activo (recorte local):\n${snapshot.content.slice(0, ACTIVE_SUGGESTION_PROMPT_CODE_CHARS)}`,
    formatWorkspaceProjectIndexForPrompt(projectIndex, snapshot.filePath),
  ].filter(Boolean).join('\n\n');
}

function buildBackendSuggestionQuestion(snapshot: ActiveEditorSnapshot, scope: BackendSuggestionRequestScope) {
  if (scope === 'file_summary') {
    return [
      'Describe en 1 a 3 bullets que hace el archivo activo y cual parece ser su papel dentro del proyecto usando el mapa local del workspace.',
      'Despues da 3 sugerencias breves y accionables para continuar en ese archivo.',
      'No des la solucion completa ni inventes datos que no esten en el contexto.',
    ].join(' ');
  }

  if (snapshot.selectionText.trim()) {
    return [
      'El estudiante selecciono un bloque del editor; interpreta esa seleccion como el foco principal.',
      'Describe en 1 bullet que parece estar intentando hacer y da 2 sugerencias breves para continuar desde esa seleccion.',
      'Al final, si es seguro, incluye un unico bloque de codigo corto para continuar. Si no es seguro, usa un comentario TODO del lenguaje.',
      'No des la solucion completa ni inventes datos que no esten en el contexto.',
    ].join(' ');
  }

  return [
    'El cursor quedo quieto 5 segundos en la linea indicada; interpreta esto como posible bloqueo del estudiante.',
    'Describe en 1 bullet que parece estar intentando hacer y da 2 sugerencias breves para continuar desde esa linea.',
    'Al final, si es seguro, incluye un unico bloque de codigo corto para continuar. Si no es seguro, usa un comentario TODO del lenguaje.',
    'No des la solucion completa ni inventes datos que no esten en el contexto.',
  ].join(' ');
}

async function fetchBackendSuggestionText(
  settings: ActiveSuggestionSettings,
  snapshot: ActiveEditorSnapshot,
  projectIndex: WorkspaceProjectIndex | null = null,
  scope: BackendSuggestionRequestScope,
): Promise<string> {
  const backend = resolveBackendSettings();
  if (!backend.baseUrl) {
    return '';
  }

  const response = await fetchJsonWithTimeout(
    `${backend.baseUrl}/suggest-tab`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        tab_content: buildBackendSuggestionContent(snapshot, projectIndex, scope),
        question: buildBackendSuggestionQuestion(snapshot, scope),
        tab_title: snapshot.filePath,
        tab_url: `vscode://${snapshot.repoFullName || snapshot.workspaceName || 'workspace'}/${snapshot.filePath}`,
        suggestion_scope: scope,
      }),
    },
    settings.backendTimeoutMs,
  );

  const data = asRecord(response);
  const outputText = toOptionalString(data.output_text) || toOptionalString(data.outputText) || '';
  return outputText;
}

function buildBackendActiveSuggestionModel(
  snapshot: ActiveEditorSnapshot,
  projectIndex: WorkspaceProjectIndex | null,
  scope: BackendSuggestionScope,
  focusOutputText: string,
  fileSummaryOutputText = '',
): ActiveSuggestionModel | null {
  if (!focusOutputText) {
    return null;
  }

  const focusSections = parseBackendSuggestionSections(focusOutputText);
  const fileSummarySections = fileSummaryOutputText
    ? parseBackendSuggestionSections(fileSummaryOutputText)
    : focusSections;
  const lines = focusSections.sugerencias.length > 0 ? focusSections.sugerencias : focusSections.all;
  if (lines.length === 0) {
    return null;
  }

  const localFallback = buildLocalActiveSuggestion(snapshot, projectIndex);
  const fileOverview = fileSummarySections.resumen.length > 0
    ? truncateInline(fileSummarySections.resumen.join(' '), 420)
    : localFallback.fileOverview;
  const focusSummary = focusSections.resumen.length > 0
    ? truncateInline(focusSections.resumen.join(' '), 420)
    : '';
  const completionText = extractFirstCodeFence(focusOutputText)
    || buildSuggestedCompletion(snapshot, lines[0] || localFallback.suggestions[0] || '');
  const combinedSuggestions = uniqueCompactStrings([
    ...lines,
    ...(scope === 'cursor' ? fileSummarySections.sugerencias.slice(0, 2) : []),
  ], 4);
  return {
    ...localFallback,
    title: `ADACEEN en ${snapshot.fileName}`,
    summary: scope === 'cursor'
      ? focusSummary || fileOverview || truncateInline(focusOutputText.replace(/\s+/g, ' '), 260)
      : fileOverview || truncateInline(focusOutputText.replace(/\s+/g, ' '), 260),
    fileOverview,
    suggestions: combinedSuggestions,
    nextSteps: combinedSuggestions.slice(1, 4).length > 0 ? combinedSuggestions.slice(1, 4) : localFallback.nextSteps,
    source: 'backend',
    backendError: '',
    updatedAt: new Date().toISOString(),
    completionText,
    triggerKind: scope === 'cursor' ? 'cursor' : 'file',
    actionsVisible: false,
  };
}

class AdaceenActiveSuggestionPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private latestModel: ActiveSuggestionModel | null = null;

  reveal(model: ActiveSuggestionModel | null, preserveFocus = true) {
    this.latestModel = model || this.latestModel;

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'adaceenActiveSuggestions',
        'ADACEEN sugerencias',
        {
          viewColumn: vscode.ViewColumn.Beside,
          preserveFocus,
        },
        {
          enableScripts: false,
          retainContextWhenHidden: true,
        },
      );
      this.panel.onDidDispose(() => {
        this.panel = null;
      });
    } else {
      this.panel.reveal(vscode.ViewColumn.Beside, preserveFocus);
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
    if (!this.panel) {
      return;
    }
    this.panel.webview.html = this.buildHtml(this.latestModel);
  }

  private buildHtml(model: ActiveSuggestionModel | null) {
    const title = model?.title || 'Abre un archivo para recibir sugerencias';
    const summary = model?.summary || 'ADACEEN seguira la pestana activa y actualizara las pistas al navegar.';
    const loading = !!model?.loading;
    const fileOverview = model?.fileOverview || summary;
    const suggestions = model?.suggestions?.length ? model.suggestions : ['Abre un archivo del proyecto o cambia de pestana en el editor.'];
    const nextSteps = model?.nextSteps?.length ? model.nextSteps : ['Cuando abras un archivo, ADACEEN mostrara el siguiente paso aqui.'];
    const chips = model?.chips?.length ? model.chips : ['VS Code', 'archivo activo'];
    const source = model?.source === 'backend'
      ? 'backend'
      : model?.source === 'local-fallback'
        ? 'fallback local'
        : 'local';
    const sourceLabel = loading ? 'cargando' : source;
    const suggestionMarkup = loading
      ? `<article class="bubble is-loading"><span class="bubble-mark">...</span><p>Cargando sugerencias...</p></article>`
      : suggestions.map((item, index) => `
        <article class="bubble">
          <span class="bubble-mark">${index + 1}</span>
          <p>${escapeHtml(item)}</p>
        </article>
      `).join('');

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
    .wrap {
      max-width: 820px;
    }
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
    .loading-strip {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 0 0 14px;
      border: 1px solid rgba(201, 95, 48, 0.35);
      border-radius: 8px;
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 78%, #ffe3bf 22%);
      padding: 10px 12px;
      color: var(--vscode-foreground);
      font-size: 12px;
      font-weight: 700;
    }
    .spinner {
      width: 14px;
      height: 14px;
      border-radius: 999px;
      border: 2px solid rgba(201, 95, 48, 0.22);
      border-top-color: #c95f30;
      animation: spin 900ms linear infinite;
      flex: 0 0 auto;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    section {
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 8px;
      background: var(--vscode-editorWidget-background);
      padding: 12px;
      margin-top: 12px;
    }
    .overview {
      border-left: 4px solid #33c789;
    }
    h2 {
      margin: 0 0 8px;
      font-size: 12px;
      letter-spacing: 0;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }
    .bubble-list {
      display: grid;
      gap: 10px;
    }
    .bubble {
      display: grid;
      grid-template-columns: 30px minmax(0, 1fr);
      align-items: start;
      gap: 10px;
      border: 1px solid rgba(51, 199, 137, 0.36);
      border-radius: 18px;
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--vscode-editorWidget-background) 88%, #e8fff6 12%), var(--vscode-editorWidget-background));
      padding: 11px 12px;
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.08);
    }
    .bubble.is-loading {
      border-color: rgba(201, 95, 48, 0.42);
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 82%, #fff0dc 18%);
    }
    .bubble-mark {
      display: inline-grid;
      place-items: center;
      width: 26px;
      height: 26px;
      border-radius: 999px;
      color: #0d3f3d;
      background: #c9f36f;
      font-size: 11px;
      font-weight: 800;
      line-height: 1;
    }
    .bubble p {
      color: var(--vscode-foreground);
      font-size: 13px;
    }
    .steps {
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
    ${loading ? '<div class="loading-strip"><span class="spinner" aria-hidden="true"></span><span>Cargando sugerencias...</span></div>' : ''}
    <section class="overview">
      <h2>Que hace este archivo</h2>
      <p>${escapeHtml(fileOverview)}</p>
    </section>
    <section>
      <h2>Sugerencias</h2>
      <div class="bubble-list">${suggestionMarkup}</div>
    </section>
    <section>
      <h2>Continuar</h2>
      <ol class="steps">${nextSteps.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>
    </section>
    <p class="meta">Fuente: ${escapeHtml(sourceLabel)}${model?.backendError ? ` | ${escapeHtml(model.backendError)}` : ''}</p>
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

    const headline = this.model.loading
      ? 'Cargando sugerencias...'
      : this.model.suggestions[0] || this.model.fileOverview || this.model.title;
    const lineIndex = Math.max(0, (Number(this.model.line) || 1) - 2);
    const range = new vscode.Range(lineIndex, 0, lineIndex, 0);
    const lenses = [
      new vscode.CodeLens(
        range,
        {
          title: `ADACEEN: ${truncateInline(headline, 96)}`,
          command: 'adaceen.openAssistant',
        },
      ),
    ];
    if (this.model.actionsVisible && !this.model.loading) {
      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(arrow-down) Pegar debajo',
          command: 'adaceen.applySuggestionCompletion',
          arguments: ['insert'],
        }),
        new vscode.CodeLens(range, {
          title: '$(wand) Autocompletar linea',
          command: 'adaceen.applySuggestionCompletion',
          arguments: ['replace'],
        }),
      );
    }
    return lenses;
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

  if (model.loading) {
    statusBar.text = `$(sync~spin) ADACEEN: cargando`;
    statusBar.tooltip = [
      `Cargando sugerencias para ${model.fileName}...`,
      model.fileOverview ? `Descripcion: ${model.fileOverview}` : '',
    ].filter(Boolean).join('\n');
    statusBar.show();
    return;
  }

  statusBar.text = `$(lightbulb) ADACEEN: ${truncateInline(model.fileName, 22)}`;
  statusBar.tooltip = [
    model.fileOverview ? `Descripcion: ${model.fileOverview}` : '',
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
  void model;
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
      fontStyle: 'normal',
      margin: '0 0 0 1rem',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const backendSuggestionCache: Record<BackendSuggestionRequestScope, Map<string, string>> = {
    cursor: new Map(),
    file_summary: new Map(),
  };
  const backendSuggestionInFlight = new Map<string, BackendSuggestionInFlight>();
  let activeSuggestionModel: ActiveSuggestionModel | null = null;
  let suggestionTimer: ReturnType<typeof setTimeout> | null = null;
  let cursorIdleSuggestionTimer: ReturnType<typeof setTimeout> | null = null;
  let cursorActionTimer: ReturnType<typeof setTimeout> | null = null;
  let autoRevealedSuggestionUri = '';
  let workspaceProjectIndexCache: {
    identity: string;
    expiresAt: number;
    value: WorkspaceProjectIndex | null;
  } | null = null;
  let workspaceProjectIndexInFlight: Promise<WorkspaceProjectIndex | null> | null = null;

  const publishSuggestionModel = (model: ActiveSuggestionModel | null, enabled = true) => {
    activeSuggestionModel = model;
    updateSuggestionStatusBar(suggestionStatusBar, model, enabled);
    suggestionPanel.update(model);
    suggestionCodeLensProvider.update(model);
    applySuggestionDecoration(suggestionDecorationType, model);
  };

  const clearWorkspaceProjectIndexCache = () => {
    workspaceProjectIndexCache = null;
    workspaceProjectIndexInFlight = null;
  };

  const clearBackendSuggestionCaches = () => {
    backendSuggestionCache.cursor.clear();
    backendSuggestionCache.file_summary.clear();
    backendSuggestionInFlight.clear();
  };

  const buildBackendSuggestionTextCacheKey = (
    snapshot: ActiveEditorSnapshot,
    projectIndex: WorkspaceProjectIndex | null,
    scope: BackendSuggestionRequestScope,
  ) => {
    const projectKey = projectIndex?.cacheKey || 'sin-mapa';
    if (scope === 'file_summary') {
      const fileKey = stableStringHash([
        snapshot.repoFullName,
        snapshot.filePath,
        snapshot.language,
        snapshot.content,
      ].join('\n---adaceen-file-summary---\n'));
      return `${fileKey}:${projectKey}`;
    }
    return `${snapshot.cacheKey}:${projectKey}`;
  };

  const getBackendSuggestionText = async (
    settings: ActiveSuggestionSettings,
    snapshot: ActiveEditorSnapshot,
    projectIndex: WorkspaceProjectIndex | null,
    scope: BackendSuggestionRequestScope,
  ) => {
    const cacheKey = buildBackendSuggestionTextCacheKey(snapshot, projectIndex, scope);
    const cached = backendSuggestionCache[scope].get(cacheKey);
    if (cached) {
      return cached;
    }

    const inFlightKey = `${scope}:${cacheKey}`;
    let inFlight = backendSuggestionInFlight.get(inFlightKey);
    if (!inFlight) {
      const request = fetchBackendSuggestionText(settings, snapshot, projectIndex, scope);
      inFlight = { key: cacheKey, request };
      backendSuggestionInFlight.set(inFlightKey, inFlight);
      request.then(
        () => backendSuggestionInFlight.delete(inFlightKey),
        () => backendSuggestionInFlight.delete(inFlightKey),
      );
    }

    const outputText = await inFlight.request;
    if (outputText) {
      backendSuggestionCache[scope].set(cacheKey, outputText);
    }
    return outputText;
  };

  const getWorkspaceProjectIndex = async () => {
    const identity = getWorkspaceProjectIndexIdentity();
    if (!identity) {
      return null;
    }

    const now = Date.now();
    if (
      workspaceProjectIndexCache &&
      workspaceProjectIndexCache.identity === identity &&
      workspaceProjectIndexCache.expiresAt > now
    ) {
      return workspaceProjectIndexCache.value;
    }

    if (!workspaceProjectIndexInFlight) {
      workspaceProjectIndexInFlight = buildWorkspaceProjectIndexForSuggestions(output)
        .catch((error) => {
          output.appendLine(`[Suggestions] No se pudo construir el mapa local del proyecto: ${String(error)}`);
          return null;
        });
    }

    try {
      const value = await workspaceProjectIndexInFlight;
      workspaceProjectIndexCache = {
        identity,
        expiresAt: Date.now() + ACTIVE_SUGGESTION_INDEX_TTL_MS,
        value,
      };
      return value;
    } finally {
      workspaceProjectIndexInFlight = null;
    }
  };

  const refreshActiveSuggestion = async (reason = 'auto') => {
    const settings = resolveActiveSuggestionSettings();
    const backendScope: BackendSuggestionScope = reason === 'cursor-idle' ? 'cursor' : 'file';

    if (!settings.enabled) {
      publishSuggestionModel(null, false);
      return null;
    }

    const snapshot = await buildActiveEditorSnapshot(settings);
    if (!snapshot) {
      publishSuggestionModel(null, true);
      return null;
    }

    let model = buildLocalActiveSuggestion(snapshot);
    model = { ...model, triggerKind: backendScope === 'cursor' ? 'cursor' : 'file', actionsVisible: false };
    publishSuggestionModel(model, true);
    if (settings.autoRevealPanel && backendScope === 'file' && autoRevealedSuggestionUri !== snapshot.uriString) {
      suggestionPanel.reveal(model, true);
      autoRevealedSuggestionUri = snapshot.uriString;
    }

    let projectIndex: WorkspaceProjectIndex | null = null;
    if (settings.useBackend) {
      projectIndex = await getWorkspaceProjectIndex();
      if (!isSnapshotStillActive(snapshot, backendScope)) {
        return activeSuggestionModel;
      }
      model = {
        ...buildLocalActiveSuggestion(snapshot, projectIndex),
        triggerKind: backendScope === 'cursor' ? 'cursor' : 'file',
        actionsVisible: false,
      };
      publishSuggestionModel(model, true);
    }

    if (settings.useBackend) {
      try {
        const fileSummaryRequest = getBackendSuggestionText(settings, snapshot, projectIndex, 'file_summary');
        const [focusOutputText, fileSummaryOutputText] = backendScope === 'cursor'
          ? await Promise.all([
            getBackendSuggestionText(settings, snapshot, projectIndex, 'cursor'),
            fileSummaryRequest,
          ])
          : [await fileSummaryRequest, ''];
        const backendModel = buildBackendActiveSuggestionModel(
          snapshot,
          projectIndex,
          backendScope,
          focusOutputText,
          fileSummaryOutputText,
        );
        if (backendModel) {
          model = backendModel;
        }
      } catch (error) {
        model = {
          ...model,
          source: 'local-fallback',
          backendError: truncateInline(String(error), 180),
          loading: false,
        };
        output.appendLine(
          `[Suggestions] Backend no disponible (${reason}, ${getBackendSuggestionScopeLabel(backendScope)}): ${String(error)}`,
        );
      }
    }

    if (!isSnapshotStillActive(snapshot, backendScope)) {
      return activeSuggestionModel;
    }
    const keepVisibleActions = backendScope === 'cursor'
      && !!activeSuggestionModel?.actionsVisible
      && activeSuggestionModel.uriString === snapshot.uriString
      && activeSuggestionModel.line === snapshot.line
      && activeSuggestionModel.column === snapshot.column;
    const finalModel = keepVisibleActions ? { ...model, actionsVisible: true } : model;
    publishSuggestionModel(finalModel, true);
    if (backendScope === 'file' && settings.autoRevealPanel && autoRevealedSuggestionUri !== finalModel.uriString) {
      suggestionPanel.reveal(finalModel, true);
      autoRevealedSuggestionUri = finalModel.uriString;
    }
    output.appendLine(`[Suggestions] ${finalModel.filePath} | scope=${backendScope} | fuente=${finalModel.source} | linea=${finalModel.line}`);
    return finalModel;
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

  const clearCursorSuggestionTimers = () => {
    if (cursorIdleSuggestionTimer) {
      clearTimeout(cursorIdleSuggestionTimer);
      cursorIdleSuggestionTimer = null;
    }
    if (cursorActionTimer) {
      clearTimeout(cursorActionTimer);
      cursorActionTimer = null;
    }
  };

  const hideSuggestionActions = () => {
    if (!activeSuggestionModel?.actionsVisible) {
      suggestionCodeLensProvider.update(activeSuggestionModel);
      return;
    }
    publishSuggestionModel({ ...activeSuggestionModel, actionsVisible: false }, true);
  };

  const revealSuggestionActions = async (anchor: CursorIdleAnchor | null) => {
    if (!anchor || !isCursorIdleAnchorStillActive(anchor)) {
      return;
    }

    let model = activeSuggestionModel;
    if (
      !model ||
      model.uriString !== anchor.uriString ||
      model.triggerKind !== 'cursor' ||
      model.line !== anchor.line + 1 ||
      model.column !== anchor.column + 1
    ) {
      model = await refreshActiveSuggestion('cursor-idle');
    }

    if (!model || !isCursorIdleAnchorStillActive(anchor)) {
      return;
    }

    publishSuggestionModel({ ...model, actionsVisible: true, triggerKind: 'cursor' }, true);
  };

  const scheduleCursorIdleSuggestionRefresh = () => {
    const settings = resolveActiveSuggestionSettings();
    clearCursorSuggestionTimers();
    if (!settings.enabled) {
      publishSuggestionModel(null, false);
      return;
    }

    const anchor = getCursorIdleAnchor();
    if (!anchor) {
      publishSuggestionModel(null, true);
      return;
    }

    if (activeSuggestionModel && activeSuggestionModel.uriString !== anchor.uriString) {
      publishSuggestionModel(null, true);
    } else {
      hideSuggestionActions();
    }

    cursorIdleSuggestionTimer = setTimeout(() => {
      cursorIdleSuggestionTimer = null;
      if (!isCursorIdleAnchorStillActive(anchor)) {
        return;
      }
      void refreshActiveSuggestion('cursor-idle');
    }, ACTIVE_SUGGESTION_CURSOR_IDLE_MS);

    cursorActionTimer = setTimeout(() => {
      cursorActionTimer = null;
      void revealSuggestionActions(anchor);
    }, ACTIVE_SUGGESTION_ACTION_IDLE_MS);
  };

  const applySuggestionCompletion = async (mode: 'insert' | 'replace' = 'insert') => {
    const editor = vscode.window.activeTextEditor;
    const model = activeSuggestionModel;
    if (!editor || !model || editor.document.uri.toString() !== model.uriString) {
      vscode.window.showInformationMessage('ADACEEN: no hay una sugerencia activa para aplicar.');
      return;
    }

    const modelLineIndex = Math.max(
      0,
      Math.min(editor.document.lineCount - 1, (Number(model.line) || editor.selection.active.line + 1) - 1),
    );
    const targetLine = editor.document.lineAt(modelLineIndex);
    const eol = getDocumentEol(editor.document);
    const rawCompletion = model.completionText || buildCompletionFallbackForModel(model, targetLine.text);
    const completionText = normalizeCompletionTextForEditor(rawCompletion, lineIndent(targetLine.text), eol);
    if (!completionText.trim()) {
      vscode.window.showInformationMessage('ADACEEN: la sugerencia no trae codigo aplicable.');
      return;
    }

    let editStart: vscode.Position;
    let insertedText = completionText;
    const applied = await editor.edit((editBuilder) => {
      if (mode === 'replace') {
        const range = editor.selection.isEmpty
          ? new vscode.Range(new vscode.Position(modelLineIndex, 0), targetLine.range.end)
          : getSelectedFullLineRange(editor);
        editStart = range.start;
        editBuilder.replace(range, completionText);
        return;
      }

      const insertLineIndex = editor.selection.isEmpty
        ? modelLineIndex
        : Math.min(editor.document.lineCount - 1, getSelectedFullLineRange(editor).end.line);
      const insertLine = editor.document.lineAt(insertLineIndex);
      if (editor.selection.isEmpty && !insertLine.text.trim()) {
        const range = new vscode.Range(new vscode.Position(insertLineIndex, 0), insertLine.range.end);
        editStart = range.start;
        editBuilder.replace(range, completionText);
        return;
      }

      editStart = insertLine.range.end;
      insertedText = `${eol}${completionText}`;
      editBuilder.insert(editStart, insertedText);
    });

    if (!applied) {
      vscode.window.showWarningMessage('ADACEEN: no se pudo aplicar la sugerencia en el editor.');
      return;
    }

    const finalOffset = editor.document.offsetAt(editStart!) + insertedText.length;
    const finalPosition = editor.document.positionAt(finalOffset);
    editor.selection = new vscode.Selection(finalPosition, finalPosition);
    publishSuggestionModel(null, true);
    scheduleCursorIdleSuggestionRefresh();
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

  const applySuggestionCompletionDisposable = vscode.commands.registerCommand(
    'adaceen.applySuggestionCompletion',
    async (mode?: string) => {
      await applySuggestionCompletion(mode === 'replace' ? 'replace' : 'insert');
    },
  );

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
    applySuggestionCompletionDisposable,
    suggestionPanel,
    suggestionCodeLensProvider,
    suggestionStatusBar,
    suggestionDecorationType,
    vscode.languages.registerCodeLensProvider(textDocumentSelector, suggestionCodeLensProvider),
    vscode.window.onDidChangeActiveTextEditor(() => {
      scheduleCursorIdleSuggestionRefresh();
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (vscode.window.activeTextEditor?.document.uri.toString() === event.textEditor.document.uri.toString()) {
        scheduleCursorIdleSuggestionRefresh();
        applySuggestionDecoration(suggestionDecorationType, activeSuggestionModel);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (vscode.window.activeTextEditor?.document.uri.toString() === event.document.uri.toString()) {
        applySuggestionDecoration(suggestionDecorationType, activeSuggestionModel);
        scheduleCursorIdleSuggestionRefresh();
      }
    }),
    vscode.workspace.onDidSaveTextDocument(() => {
      clearWorkspaceProjectIndexCache();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearWorkspaceProjectIndexCache();
      clearBackendSuggestionCaches();
      scheduleCursorIdleSuggestionRefresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('adaceen.suggestions') ||
        event.affectsConfiguration('adaceen.backend.baseUrl')
      ) {
        clearBackendSuggestionCaches();
        clearWorkspaceProjectIndexCache();
        scheduleCursorIdleSuggestionRefresh();
      }
    }),
    {
      dispose: () => {
        if (suggestionTimer) {
          clearTimeout(suggestionTimer);
          suggestionTimer = null;
        }
        clearCursorSuggestionTimers();
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

  scheduleCursorIdleSuggestionRefresh();
  void runWorkerCycle();
}

export function deactivate() {}
