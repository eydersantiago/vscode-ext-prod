import * as vscode from 'vscode';

const DEFAULT_INCLUDE_GLOB =
  '**/*.{ts,tsx,js,jsx,mjs,cjs,py,java,cpp,c,h,hpp,cs,go,rs,php,rb,md,json,yml,yaml,html,css,scss,sql,xml}';

const DEFAULT_EXCLUDE_GLOB =
  '**/{node_modules,.git,dist,build,out,coverage,.next,target,bin,obj,vendor,__pycache__}/**';

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_FILE_BYTES = 300 * 1024; // 300 KB por archivo
const DEFAULT_BACKEND_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_WORKER_POLL_MS = 8000;
const WORKER_TICK_MS = 4000;

type ScanMode = 'auto' | 'local' | 'codespace' | 'all';

type ScannedFile = {
  path: string;
  bytes: number;
  lines: number;
  preview: string;
  content: string;
};

type ScanCommandArgs = Partial<{
  mode: ScanMode | 'codespaces' | string;
  includeGlob: string;
  excludeGlob: string;
  maxFiles: number | string;
  maxFileBytes: number | string;
  maxFileKB: number | string;
}>;

type ScanOptions = {
  mode: ScanMode;
  includeGlob: string;
  excludeGlob: string;
  maxFiles: number;
  maxFileBytes: number;
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
};

type BackendSettings = {
  baseUrl: string;
  scanWorkerKey: string;
  autoWorkerEnabled: boolean;
  workerPollMs: number;
  workerId: string;
  requestTimeoutMs: number;
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

  return {
    mode,
    includeGlob,
    excludeGlob,
    maxFiles,
    maxFileBytes,
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

async function performWorkspaceScan(args: ScanCommandArgs | undefined, output: vscode.OutputChannel): Promise<ScanComputation> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    throw new Error('Abre una carpeta o workspace antes de escanear.');
  }

  const options = resolveScanOptions(args);
  const selection = selectFolders(options.mode, workspaceFolders);
  const files = await findWorkspaceFiles(selection.folders, options);

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
  output.appendLine('');

  for (const file of scan.payload.files) {
    output.appendLine(`• ${file.path}`);
    output.appendLine(`  Líneas: ${file.lines} | Bytes: ${file.bytes}`);
    output.appendLine(`  Preview: ${file.preview || '(sin contenido visible)'}`);
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
  await fetchJsonWithTimeout(
    `${settings.baseUrl}/api/projects/scan/request/${encodeURIComponent(requestId)}/result`,
    {
      method: 'POST',
      headers: buildWorkerHeaders(settings, true),
      body: JSON.stringify(payload),
    },
    settings.requestTimeoutMs,
  );
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

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('ADACEEN');
  const startupSettings = resolveBackendSettings();
  output.appendLine(
    `[Worker] Inicializado | auto=${startupSettings.autoWorkerEnabled} | backend=${startupSettings.baseUrl} | pollMs=${startupSettings.workerPollMs} | workerId=${startupSettings.workerId}`,
  );

  const disposable = vscode.commands.registerCommand(
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
      await sendScanResult(settings, request.id, payload);

      output.appendLine(
        `[Worker] Escaneo enviado al backend: ${request.repoFullName} (${payload.totalFiles} archivos).`,
      );
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
    disposable,
    output,
    {
      dispose: () => clearInterval(timer),
    },
  );

  void runWorkerCycle();
}

export function deactivate() {}
