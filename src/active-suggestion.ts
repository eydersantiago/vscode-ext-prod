// ADACEEN (VS Code): construir la sugerencia activa (local, del backend o bloqueada) y sus textos.
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import * as vscode from 'vscode';
import { buildSessionHeaders, fetchJsonWithTimeout } from './backend-http';
import { ACTIVE_SUGGESTION_PROMPT_OUTLINE_CHARS, ACTIVE_SUGGESTION_PROMPT_RELATED_CHARS, ACTIVE_SUGGESTION_PROMPT_SELECTION_CHARS, ACTIVE_SUGGESTION_PROMPT_TOTAL_CHARS, ACTIVE_SUGGESTION_PROMPT_WINDOW_CHARS, ACTIVE_SUGGESTION_SELECTION_MAX_LINES } from './constants';
import type { SuggestDiagnostic } from './error-signals';
import { indexFilesInFolderOf } from './dependency-scan';
import { formatDependenciesForPrompt, isThirdPartyPath, resolveFileDependencies } from './file-dependencies';
import { isCodespaceRuntime, resolveBackendSettings } from './settings';
import { DROPS_MOST_WARNING, extractSuggestionCode, prepareSuggestionCode, replacementDropsMostOfSelection, resolveSuggestionModes, suggestionReadyForMode } from './suggestion-code';
import type { EditorCodeAction } from './suggestion-code';
import { countMatches, inferSuggestionApplyMode } from './suggestion-edit';
import { parseBackendSuggestionSections } from './suggestion-format';
import { createEmptyBackendSuggestionResult, normalizeBackendSuggestionResult, truncateInline, uniqueCompactStrings } from './suggestion-results';
import type { ActiveEditorSnapshot, ActiveSuggestionModel, ActiveSuggestionSettings, BackendSuggestionRequestContext, BackendSuggestionRequestScope, BackendSuggestionResult, BackendSuggestionScope, BackendSuggestionSections, SuggestionTrigger, WorkspaceProjectIndex } from './types';
import { buildCodeOutline, buildNumberedWindow, formatOtherFilesLine, formatRelatedDeclarations, selectRelatedFiles } from './prompt-context';
import { buildLocalFileOverview, rankWorkspaceIndexEntries, stableStringHash } from './workspace-index';

export function buildSelectionSpecificGuidance(snapshot: ActiveEditorSnapshot) {
  const selected = snapshot.selectionText.trim();
  if (!selected) {
    return '';
  }

  const lowerPath = snapshot.filePath.toLowerCase();
  const language = snapshot.language.toLowerCase();
  if (/export\s+const\s+metadata\b|metadata\s*:\s*metadata\b/i.test(selected)) {
    return 'La seleccion define metadata exportada; revisa que title, description y generator describan exactamente esta pantalla antes de tocar el layout.';
  }
  if (/^import\s.+from\s+['"]/m.test(selected) || selected.split(/\r?\n/).every((line) => /^\s*import\b/.test(line) || !line.trim())) {
    return 'La seleccion contiene imports; valida cuales se usan realmente y evita cambiar dependencias sin confirmar referencias en el archivo.';
  }
  if (/\bfunction\s+\w+|=>\s*[{(]|return\s*\(/.test(selected)) {
    return 'La seleccion contiene logica ejecutable; identifica entradas, estado usado y salida renderizada antes de modificar el bloque.';
  }
  if (/<[A-Z][A-Za-z0-9]*|className=|children\b/.test(selected)) {
    return 'La seleccion contiene JSX; revisa jerarquia, props y clases aplicadas antes de insertar o reemplazar UI.';
  }
  if (language.includes('typescript') || /\.(tsx?|jsx?)$/i.test(lowerPath)) {
    return 'La seleccion es codigo de TypeScript/React; valida tipos, imports y efecto en render antes de cambiarla.';
  }
  if (selected.length <= 280) {
    return `La seleccion concreta es: ${truncateInline(selected.replace(/\s+/g, ' '), 220)}.`;
  }
  return 'ADACEEN ya capturo el bloque seleccionado; enfoca la ayuda en ese recorte y no en el archivo completo.';
}

export function buildLocalActiveSuggestion(
  snapshot: ActiveEditorSnapshot,
  projectIndex: WorkspaceProjectIndex | null = null,
): ActiveSuggestionModel {
  const code = snapshot.content;
  const lowerPath = snapshot.filePath.toLowerCase();
  const language = snapshot.language.toLowerCase();
  const suggestions: string[] = [];
  const nextSteps: string[] = [];
  const fileOverview = buildLocalFileOverview(snapshot, projectIndex);
  const hasSelection = !!snapshot.selectionText.trim();
  const selectionLimitNote = snapshot.selectionTruncated
    ? ` La seleccion original tenia ${snapshot.selectionOriginalLineCount} lineas; ADACEEN analizo las primeras ${snapshot.selectionLineCount} lineas.`
    : '';
  const selectionSpecificGuidance = buildSelectionSpecificGuidance(snapshot);

  if (hasSelection) {
    if (selectionSpecificGuidance) {
      suggestions.push(selectionSpecificGuidance);
    }
    suggestions.push(
      `Analiza el bloque seleccionado completo (${snapshot.selectionLineCount} linea(s), ${snapshot.selectionStartLine}-${snapshot.selectionEndLine}) antes de proponer cambios.${selectionLimitNote}`,
    );
    nextSteps.push('Trabaja sobre la seleccion como unidad: identifica entrada, efecto y salida del bloque antes de editar.');
  } else if (snapshot.currentLineText.trim()) {
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
    hasSelection
      ? `seleccion ${snapshot.selectionLineCount}${snapshot.selectionTruncated ? `/${snapshot.selectionOriginalLineCount}` : ''} lineas`
      : `cursor linea ${snapshot.line}`,
    isCodespaceRuntime() ? 'Codespaces' : 'VS Code',
  ], 5);
  const compactSuggestions = uniqueCompactStrings(suggestions, 4);
  const focusLine = hasSelection ? snapshot.selectionStartLine : snapshot.line;
  const focusColumn = hasSelection ? 1 : snapshot.column;
  // La pista local no escribe codigo (0.0.34): antes inventaba un «TODO: ...» que
  // «Modificar seleccion» llegaba a poner en lugar del bloque del estudiante.
  const completionText = '';
  const applyMode = inferSuggestionApplyMode(
    snapshot,
    `${compactSuggestions.join('\n')}\n${nextSteps.join('\n')}`,
    completionText,
  );

  return {
    uriString: snapshot.uriString,
    filePath: snapshot.filePath,
    fileName: snapshot.fileName,
    language: snapshot.language,
    repoFullName: snapshot.repoFullName,
    title: `Sugerencias para ${snapshot.fileName}`,
    summary: fileOverview || `Archivo activo: ${snapshot.filePath} (${snapshot.language}, linea ${snapshot.line}).`,
    fileOverview,
    lineSummary: hasSelection
      ? `Foco actual: seleccion lineas ${snapshot.selectionStartLine}-${snapshot.selectionEndLine} (${snapshot.selectionLineCount} linea(s) analizadas${snapshot.selectionTruncated ? ` de ${snapshot.selectionOriginalLineCount}` : ''}).`
      : snapshot.currentLineText.trim()
        ? `Foco actual: linea ${snapshot.line}.`
      : '',
    suggestions: compactSuggestions,
    fileSuggestions: compactSuggestions,
    lineSuggestions: snapshot.currentLineText.trim() ? compactSuggestions.slice(0, 2) : [],
    nextSteps: uniqueCompactStrings(nextSteps, 3),
    chips,
    source: 'local',
    backendError: '',
    ragSources: [],
    ragCourseCode: '',
    updatedAt: new Date().toISOString(),
    line: focusLine,
    column: focusColumn,
    selectionLineCount: snapshot.selectionLineCount,
    selectionOriginalLineCount: snapshot.selectionOriginalLineCount,
    selectionTruncated: snapshot.selectionTruncated,
    selectionRangeKey: snapshot.selectionRangeKey,
    ...(hasSelection ? { selectionText: snapshot.selectionText } : {}),
    fileSummaryCacheKey: snapshot.fileSummaryCacheKey,
    metricId: stableStringHash([
      snapshot.cacheKey,
      fileOverview,
      compactSuggestions.join('\n'),
      'local',
    ].join('\n---adaceen-metric---\n')),
    completionText,
    completionMode: '',
    applyMode,
    triggerKind: 'cursor',
    actionsVisible: false,
  };
}

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

export async function fetchBackendSuggestionText(
  settings: ActiveSuggestionSettings,
  snapshot: ActiveEditorSnapshot,
  projectIndex: WorkspaceProjectIndex | null = null,
  scope: BackendSuggestionRequestScope,
  requestContext: BackendSuggestionRequestContext,
): Promise<BackendSuggestionResult> {
  const backend = resolveBackendSettings();
  if (!backend.baseUrl) {
    return createEmptyBackendSuggestionResult();
  }

  const visibleError = snapshot.diagnostics.firstError?.message || '';
  const startedAt = Date.now();
  const response = await fetchJsonWithTimeout(
    `${backend.baseUrl}/suggest-tab`,
    {
      method: 'POST',
      headers: buildSessionHeaders(backend, true),
      body: JSON.stringify({
        tab_content: buildBackendSuggestionContent(snapshot, projectIndex, scope, requestContext.trigger),
        question: buildBackendSuggestionQuestion(snapshot, scope, requestContext.trigger, requestContext.requestedAction),
        tab_title: snapshot.filePath,
        tab_url: `vscode://${snapshot.repoFullName || snapshot.workspaceName || 'workspace'}/${snapshot.filePath}`,
        suggestion_scope: scope,
        repoFullName: snapshot.repoFullName,
        filePath: snapshot.filePath,
        languageHint: snapshot.language,
        selection: snapshot.selectionText,
        selectionStartLine: snapshot.selectionStartLine,
        selectionEndLine: snapshot.selectionEndLine,
        selectionLineCount: snapshot.selectionLineCount,
        selectionOriginalLineCount: snapshot.selectionOriginalLineCount,
        selectionTruncated: snapshot.selectionTruncated,
        selectionMaxLines: ACTIVE_SUGGESTION_SELECTION_MAX_LINES,
        cursorLine: snapshot.line,
        cursorColumn: snapshot.column,
        currentLineText: snapshot.currentLineText,
        courseCode: settings.ragCourseCode,
        ragCourseCode: settings.ragCourseCode,
        // Contrato v1.1 (A9.10): origen real de la peticion y errores del editor.
        trigger: requestContext.trigger,
        // 0.0.34: el estudiante pidio el codigo de una accion (Proponer una mejora / codigo debajo).
        ...(scope === 'cursor' && requestContext.requestedAction ? { requestedAction: requestContext.requestedAction } : {}),
        ...(visibleError ? { visibleError: visibleError.slice(0, 2000) } : {}),
        ...(snapshot.diagnostics.items.length ? { diagnostics: snapshot.diagnostics.items } : {}),
        clientSessionId: requestContext.clientSessionId,
      }),
    },
    settings.backendTimeoutMs,
  );

  return normalizeBackendSuggestionResult(response, Date.now() - startedAt);
}

export const DEFAULT_BLOCKED_TUTOR_MESSAGE =
  'Tu docente configuró que en este momento el tutor responda sin código. Intenta el siguiente paso por tu cuenta y vuelve a pedir ayuda si sigues con dudas.';

/**
 * Respuesta bloqueada por la politica del docente (blocked=true): el
 * output_text es un mensaje controlado en Markdown y no se ofrece aplicar
 * codigo (completionText vacio, blocked=true).
 */
export function buildBlockedSuggestionModel(
  snapshot: ActiveEditorSnapshot,
  projectIndex: WorkspaceProjectIndex | null,
  scope: BackendSuggestionScope,
  blockedResult: BackendSuggestionResult,
  otherResult: BackendSuggestionResult,
  backendError: string,
  trigger?: SuggestionTrigger,
): ActiveSuggestionModel {
  const localFallback = buildLocalActiveSuggestion(snapshot, projectIndex);
  const message = blockedResult.outputText.trim()
    || blockedResult.policyApplied?.reason
    || DEFAULT_BLOCKED_TUTOR_MESSAGE;
  const sections = parseBackendSuggestionSections(message);
  const lines = uniqueCompactStrings(sections.all.length ? sections.all : [message.replace(/\s+/g, ' ')], 5);
  const headline = truncateInline(lines[0] || 'Mensaje del tutor', 260);
  const otherSections = otherResult.outputText && !otherResult.blocked
    ? parseBackendSuggestionSections(otherResult.outputText)
    : null;
  const otherLines = otherSections
    ? (otherSections.sugerencias.length ? otherSections.sugerencias : otherSections.all)
    : [];
  const fileOverview = otherSections?.resumen.length
    ? truncateInline(otherSections.resumen.join(' '), 420)
    : localFallback.fileOverview;
  const ragCourseCode = blockedResult.ragCourseCode || otherResult.ragCourseCode;
  return {
    ...localFallback,
    title: `ADACEEN en ${snapshot.fileName}`,
    summary: headline,
    fileOverview,
    lineSummary: scope === 'cursor' ? headline : '',
    suggestions: lines,
    fileSuggestions: scope === 'cursor'
      ? uniqueCompactStrings(otherLines.length ? otherLines : localFallback.fileSuggestions, 4)
      : lines.slice(0, 4),
    lineSuggestions: scope === 'cursor' ? lines.slice(0, 3) : [],
    nextSteps: lines.slice(1, 4).length ? lines.slice(1, 4) : localFallback.nextSteps,
    source: 'backend',
    backendError: backendError ? truncateInline(backendError, 180) : '',
    ragSources: blockedResult.ragSources.length ? blockedResult.ragSources : otherResult.ragSources,
    ragCourseCode,
    updatedAt: new Date().toISOString(),
    metricId: stableStringHash([
      snapshot.cacheKey,
      scope,
      'blocked',
      message,
      blockedResult.decisionId,
      ragCourseCode,
    ].join('\n---adaceen-metric---\n')),
    completionText: '',
    triggerKind: scope === 'cursor' ? 'cursor' : 'file',
    actionsVisible: false,
    decisionId: blockedResult.decisionId || undefined,
    policyApplied: blockedResult.policyApplied,
    codeApplication: blockedResult.codeApplication,
    blocked: true,
    tutorMessage: message,
    trigger,
  };
}

export function buildBackendActiveSuggestionModel(
  snapshot: ActiveEditorSnapshot,
  projectIndex: WorkspaceProjectIndex | null,
  scope: BackendSuggestionScope,
  focusResult: BackendSuggestionResult,
  fileSummaryResult: BackendSuggestionResult = createEmptyBackendSuggestionResult(),
  backendError = '',
  trigger?: SuggestionTrigger,
  requestedAction?: EditorCodeAction,
): ActiveSuggestionModel | null {
  const focusOutputText = focusResult.outputText;
  const fileSummaryOutputText = fileSummaryResult.outputText;
  // La decision que manda es la del foco; si el foco fallo, la del resumen.
  const primaryResult = focusOutputText || focusResult.blocked ? focusResult : fileSummaryResult;
  if (primaryResult.blocked) {
    const otherResult = primaryResult === focusResult ? fileSummaryResult : focusResult;
    return buildBlockedSuggestionModel(snapshot, projectIndex, scope, primaryResult, otherResult, backendError, trigger);
  }
  if (!focusOutputText && !fileSummaryOutputText) {
    return null;
  }

  const emptySections: BackendSuggestionSections = { resumen: [], sugerencias: [], riesgos: [], all: [] };
  const focusSections = focusOutputText
    ? parseBackendSuggestionSections(focusOutputText)
    : emptySections;
  // Sin resumen de archivo del backend se usa la pista local del archivo,
  // nunca las secciones del foco: eso hacia que el "resumen de archivo"
  // repitiera palabra por palabra lo dicho sobre la seleccion.
  const fileSummarySections = fileSummaryOutputText
    ? parseBackendSuggestionSections(fileSummaryOutputText)
    : emptySections;
  // Codigo solo del bloque del modelo (un bloque de puros comentarios no cuenta) y
  // la accion de la linea "Aplicar:" del foco, la que pidio el estudiante o la que
  // dice el contenido (0.0.34). El resumen del archivo no decide la accion: siempre
  // trae su propio "Aplicar:".
  const resolvedModes = resolveSuggestionModes({
    focusText: focusOutputText,
    code: extractSuggestionCode(focusOutputText),
    requestedAction,
    fallbackText: focusOutputText || fileSummaryResult.outputText,
    selection: snapshot.selectionText,
  });
  // 0.0.35: sin el margen numerado si el modelo lo copio, con los «...» completados con el
  // bloque original y sin ofrecer con un clic una version que deja llaves sin cerrar.
  const prepared = prepareSuggestionCode(resolvedModes.completionText, {
    selection: snapshot.selectionText,
    mode: resolvedModes.completionMode,
    language: snapshot.language,
  });
  const modes = prepared.unusable
    ? { ...resolvedModes, completionMode: '' as const, completionText: '' }
    : { ...resolvedModes, completionText: prepared.code };
  // Una respuesta que es solo la linea "Aplicar:" y el bloque de codigo tambien vale
  // (antes se descartaba por no traer texto fuera del bloque).
  const codeOnlyHeadline = modes.completionText
    ? (modes.completionMode === 'replace'
      ? 'El tutor propone una versión mejorada del bloque.'
      : 'El tutor propone código para continuar.')
    : prepared.unusable
      // Escribio codigo, pero no se puede aplicar tal cual: la sugerencia se muestra con el motivo.
      ? 'El tutor propuso código que no se puede aplicar tal cual.'
      : '';
  const sectionFocusLines = focusSections.sugerencias.length > 0 ? focusSections.sugerencias : focusSections.all;
  const focusLines = sectionFocusLines.length > 0 ? sectionFocusLines : (codeOnlyHeadline ? [codeOnlyHeadline] : []);
  const fileLines = fileSummarySections.sugerencias.length > 0
    ? fileSummarySections.sugerencias
    : fileSummarySections.all;
  if (focusLines.length === 0 && fileLines.length === 0) {
    return null;
  }

  const localFallback = buildLocalActiveSuggestion(snapshot, projectIndex);
  const fileOverview = fileSummarySections.resumen.length > 0
    ? truncateInline(fileSummarySections.resumen.join(' '), 420)
    : localFallback.fileOverview;
  const focusSummary = focusSections.resumen.length > 0
    ? truncateInline(focusSections.resumen.join(' '), 420)
    : codeOnlyHeadline;
  const completionText = modes.completionText;
  const applyMode = modes.applyMode;
  const fileSuggestions = uniqueCompactStrings(
    fileLines.length ? fileLines : localFallback.fileSuggestions,
    4,
  );
  const lineSuggestions = scope === 'cursor'
    ? uniqueCompactStrings(focusLines.length ? focusLines : localFallback.lineSuggestions, 3)
    : [];
  const combinedSuggestions = uniqueCompactStrings([
    ...(lineSuggestions.length ? lineSuggestions : focusLines),
    ...fileSuggestions,
  ], 5);
  const ragSources = focusResult.ragSources.length ? focusResult.ragSources : fileSummaryResult.ragSources;
  const ragCourseCode = focusResult.ragCourseCode || fileSummaryResult.ragCourseCode;
  return {
    ...localFallback,
    title: `ADACEEN en ${snapshot.fileName}`,
    summary: scope === 'cursor'
      ? focusSummary || fileOverview || truncateInline(focusOutputText.replace(/\s+/g, ' '), 260)
      : fileOverview || truncateInline(focusOutputText.replace(/\s+/g, ' '), 260),
    fileOverview,
    lineSummary: scope === 'cursor'
      ? focusSummary || localFallback.lineSummary || `Foco actual: linea ${snapshot.line}.`
      : '',
    suggestions: combinedSuggestions,
    fileSuggestions,
    lineSuggestions,
    nextSteps: combinedSuggestions.slice(1, 4).length > 0 ? combinedSuggestions.slice(1, 4) : localFallback.nextSteps,
    source: 'backend',
    backendError: backendError ? truncateInline(backendError, 180) : '',
    ragSources,
    ragCourseCode,
    updatedAt: new Date().toISOString(),
    metricId: stableStringHash([
      snapshot.cacheKey,
      scope,
      focusOutputText,
      fileSummaryResult.outputText,
      ragCourseCode,
    ].join('\n---adaceen-metric---\n')),
    completionText,
    completionMode: modes.completionMode,
    applyMode,
    triggerKind: scope === 'cursor' ? 'cursor' : 'file',
    actionsVisible: false,
    decisionId: primaryResult.decisionId || focusResult.decisionId || fileSummaryResult.decisionId || undefined,
    policyApplied: primaryResult.policyApplied,
    codeApplication: primaryResult.codeApplication,
    blocked: false,
    trigger,
    ...(requestedAction ? { requestedAction } : {}),
    fileOverviewFromTutor: fileSummarySections.resumen.length > 0,
    proposalWarning: [
      modes.completionMode === 'replace' && replacementDropsMostOfSelection(snapshot.selectionText, completionText) ? DROPS_MOST_WARNING : '',
      ...prepared.notes,
    ].filter(Boolean).join(' '),
    ...(prepared.unusable ? { codeRequestNote: prepared.unusableReason } : {}),
  };
}

/** Se ofrece aplicar codigo para este modelo (no bloqueado y permitido por la politica). */
export function isSuggestionApplyOffered(model: ActiveSuggestionModel) {
  return !model.blocked && model.codeApplication?.allowed !== false;
}

/**
 * La accion recomendada se puede aplicar con un clic: la politica lo permite y,
 * salvo eliminar, el tutor ya escribio el codigo para esa accion (CodeLens,
 * pista en linea y arreglo rapido solo ofrecen «Aceptar ayuda» en ese caso).
 */
export function isRecommendedActionReady(model: ActiveSuggestionModel) {
  return isSuggestionApplyOffered(model) && suggestionReadyForMode(model, model.applyMode || 'insert');
}

/** Nota discreta sobre la aplicacion de codigo para mostrar junto a la sugerencia. */
export function suggestionApplicationNote(model: ActiveSuggestionModel) {
  const codeApplication = model.codeApplication;
  if (!codeApplication || model.blocked) {
    return '';
  }
  if (codeApplication.allowed === false) {
    return codeApplication.reason || 'Tu docente no permite aplicar código aquí; úsalo como guía y escríbelo tú.';
  }
  if (codeApplication.remaining !== null) {
    return codeApplication.remaining === 1
      ? 'Te queda 1 aplicación en este archivo.'
      : `Te quedan ${codeApplication.remaining} aplicaciones en este archivo.`;
  }
  return '';
}

export function summarizeActiveSuggestion(model: ActiveSuggestionModel) {
  return uniqueCompactStrings([
    model.lineSummary,
    ...model.lineSuggestions,
    ...model.fileSuggestions,
  ], 5).join('\n');
}

export function primarySuggestionText(model: ActiveSuggestionModel) {
  return model.lineSuggestions[0] ||
    model.fileSuggestions[0] ||
    model.suggestions[0] ||
    model.summary ||
    model.fileOverview;
}
