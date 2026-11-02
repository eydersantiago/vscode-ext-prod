// ADACEEN (VS Code): lo que se manda al tutor en /suggest-tab: el contenido (archivo, foco, errores, proyecto) y la pregunta.
// Movido sin cambios desde src/active-suggestion.ts (solo se agrego "export" y los imports).
import * as vscode from 'vscode';
import { ACTIVE_SUGGESTION_SELECTION_MAX_LINES, ACTIVE_SUGGESTION_PROMPT_SELECTION_CHARS, ACTIVE_SUGGESTION_PROMPT_RELATED_CHARS, ACTIVE_SUGGESTION_PROMPT_OUTLINE_CHARS, ACTIVE_SUGGESTION_PROMPT_WINDOW_CHARS, ACTIVE_SUGGESTION_PROMPT_TOTAL_CHARS } from './constants';
import { isThirdPartyPath } from './dependency-project-files';
import { indexFilesInFolderOf } from './dependency-scan';
import type { SuggestDiagnostic } from './error-signals';
import { formatDependenciesForPrompt, resolveFileDependencies } from './file-dependencies';
import { formatRelatedDeclarations, selectRelatedFiles, formatOtherFilesLine, buildNumberedWindow, buildCodeOutline } from './prompt-context';
import type { EditorCodeAction } from './suggestion-code';
import { truncateInline } from './suggestion-results';
import type { ActiveEditorSnapshot, WorkspaceProjectIndex, BackendSuggestionRequestScope, SuggestionTrigger } from './types';
import { rankWorkspaceIndexEntries } from './workspace-index';

export function formatDiagnosticsForPrompt(diagnostics: SuggestDiagnostic[], max = 5) {
  if (!diagnostics.length) {
    return '';
  }
  return [
    'Errores y avisos del editor en este archivo:',
    ...diagnostics.slice(0, max).map((item) => `- Linea ${item.line} (${item.severity === 'error' ? 'error' : 'aviso'}): ${item.message}`),
  ].join('\n');
}

/**
 * Contexto que va al tutor en tab_content (0.0.35, revision de precision del 21/10/2026):
 * rotulos del archivo, el bloque seleccionado tal cual (es lo que se reemplaza), unas 100
 * lineas numeradas alrededor del foco con ">" en las del foco, la estructura del resto del
 * archivo, las declaraciones de los archivos relacionados y la lista corta de los demas.
 * Antes: los primeros 7200 caracteres del archivo (aunque el cursor estuviera mas abajo), el
 * texto visible repetido y un mapa de 24 archivos con vista previa. Ver prompt-context.ts.
 */
export function buildBackendSuggestionContent(
  snapshot: ActiveEditorSnapshot,
  projectIndex: WorkspaceProjectIndex | null = null,
  scope: BackendSuggestionRequestScope = 'file_summary',
  trigger?: SuggestionTrigger,
) {
  const isFileSummary = scope === 'file_summary';
  const blockingFocus = scope === 'cursor' && trigger === 'blocking';
  const hasSelection = !isFileSummary && !!snapshot.selectionText.trim();
  const selectionBlock = hasSelection
    ? [
      `Bloque seleccionado por el usuario: lineas ${snapshot.selectionStartLine}-${snapshot.selectionEndLine}`,
      snapshot.selectionTruncated
        ? `Aviso: la seleccion supero el limite de ${ACTIVE_SUGGESTION_SELECTION_MAX_LINES} lineas (tenia ${snapshot.selectionOriginalLineCount}); analiza solo este recorte inicial y menciona esa limitacion si afecta la respuesta.`
        : '',
      snapshot.selectionText.slice(0, ACTIVE_SUGGESTION_PROMPT_SELECTION_CHARS),
    ].filter(Boolean).join('\n')
    : '';
  const meta = [
    `Archivo activo: ${snapshot.filePath} (${snapshot.language}, ${snapshot.lineCount} lineas)`,
    snapshot.repoFullName ? `Repositorio: ${snapshot.repoFullName}` : '',
    isFileSummary ? '' : `Cursor: linea ${snapshot.line}, columna ${snapshot.column}`,
    blockingFocus
      ? 'Disparador: bloqueo detectado; el mismo error del editor sigue presente o se repite.'
      : scope === 'cursor' && !hasSelection && (trigger === 'cursor_idle' || !trigger) ? 'Disparador: cursor quieto durante 3 segundos; posible bloqueo del estudiante.' : '',
  ].filter(Boolean).join('\n');
  const diagnostics = blockingFocus ? formatDiagnosticsForPrompt(snapshot.diagnostics.items) : '';

  // Presupuesto: lo fijo primero; la ventana numerada se queda con lo que sobra hasta su tope.
  const ranked = rankWorkspaceIndexEntries(projectIndex, snapshot.filePath);
  const related = formatRelatedDeclarations(
    selectRelatedFiles(snapshot.filePath, snapshot.content, ranked, 3),
    ACTIVE_SUGGESTION_PROMPT_RELATED_CHARS,
  );
  // Lista corta (ruta, lenguaje, lineas): las vistas previas del mapa de antes casi no decian nada.
  const others = formatOtherFilesLine(ranked, snapshot.filePath, isFileSummary ? 20 : 8);
  // 0.0.36: en el resumen, lo que usa del proyecto, sus bibliotecas y quien lo usa (el mismo
  // calculo del cuadro «Dependencias», sin lo no encontrado: el indice no tiene todo). Solo para
  // un archivo de la carpeta abierta, comparado con los de su misma carpeta del proyecto (no el
  // codigo de un paquete instalado abierto con F12, igual que el cuadro).
  const documentUri = snapshot.uriString ? vscode.Uri.parse(snapshot.uriString) : null;
  const inWorkspace = !!documentUri && documentUri.scheme !== 'untitled' && !!vscode.workspace.getWorkspaceFolder(documentUri)
    && !isThirdPartyPath(snapshot.filePath);
  const dependencies = isFileSummary && projectIndex && documentUri && inWorkspace
    ? formatDependenciesForPrompt(resolveFileDependencies({
      activePath: snapshot.filePath,
      language: snapshot.language,
      text: snapshot.content,
      files: indexFilesInFolderOf(projectIndex, documentUri),
    }))
    : '';
  const fixedChars = meta.length + diagnostics.length + selectionBlock.length + related.length + others.length + dependencies.length
    + ACTIVE_SUGGESTION_PROMPT_OUTLINE_CHARS + 200;
  const windowChars = Math.max(1500, Math.min(ACTIVE_SUGGESTION_PROMPT_WINDOW_CHARS, ACTIVE_SUGGESTION_PROMPT_TOTAL_CHARS - fixedChars));
  const focusStart = isFileSummary ? 0 : hasSelection ? snapshot.selectionStartLine : snapshot.line;
  const focusEnd = isFileSummary ? 0 : hasSelection ? snapshot.selectionEndLine : snapshot.line;
  const promptContent = snapshot.promptContent ?? snapshot.content;
  const firstLine = snapshot.promptContent !== undefined ? snapshot.promptContentFirstLine || 1 : 1;
  const window = buildNumberedWindow(promptContent, { firstLine, focusStart, focusEnd, maxChars: windowChars });
  const windowBlock = window.text
    ? [
      isFileSummary
        ? `Codigo del archivo con numero de linea (lineas ${window.startLine}-${window.endLine} de ${snapshot.lineCount}):`
        : `Codigo alrededor del foco (lineas ${window.startLine}-${window.endLine} de ${snapshot.lineCount}; las lineas del foco llevan ">" antes de la barra):`,
      window.text,
    ].join('\n')
    : '';
  const coversFile = window.startLine <= 1 && window.endLine >= snapshot.lineCount;
  const outline = coversFile
    ? ''
    : buildCodeOutline(promptContent, snapshot.language, {
      firstLine,
      exclude: [window.startLine, window.endLine],
      maxChars: ACTIVE_SUGGESTION_PROMPT_OUTLINE_CHARS,
    });

  return [
    meta,
    diagnostics,
    selectionBlock,
    !isFileSummary && !hasSelection && snapshot.currentLineText.trim() ? `Linea actual:\n${snapshot.currentLineText}` : '',
    windowBlock,
    outline ? `Estructura del resto del archivo (numero de linea: declaracion):\n${outline}` : '',
    dependencies,
    related,
    others,
  ].filter(Boolean).join('\n\n');
}

/**
 * Lo que pide el estudiante, sin reglas de formato: el backend pone el formato, el limite de
 * la politica y las reglas del codigo al final del prompt (0.0.35). Antes la pregunta repetia
 * esas reglas con otras palabras y el modelo recibia dos versiones de lo mismo.
 */
export function buildBackendSuggestionQuestion(
  snapshot: ActiveEditorSnapshot,
  scope: BackendSuggestionRequestScope,
  trigger?: SuggestionTrigger,
  requestedAction?: EditorCodeAction,
) {
  if (scope === 'file_summary') {
    return 'Describe que hace el archivo activo y cual parece ser su papel dentro del proyecto, y da 3 sugerencias breves y accionables para continuar en ese archivo.';
  }

  const hasSelection = !!snapshot.selectionText.trim();
  const target = hasSelection
    ? `las lineas ${snapshot.selectionStartLine}-${snapshot.selectionEndLine} (el bloque seleccionado)`
    : `la linea ${snapshot.line}`;
  if (requestedAction === 'replace') {
    return `El estudiante pidio una version mejorada o corregida de ${target}.`;
  }
  if (requestedAction === 'insert') {
    return `El estudiante pidio codigo para continuar justo debajo de ${target}.`;
  }

  const visibleError = snapshot.diagnostics.firstError;
  if (trigger === 'blocking' && visibleError) {
    return [
      `El estudiante lleva un rato bloqueado con este error del editor en la linea ${visibleError.line}: "${truncateInline(visibleError.message, 300)}".`,
      'Explica la causa probable con palabras sencillas y da pistas para que lo corrija por su cuenta.',
    ].join(' ');
  }
  if (hasSelection) {
    return `El estudiante selecciono ${target} y espera una pista sobre ese bloque completo, no solo sobre la linea del cursor.`;
  }
  return trigger === 'cursor_idle' || !trigger
    ? `El cursor quedo quieto en la linea ${snapshot.line}; puede estar bloqueado. Da una pista para continuar desde esa linea.`
    : `El estudiante pide una pista para continuar desde la linea ${snapshot.line}.`;
}
