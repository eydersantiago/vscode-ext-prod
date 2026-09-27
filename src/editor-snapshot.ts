// ADACEEN (VS Code): foto del editor activo (texto visible, seleccion, diagnosticos) y anclas de inactividad del cursor.
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import * as vscode from 'vscode';
import { ACTIVE_SUGGESTION_PROMPT_SELECTION_CHARS, ACTIVE_SUGGESTION_SELECTION_MAX_LINES } from './constants';
import { summarizeDiagnostics } from './error-signals';
import type { DiagnosticLike, DiagnosticsSummary } from './error-signals';
import { detectRepoFullName } from './git-repo';
import { inferActiveLanguage, pathBaseName } from './suggestion-results';
import type { ActiveEditorSnapshot, ActiveSuggestionModel, ActiveSuggestionSettings, BackendSuggestionScope, CursorIdleAnchor } from './types';
import { stableStringHash } from './workspace-index';

export function hasActiveSelection(snapshot: Pick<ActiveEditorSnapshot, 'selectionText'>) {
  return Boolean(snapshot.selectionText.trim());
}

export function isSupportedActiveDocument(document: vscode.TextDocument) {
  if (document.uri.scheme === 'output' || document.uri.scheme === 'debug' || document.uri.scheme === 'vscode-chat') {
    return false;
  }
  if (document.isUntitled && !document.getText().trim()) {
    return false;
  }
  return true;
}

export function getVisibleEditorText(editor: vscode.TextEditor, maxChars: number) {
  const chunks: string[] = [];
  let size = 0;
  for (const range of editor.visibleRanges) {
    const text = editor.document.getText(range);
    if (!text) {
      continue;
    }
    chunks.push(text);
    size += text.length + 1;
    if (size >= maxChars) {
      break;
    }
  }
  return chunks.join('\n').slice(0, maxChars);
}

export function effectiveSelectionEndLine(selection: vscode.Selection) {
  if (!selection.isEmpty && selection.end.character === 0 && selection.end.line > selection.start.line) {
    return selection.end.line - 1;
  }
  return selection.end.line;
}

export function buildSelectionRangeKey(editor: vscode.TextEditor) {
  const selection = editor.selection;
  return [
    selection.start.line,
    selection.start.character,
    selection.end.line,
    selection.end.character,
    selection.active.line,
    selection.active.character,
    selection.isEmpty ? 'empty' : 'selection',
  ].join(':');
}

export function getSelectedEditorSnippet(editor: vscode.TextEditor, maxChars: number) {
  const selection = editor.selection;
  if (selection.isEmpty) {
    return {
      text: '',
      startLine: 0,
      endLine: 0,
      lineCount: 0,
      originalLineCount: 0,
      truncated: false,
      rangeKey: buildSelectionRangeKey(editor),
    };
  }

  const startLine = Math.max(0, Math.min(selection.start.line, editor.document.lineCount - 1));
  const effectiveEndLine = Math.max(startLine, Math.min(effectiveSelectionEndLine(selection), editor.document.lineCount - 1));
  const originalLineCount = Math.max(1, effectiveEndLine - startLine + 1);
  const limitedEndLine = Math.min(effectiveEndLine, startLine + ACTIVE_SUGGESTION_SELECTION_MAX_LINES - 1);
  const truncatedByLines = limitedEndLine < effectiveEndLine;
  const endPosition = truncatedByLines
    ? editor.document.lineAt(limitedEndLine).range.end
    : selection.end;
  const range = new vscode.Range(selection.start, endPosition);
  const rawText = editor.document.getText(range);
  const text = rawText.slice(0, maxChars);

  return {
    text,
    startLine: startLine + 1,
    endLine: limitedEndLine + 1,
    lineCount: Math.max(1, limitedEndLine - startLine + 1),
    originalLineCount,
    truncated: truncatedByLines,
    rangeKey: buildSelectionRangeKey(editor),
  };
}

export function diagnosticSeverityName(severity: vscode.DiagnosticSeverity): DiagnosticLike['severity'] {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'information';
    default:
      return 'hint';
  }
}

/** Errores y avisos que VS Code muestra ahora mismo para el documento. */
export function collectDocumentDiagnostics(uri: vscode.Uri): DiagnosticsSummary {
  let diagnostics: readonly vscode.Diagnostic[] = [];
  try {
    diagnostics = vscode.languages.getDiagnostics(uri);
  } catch {
    diagnostics = [];
  }
  return summarizeDiagnostics(diagnostics.map((item) => ({
    message: typeof item.message === 'string' ? item.message : String(item.message),
    severity: diagnosticSeverityName(item.severity),
    line: item.range.start.line + 1,
    character: item.range.start.character,
  })));
}

export async function buildActiveEditorSnapshot(settings: ActiveSuggestionSettings): Promise<ActiveEditorSnapshot | null> {
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
  const selection = getSelectedEditorSnippet(editor, ACTIVE_SUGGESTION_PROMPT_SELECTION_CHARS);
  const visibleText = getVisibleEditorText(editor, Math.min(settings.maxCodeChars, 12000));
  const language = inferActiveLanguage(filePath, document.languageId);
  const generatedAt = new Date().toISOString();
  const line = editor.selection.active.line + 1;
  const column = editor.selection.active.character + 1;
  const fileSummaryCacheKey = stableStringHash([
    repoFullName,
    filePath,
    language,
    content,
  ].join('\n---adaceen-file-summary---\n'));
  const cacheKey = stableStringHash([
    repoFullName,
    filePath,
    language,
    line,
    column,
    selection.startLine,
    selection.endLine,
    selection.lineCount,
    selection.originalLineCount,
    selection.truncated,
    selection.text,
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
    selectionText: selection.text,
    selectionStartLine: selection.startLine,
    selectionEndLine: selection.endLine,
    selectionLineCount: selection.lineCount,
    selectionOriginalLineCount: selection.originalLineCount,
    selectionTruncated: selection.truncated,
    selectionRangeKey: selection.rangeKey,
    visibleText,
    content,
    currentLineText,
    generatedAt,
    fileSummaryCacheKey,
    cacheKey,
    diagnostics: collectDocumentDiagnostics(document.uri),
  };
}

/** El archivo de la sugerencia sigue abierto en algun grupo del editor. */
export function isSuggestionModelDocumentVisible(model: ActiveSuggestionModel | null) {
  if (!model) {
    return false;
  }
  return vscode.window.visibleTextEditors.some((editor) => editor.document.uri.toString() === model.uriString);
}

export function isSnapshotStillActive(snapshot: ActiveEditorSnapshot, scope: BackendSuggestionScope) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== snapshot.uriString) {
    return false;
  }

  if (scope !== 'cursor') {
    return true;
  }

  return editor.selection.active.line + 1 === snapshot.line
    && editor.selection.active.character + 1 === snapshot.column
    && buildSelectionRangeKey(editor) === snapshot.selectionRangeKey;
}

export function getCursorIdleAnchor(): CursorIdleAnchor | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isSupportedActiveDocument(editor.document)) {
    return null;
  }

  return {
    uriString: editor.document.uri.toString(),
    version: editor.document.version,
    line: editor.selection.active.line,
    column: editor.selection.active.character,
    selectionRangeKey: buildSelectionRangeKey(editor),
  };
}

export function isCursorIdleAnchorStillActive(anchor: CursorIdleAnchor | null) {
  if (!anchor) {
    return false;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== anchor.uriString) {
    return false;
  }

  return editor.document.version === anchor.version
    && editor.selection.active.line === anchor.line
    && editor.selection.active.character === anchor.column
    && buildSelectionRangeKey(editor) === anchor.selectionRangeKey;
}
