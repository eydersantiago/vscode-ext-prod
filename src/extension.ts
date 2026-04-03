import * as vscode from 'vscode';

const DEFAULT_INCLUDE_GLOB =
  '**/*.{ts,tsx,js,jsx,mjs,cjs,py,java,cpp,c,h,hpp,cs,go,rs,php,rb,md,json,yml,yaml,html,css,scss,sql,xml}';

const DEFAULT_EXCLUDE_GLOB =
  '**/{node_modules,.git,dist,build,out,coverage,.next,target,bin,obj,vendor,__pycache__}/**';

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_FILE_BYTES = 300 * 1024; // 300 KB por archivo

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

function selectFolders(
  requestedMode: ScanMode,
  workspaceFolders: readonly vscode.WorkspaceFolder[]
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
    notes.push(
      `No se encontraron carpetas para modo "${resolvedMode}". Se usará todo el workspace.`
    );
    folders = workspaceFolders;
  }

  return { mode: resolvedMode, folders, notes };
}

async function findWorkspaceFiles(
  folders: readonly vscode.WorkspaceFolder[],
  options: ScanOptions
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
      remaining
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

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('ADACEEN');

  const disposable = vscode.commands.registerCommand(
    'adaceen.scanWorkspace',
    async (args?: ScanCommandArgs) => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) {
        vscode.window.showWarningMessage(
          'ADACEEN: abre una carpeta o workspace antes de escanear.'
        );
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'ADACEEN está leyendo el workspace...',
          cancellable: false,
        },
        async () => {
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
              output.appendLine(
                `No se pudo leer ${vscode.workspace.asRelativePath(uri, false)}: ${String(error)}`
              );
            }
          }

          output.clear();
          output.appendLine('=== ADACEEN / Resumen del workspace ===');
          output.appendLine(
            `Entorno detectado: ${
              isCodespaceRuntime() ? 'Codespace/remoto' : 'Local'
            }`
          );
          output.appendLine(
            `Modo solicitado: ${options.mode} | Modo aplicado: ${selection.mode}`
          );
          output.appendLine(
            `Include: ${options.includeGlob} | Exclude: ${options.excludeGlob}`
          );
          output.appendLine(
            `Límites: ${options.maxFiles} archivos, ${Math.round(
              options.maxFileBytes / 1024
            )} KB por archivo`
          );
          output.appendLine(
            `Carpetas usadas: ${selection.folders
              .map((folder) => `${folder.name} [${folder.uri.scheme}]`)
              .join(', ')}`
          );
          for (const note of selection.notes) {
            output.appendLine(`Nota: ${note}`);
          }
          output.appendLine(`Archivos leídos: ${results.length}`);
          output.appendLine(`Archivos omitidos por tamaño: ${skippedBySize}`);
          output.appendLine('');

          for (const file of results) {
            output.appendLine(`• ${file.path}`);
            output.appendLine(`  Líneas: ${file.lines} | Bytes: ${file.bytes}`);
            output.appendLine(`  Preview: ${file.preview || '(sin contenido visible)'}`);
            output.appendLine('');
          }

          output.appendLine('=== JSON listo para enviar a backend ===');
          output.appendLine(
            JSON.stringify(
              {
                runtime: {
                  remoteName: vscode.env.remoteName ?? null,
                  isCodespace: isCodespaceRuntime(),
                },
                mode: {
                  requested: options.mode,
                  applied: selection.mode,
                },
                workspaceFolders: workspaceFolders.map((f) => ({
                  name: f.name,
                  scheme: f.uri.scheme,
                })),
                selectedFolders: selection.folders.map((f) => ({
                  name: f.name,
                  scheme: f.uri.scheme,
                })),
                scannedAt: new Date().toISOString(),
                totalFiles: results.length,
                skippedBySize,
                files: results,
              },
              null,
              2
            )
          );

          output.show(true);

          vscode.window.showInformationMessage(
            `ADACEEN leyó ${results.length} archivos (${selection.mode}). Revisa Output.`
          );

          // Más adelante, aquí puedes mandar `results` a tu backend:
          // await fetch('https://tu-backend/api/analyze', {
          //   method: 'POST',
          //   headers: { 'Content-Type': 'application/json' },
          //   body: JSON.stringify({ files: results }),
          // });
        }
      );
    }
  );

  context.subscriptions.push(disposable, output);
}

export function deactivate() {}
