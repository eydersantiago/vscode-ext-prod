// ADACEEN (VS Code): construir la sugerencia activa (local, del backend o bloqueada) y sus textos.
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import { buildSessionHeaders, fetchJsonWithTimeout } from './backend-http';
import { ACTIVE_SUGGESTION_PROMPT_CODE_CHARS, ACTIVE_SUGGESTION_PROMPT_SELECTION_CHARS, ACTIVE_SUGGESTION_PROMPT_VISIBLE_CHARS, ACTIVE_SUGGESTION_SELECTION_MAX_LINES } from './constants';
import type { SuggestDiagnostic } from './error-signals';
import { isCodespaceRuntime, resolveBackendSettings } from './settings';
import { buildSuggestedCompletion, countMatches, extractFirstCodeFence, inferSuggestionApplyMode } from './suggestion-edit';
import { parseBackendSuggestionSections } from './suggestion-format';
import { createEmptyBackendSuggestionResult, normalizeBackendSuggestionResult, truncateInline, uniqueCompactStrings } from './suggestion-results';
import type { ActiveEditorSnapshot, ActiveSuggestionModel, ActiveSuggestionSettings, BackendSuggestionRequestContext, BackendSuggestionRequestScope, BackendSuggestionResult, BackendSuggestionScope, BackendSuggestionSections, SuggestionTrigger, WorkspaceProjectIndex } from './types';
import { buildLocalFileOverview, formatWorkspaceProjectIndexForPrompt, stableStringHash } from './workspace-index';

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
  const completionText = buildSuggestedCompletion(snapshot, compactSuggestions[0] || nextSteps[0] || '');
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
    fileSummaryCacheKey: snapshot.fileSummaryCacheKey,
    metricId: stableStringHash([
      snapshot.cacheKey,
      fileOverview,
      compactSuggestions.join('\n'),
      'local',
    ].join('\n---adaceen-metric---\n')),
    completionText,
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

export function buildBackendSuggestionContent(
  snapshot: ActiveEditorSnapshot,
  projectIndex: WorkspaceProjectIndex | null = null,
  scope: BackendSuggestionRequestScope = 'file_summary',
  trigger?: SuggestionTrigger,
) {
  const isFileSummary = scope === 'file_summary';
  const blockingFocus = scope === 'cursor' && trigger === 'blocking';
  const selectionBlock = !isFileSummary && snapshot.selectionText.trim()
    ? [
      `Bloque seleccionado por el usuario: lineas ${snapshot.selectionStartLine}-${snapshot.selectionEndLine}`,
      `Lineas analizadas de la seleccion: ${snapshot.selectionLineCount}${snapshot.selectionTruncated ? ` de ${snapshot.selectionOriginalLineCount}` : ''}`,
      snapshot.selectionTruncated
        ? `Aviso: la seleccion supero el limite de ${ACTIVE_SUGGESTION_SELECTION_MAX_LINES} lineas; analiza solo este recorte inicial y menciona esa limitacion si afecta la respuesta.`
        : '',
      'El foco principal es todo este bloque seleccionado, no solamente la linea del cursor.',
      snapshot.selectionText.slice(0, ACTIVE_SUGGESTION_PROMPT_SELECTION_CHARS),
    ].filter(Boolean).join('\n')
    : '';

  return [
    `Repositorio: ${snapshot.repoFullName || '(sin repo detectado)'}`,
    `Workspace: ${snapshot.workspaceName || '(sin workspace)'}`,
    `Archivo activo: ${snapshot.filePath}`,
    `Lenguaje: ${snapshot.language}`,
    isFileSummary ? '' : `Cursor: linea ${snapshot.line}, columna ${snapshot.column}`,
    blockingFocus
      ? 'Disparador: bloqueo detectado; el mismo error del editor sigue presente o se repite.'
      : scope === 'cursor' ? 'Disparador: cursor quieto durante 3 segundos; posible bloqueo del estudiante.' : '',
    blockingFocus ? formatDiagnosticsForPrompt(snapshot.diagnostics.items) : '',
    selectionBlock,
    `Lineas del archivo: ${snapshot.lineCount}`,
    !isFileSummary && snapshot.currentLineText ? `Linea actual:\n${snapshot.currentLineText}` : '',
    !isFileSummary && snapshot.visibleText ? `Texto visible del editor:\n${snapshot.visibleText.slice(0, ACTIVE_SUGGESTION_PROMPT_VISIBLE_CHARS)}` : '',
    `Codigo del archivo activo (recorte local):\n${snapshot.content.slice(0, ACTIVE_SUGGESTION_PROMPT_CODE_CHARS)}`,
    formatWorkspaceProjectIndexForPrompt(projectIndex, snapshot.filePath),
  ].filter(Boolean).join('\n\n');
}

export function buildBackendSuggestionQuestion(
  snapshot: ActiveEditorSnapshot,
  scope: BackendSuggestionRequestScope,
  trigger?: SuggestionTrigger,
) {
  if (scope === 'file_summary') {
    return [
      'Describe en 1 a 3 bullets que hace el archivo activo y cual parece ser su papel dentro del proyecto usando el mapa local del workspace.',
      'Despues da 3 sugerencias breves y accionables para continuar en ese archivo.',
      'No des la solucion completa ni inventes datos que no esten en el contexto.',
    ].join(' ');
  }

  const visibleError = snapshot.diagnostics.firstError;
  if (trigger === 'blocking' && visibleError) {
    return [
      `El estudiante lleva un rato bloqueado con este error del editor en la linea ${visibleError.line}: "${truncateInline(visibleError.message, 300)}".`,
      'Explica en 1 bullet la causa probable con palabras sencillas y da 2 pistas breves para que lo corrija por su cuenta.',
      'Al final, si es seguro, incluye un unico bloque de codigo corto que ayude a corregirlo. Si no es seguro, usa un comentario TODO del lenguaje.',
      'Incluye una linea "Aplicar: insert", "Aplicar: replace" o "Aplicar: delete" segun corresponda; usa delete solo si la mejor ayuda es eliminar codigo.',
      'No des la solucion completa ni inventes datos que no esten en el contexto.',
    ].join(' ');
  }

  if (snapshot.selectionText.trim()) {
    return [
      `El estudiante selecciono un bloque del editor; analiza la seleccion completa recibida, con limite maximo de ${ACTIVE_SUGGESTION_SELECTION_MAX_LINES} lineas, como foco principal.`,
      'No reduzcas el analisis a la linea del cursor si hay varias lineas seleccionadas.',
      'Describe en 1 bullet que parece estar intentando hacer el bloque seleccionado y da 2 sugerencias breves para continuar desde esa seleccion.',
      'Al final, si es seguro, incluye un unico bloque de codigo corto para continuar. Si no es seguro, usa un comentario TODO del lenguaje.',
      'Incluye una linea "Aplicar: insert", "Aplicar: replace" o "Aplicar: delete" segun corresponda; usa delete solo si la mejor ayuda es eliminar codigo.',
      'No des la solucion completa ni inventes datos que no esten en el contexto.',
    ].join(' ');
  }

  return [
    'El cursor quedo quieto 3 segundos en la linea indicada; interpreta esto como posible bloqueo del estudiante.',
    'Describe en 1 bullet que parece estar intentando hacer y da 2 sugerencias breves para continuar desde esa linea.',
    'Al final, si es seguro, incluye un unico bloque de codigo corto para continuar. Si no es seguro, usa un comentario TODO del lenguaje.',
    'Incluye una linea "Aplicar: insert", "Aplicar: replace" o "Aplicar: delete" segun corresponda; usa delete solo si la mejor ayuda es eliminar codigo.',
    'No des la solucion completa ni inventes datos que no esten en el contexto.',
  ].join(' ');
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
        question: buildBackendSuggestionQuestion(snapshot, scope, requestContext.trigger),
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
  const focusLines = focusSections.sugerencias.length > 0 ? focusSections.sugerencias : focusSections.all;
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
    : '';
  const completionSeed = focusLines[0]
    || (scope === 'cursor' ? localFallback.lineSuggestions[0] : fileLines[0])
    || fileLines[0]
    || localFallback.suggestions[0]
    || '';
  const completionText = extractFirstCodeFence(focusOutputText)
    || buildSuggestedCompletion(snapshot, completionSeed);
  const applyMode = inferSuggestionApplyMode(
    snapshot,
    `${focusOutputText}\n${fileSummaryResult.outputText}`,
    completionText,
  );
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
    applyMode,
    triggerKind: scope === 'cursor' ? 'cursor' : 'file',
    actionsVisible: false,
    decisionId: primaryResult.decisionId || focusResult.decisionId || fileSummaryResult.decisionId || undefined,
    policyApplied: primaryResult.policyApplied,
    codeApplication: primaryResult.codeApplication,
    blocked: false,
    trigger,
  };
}

/** Se ofrece aplicar codigo para este modelo (no bloqueado y permitido por la politica). */
export function isSuggestionApplyOffered(model: ActiveSuggestionModel) {
  return !model.blocked && model.codeApplication?.allowed !== false;
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
