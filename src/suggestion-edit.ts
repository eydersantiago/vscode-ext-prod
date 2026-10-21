// ADACEEN (VS Code): de la sugerencia al cambio en el editor: completado sugerido, modo de aplicacion y plan de edicion.
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import * as vscode from 'vscode';
import { pickTextMatch } from './code-application-guard';
import { actionModeFromText, analyzedBlockMatches, normalizeActionProbe } from './suggestion-code';
import { truncateInline, uniqueCompactStrings } from './suggestion-results';
import type { ActiveEditorSnapshot, ActiveSuggestionModel, PendingCodeAction, SuggestionApplyMode } from './types';

// Movidas a suggestion-code.ts (sin vscode, con pruebas); se reexportan para los imports de siempre.
export { actionModeFromText, extractFirstCodeFence, normalizeActionProbe } from './suggestion-code';

export function countMatches(value: string, pattern: RegExp) {
  return (value.match(pattern) || []).length;
}

export function lineIndent(value: string) {
  return value.match(/^\s*/)?.[0] || '';
}

export function commentPrefixForLanguage(language: string, filePath: string) {
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

export function normalizeSuggestionForCode(value: string) {
  return truncateInline(value.replace(/\s+/g, ' ').replace(/[.;]\s*$/g, ''), 120);
}

export function getDocumentEol(document: vscode.TextDocument) {
  return document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

export function normalizeCompletionTextForEditor(rawText: string, indent: string, eol: string) {
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

export function inferSuggestionApplyMode(snapshot: ActiveEditorSnapshot, suggestionText: string, completionText: string): SuggestionApplyMode {
  const explicitMode = actionModeFromText(`${suggestionText}\n${completionText}`);
  if (explicitMode) {
    return explicitMode;
  }

  return 'insert';
}

export function suggestionApplyModeLabel(mode: SuggestionApplyMode) {
  if (mode === 'delete') {
    return 'Eliminar';
  }
  if (mode === 'replace') {
    return 'Modificar';
  }
  return 'Insertar';
}

export function actionTypeToApplyMode(actionType: string): SuggestionApplyMode {
  const probe = normalizeActionProbe(actionType);
  if (/\b(delete|remove|eliminar|borrar)\b/.test(probe)) {
    return 'delete';
  }
  if (/\b(insert|append|add|agregar|anadir|insertar)\b/.test(probe)) {
    return 'insert';
  }
  return 'replace';
}

export function buildAppliedSuggestionModel(
  model: ActiveSuggestionModel,
  mode: SuggestionApplyMode,
  finalPosition: vscode.Position,
): ActiveSuggestionModel {
  const appliedLine = finalPosition.line + 1;
  const appliedColumn = finalPosition.character + 1;
  const modeLabel = suggestionApplyModeLabel(mode).toLowerCase();
  const appliedMessage = `Ayuda aplicada (${modeLabel}) en la linea ${appliedLine}.`;
  const validationStep = mode === 'delete'
    ? 'Revisa que la eliminacion no haya quitado una condicion o cierre necesario.'
    : 'Ejecuta una validacion corta o revisa el resaltado del editor antes de pedir otra pista.';

  return {
    ...model,
    summary: model.summary || appliedMessage,
    lineSummary: appliedMessage,
    suggestions: uniqueCompactStrings([
      appliedMessage,
      ...model.suggestions,
    ], 5),
    lineSuggestions: uniqueCompactStrings([
      validationStep,
      ...model.lineSuggestions,
    ], 3),
    nextSteps: uniqueCompactStrings([
      validationStep,
      'Si el resultado no encaja, usa Deshacer y actualiza la sugerencia.',
      ...model.nextSteps,
    ], 4),
    updatedAt: new Date().toISOString(),
    line: appliedLine,
    column: appliedColumn,
    completionText: '',
    actionsVisible: false,
    loading: false,
    applied: true,
    appliedMode: mode,
  };
}

export function getSelectedFullLineRange(editor: vscode.TextEditor) {
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

export function getSelectedFullLineRangeIncludingBreak(editor: vscode.TextEditor) {
  const range = getSelectedFullLineRange(editor);
  if (range.end.line < editor.document.lineCount - 1) {
    return new vscode.Range(range.start, new vscode.Position(range.end.line + 1, 0));
  }
  return range;
}

export function getSuggestionDeleteRange(editor: vscode.TextEditor, modelLineIndex: number) {
  if (!editor.selection.isEmpty) {
    return getSelectedFullLineRangeIncludingBreak(editor);
  }
  return editor.document.lineAt(modelLineIndex).rangeIncludingLineBreak;
}

/**
 * Lineas completas del bloque que analizo el tutor, o null si la sugerencia no
 * salio de una seleccion (o es de antes de la 0.0.34 y no guardo el bloque).
 * 'stale': el documento ya no tiene ese texto en esas lineas.
 *
 * Revision del 20/10/2026: aplicar iba sobre la seleccion de ahora. Con mas de
 * 20 lineas seleccionadas el tutor solo veia las primeras 20 y «Modificar
 * selección» borraba las demas; y un clic dentro del bloque (seleccion vacia)
 * hacia que un bloque entero reemplazara una sola linea.
 */
export function getAnalyzedBlockRange(
  document: vscode.TextDocument,
  model: Pick<ActiveSuggestionModel, 'line' | 'selectionLineCount' | 'selectionText'>,
): vscode.Range | 'stale' | null {
  if (!model.selectionLineCount || model.selectionLineCount <= 0 || !String(model.selectionText || '').trim()) {
    return null;
  }
  const startLine = (Number(model.line) || 1) - 1;
  const endLine = startLine + model.selectionLineCount - 1;
  if (startLine < 0 || endLine > document.lineCount - 1) {
    return 'stale';
  }
  const blockLines: string[] = [];
  for (let line = startLine; line <= endLine; line += 1) {
    blockLines.push(document.lineAt(line).text);
  }
  if (!analyzedBlockMatches(blockLines, model.selectionText || '')) {
    return 'stale';
  }
  return new vscode.Range(new vscode.Position(startLine, 0), document.lineAt(endLine).range.end);
}

const STALE_BLOCK_MESSAGE = 'ADACEEN: el bloque cambió desde la sugerencia. Selecciónalo otra vez y pide «Otra sugerencia».';

export type SuggestionEditPlan =
  | { ok: false; message: string }
  | {
    ok: true;
    mode: SuggestionApplyMode;
    /** Operacion real sobre el documento (insertar en una linea vacia es un replace). */
    operation: 'delete' | 'replace' | 'insert';
    /** Rango afectado; al insertar, rango vacio en el punto de insercion. */
    range: vscode.Range;
    /** Texto que se escribe tal cual (con el salto de linea previo al insertar). */
    text: string;
    /** Texto que desaparece del archivo. */
    removedText: string;
    /** Codigo propuesto por el tutor, sin el salto de linea previo. */
    proposedText: string;
    /** Codigo de contexto para el quiz tras aceptar. */
    quizOriginalCode: string;
  };

/**
 * Calcula que cambio hace "aplicar sugerencia" en el editor, sin tocarlo.
 * Es la misma logica de siempre, separada para poder medir el cambio y
 * pasarlo por el guard de aplicacion antes de editar.
 */
export function planSuggestionEdit(
  editor: vscode.TextEditor,
  model: ActiveSuggestionModel,
  mode: SuggestionApplyMode,
): SuggestionEditPlan {
  const document = editor.document;
  const modelLineIndex = Math.max(
    0,
    Math.min(document.lineCount - 1, (Number(model.line) || editor.selection.active.line + 1) - 1),
  );
  const targetLine = document.lineAt(modelLineIndex);
  const eol = getDocumentEol(document);
  const analyzedBlock = getAnalyzedBlockRange(document, model);
  if (analyzedBlock === 'stale') {
    return { ok: false, message: STALE_BLOCK_MESSAGE };
  }

  if (mode === 'delete') {
    // «Eliminar selección» borra la seleccion de ahora; si ya no hay (un clic dentro del
    // bloque), el bloque que vio el tutor, no solo su primera linea.
    const range = editor.selection.isEmpty && analyzedBlock
      ? (analyzedBlock.end.line < document.lineCount - 1
        ? new vscode.Range(analyzedBlock.start, new vscode.Position(analyzedBlock.end.line + 1, 0))
        : analyzedBlock)
      : getSuggestionDeleteRange(editor, modelLineIndex);
    const deletedText = document.getText(range);
    if (!deletedText.trim()) {
      return { ok: false, message: 'ADACEEN: no hay codigo seleccionado o linea con contenido para eliminar.' };
    }
    return {
      ok: true,
      mode,
      operation: 'delete',
      range,
      text: '',
      removedText: deletedText,
      proposedText: '',
      quizOriginalCode: deletedText,
    };
  }

  // 0.0.34: solo el codigo que escribio el tutor; nunca un «TODO» inventado aqui.
  const completionText = normalizeCompletionTextForEditor(model.completionText || '', lineIndent(targetLine.text), eol);
  if (!completionText.trim()) {
    return { ok: false, message: 'ADACEEN: esta sugerencia no trae código para aplicar. Usa «Proponer una mejora» o «Otra sugerencia».' };
  }

  if (mode === 'replace') {
    const range = analyzedBlock
      || (editor.selection.isEmpty
        ? new vscode.Range(new vscode.Position(modelLineIndex, 0), targetLine.range.end)
        : getSelectedFullLineRange(editor));
    const originalCode = document.getText(range);
    return {
      ok: true,
      mode,
      operation: 'replace',
      range,
      text: completionText,
      removedText: originalCode,
      proposedText: completionText,
      quizOriginalCode: originalCode,
    };
  }

  const insertLineIndex = analyzedBlock
    ? analyzedBlock.end.line
    : editor.selection.isEmpty
      ? modelLineIndex
      : Math.min(document.lineCount - 1, getSelectedFullLineRange(editor).end.line);
  const insertLine = document.lineAt(insertLineIndex);
  const quizOriginalCode = analyzedBlock
    ? document.getText(analyzedBlock)
    : editor.selection.isEmpty
      ? insertLine.text
      : document.getText(getSelectedFullLineRange(editor));
  if (!analyzedBlock && editor.selection.isEmpty && !insertLine.text.trim()) {
    const range = new vscode.Range(new vscode.Position(insertLineIndex, 0), insertLine.range.end);
    return {
      ok: true,
      mode,
      operation: 'replace',
      range,
      text: completionText,
      removedText: document.getText(range),
      proposedText: completionText,
      quizOriginalCode,
    };
  }

  const insertPosition = insertLine.range.end;
  return {
    ok: true,
    mode,
    operation: 'insert',
    range: new vscode.Range(insertPosition, insertPosition),
    text: `${eol}${completionText}`,
    removedText: '',
    proposedText: completionText,
    quizOriginalCode,
  };
}

export function splitRelativePath(value: string) {
  const clean = value.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = clean.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.')) {
    return [];
  }
  return parts;
}

export async function uriExists(uri: vscode.Uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function resolveWorkspaceFileUri(filePath: string): Promise<vscode.Uri | null> {
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  const parts = splitRelativePath(filePath);
  if (!workspaceFolders.length || !parts.length) {
    return null;
  }

  for (const folder of workspaceFolders) {
    const candidates: string[][] = [parts];
    if (parts[0] === folder.name && parts.length > 1) {
      candidates.push(parts.slice(1));
    }

    for (const candidate of candidates) {
      const uri = vscode.Uri.joinPath(folder.uri, ...candidate);
      if (await uriExists(uri)) {
        return uri;
      }
    }
  }

  return null;
}

/**
 * Donde esta `needle` en el archivo (pickTextMatch): si aparece varias veces,
 * la copia que toca el cursor o la seleccion; si ninguna, la primera.
 */
export function findTextMatch(editor: vscode.TextEditor, needle: string) {
  const document = editor.document;
  const match = pickTextMatch(
    document.getText(),
    needle,
    document.offsetAt(editor.selection.start),
    document.offsetAt(editor.selection.end),
  );
  const range = match.index < 0
    ? null
    : new vscode.Range(document.positionAt(match.index), document.positionAt(match.index + needle.length));
  return { range, count: match.count, atFocus: match.atFocus };
}

export function metadataLineNumber(metadata: Record<string, unknown>) {
  const value = metadata.line;
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function rangeForCodeActionFallback(editor: vscode.TextEditor, action: PendingCodeAction): vscode.Range {
  const document = editor.document;
  const lineFromMetadata = metadataLineNumber(action.metadata);
  const actionType = action.actionType.toLowerCase();
  if (lineFromMetadata > 0 || actionType.includes('line')) {
    const lineIndex = Math.max(0, Math.min(document.lineCount - 1, (lineFromMetadata || editor.selection.active.line + 1) - 1));
    return document.lineAt(lineIndex).range;
  }

  if (!editor.selection.isEmpty) {
    return getSelectedFullLineRange(editor);
  }

  const activeLine = Math.max(0, Math.min(document.lineCount - 1, editor.selection.active.line));
  return document.lineAt(activeLine).range;
}
