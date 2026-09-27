// ADACEEN (VS Code): indice del proyecto que acompana la pregunta al backend.
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import * as vscode from 'vscode';
import { ACTIVE_SUGGESTION_INDEX_MAX_FILES, ACTIVE_SUGGESTION_INDEX_MAX_FILE_KB, ACTIVE_SUGGESTION_INDEX_PREVIEW_CHARS, ACTIVE_SUGGESTION_PROMPT_INDEX_MAX_FILES, ACTIVE_SUGGESTION_PROMPT_INDEX_PREVIEW_CHARS } from './constants';
import { resolveScanOptions } from './settings';
import { inferActiveLanguage, pathExtension, truncateInline } from './suggestion-results';
import type { ActiveEditorSnapshot, WorkspaceProjectIndex, WorkspaceProjectIndexEntry } from './types';
import { findWorkspaceFiles, selectFolders } from './workspace-scan';

export function stableStringHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function getWorkspaceProjectIndexIdentity() {
  const folders = vscode.workspace.workspaceFolders || [];
  return folders
    .map((folder) => `${folder.uri.scheme}:${folder.uri.toString()}`)
    .sort()
    .join('|');
}

export function prioritizeWorkspaceIndexEntry(entry: WorkspaceProjectIndexEntry, activePath: string) {
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

export async function buildWorkspaceProjectIndexForSuggestions(output: vscode.OutputChannel): Promise<WorkspaceProjectIndex | null> {
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

export function formatWorkspaceProjectIndexForPrompt(index: WorkspaceProjectIndex | null, activePath: string) {
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

export function extractSymbolNames(code: string, language: string) {
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

export function inferFileRoleFromPath(filePath: string) {
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

export function findRelatedWorkspacePaths(index: WorkspaceProjectIndex | null, filePath: string) {
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

export function buildLocalFileOverview(snapshot: ActiveEditorSnapshot, index: WorkspaceProjectIndex | null = null) {
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
