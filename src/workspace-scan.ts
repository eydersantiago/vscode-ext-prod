// ADACEEN (VS Code): escaneo del espacio de trabajo (carpetas, archivos y documentos) y su salida.
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import * as vscode from 'vscode';
import { DOCUMENT_EXTENSIONS } from './constants';
import { isCodespaceRuntime, resolveScanOptions } from './settings';
import type { ScanCommandArgs, ScanComputation, ScanMode, ScanOptions, ScanPayload, ScannedDocument, ScannedFile } from './types';

export function selectFolders(
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

export async function findWorkspaceFiles(
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

export function getDocumentExtension(uri: vscode.Uri) {
  const lastSegment = uri.path.split('/').pop() || '';
  const index = lastSegment.lastIndexOf('.');
  return index >= 0 ? lastSegment.slice(index + 1).toLowerCase() : '';
}

export function normalizeDocumentName(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function scoreDocumentName(value: string) {
  const text = normalizeDocumentName(value);
  let score = 0;
  if (/\bbitacora\b/.test(text)) {
    score += 120;
  }
  if (/\blogbook\b/.test(text)) {
    score += 100;
  }
  if (/diario[-_\s]+de[-_\s]+campo/.test(text)) {
    score += 95;
  }
  if (/registro[-_\s]+(de[-_\s]+)?actividades/.test(text)) {
    score += 90;
  }
  if (/seguimiento[-_\s]+semanal/.test(text)) {
    score += 85;
  }
  if (/registro[-_\s]+(de[-_\s]+)?avance/.test(text)) {
    score += 80;
  }
  if (/\bavance(s)?\b/.test(text)) {
    score += 25;
  }
  if (/\bsemana[-_\s]*\d{1,2}\b/.test(text)) {
    score += 20;
  }
  return score;
}

export async function findWorkspaceDocuments(
  folders: readonly vscode.WorkspaceFolder[],
  options: ScanOptions,
  output: vscode.OutputChannel,
): Promise<ScannedDocument[]> {
  const found = new Map<string, vscode.Uri>();

  for (const folder of folders) {
    const remaining = options.maxDocuments - found.size;
    if (remaining <= 0) {
      break;
    }

    const includePattern = new vscode.RelativePattern(folder, options.documentIncludeGlob);
    const excludePattern = new vscode.RelativePattern(folder, options.excludeGlob);
    const files = await vscode.workspace.findFiles(includePattern, excludePattern, remaining * 3);

    for (const fileUri of files) {
      const extension = getDocumentExtension(fileUri);
      if (!DOCUMENT_EXTENSIONS.has(extension)) {
        continue;
      }
      const key = fileUri.toString();
      if (!found.has(key)) {
        found.set(key, fileUri);
      }
      if (found.size >= options.maxDocuments) {
        break;
      }
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

export async function performWorkspaceScan(args: ScanCommandArgs | undefined, output: vscode.OutputChannel): Promise<ScanComputation> {
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

export function renderScanOutput(output: vscode.OutputChannel, scan: ScanComputation) {
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
