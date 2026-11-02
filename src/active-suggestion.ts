// ADACEEN (VS Code): construir la sugerencia activa (local, del backend o bloqueada) y sus textos.
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
// La sugerencia local esta en local-suggestion.ts y lo que se manda al tutor, en suggestion-request.ts.
import { buildSessionHeaders, fetchJsonWithTimeout } from './backend-http';
import { ACTIVE_SUGGESTION_SELECTION_MAX_LINES } from './constants';
import { resolveBackendSettings } from './settings';
import { DROPS_MOST_WARNING, extractSuggestionCode, prepareSuggestionCode, replacementDropsMostOfSelection, resolveSuggestionModes, toSuggestionCodeFields } from './suggestion-code';
import type { EditorCodeAction } from './suggestion-code';
import { parseBackendSuggestionSections, stripCutNoteAfterFence } from './suggestion-format';
import { responseAllowsApply } from './suggestion-phase';
import { createEmptyBackendSuggestionResult, normalizeBackendSuggestionResult, truncateInline, uniqueCompactStrings } from './suggestion-results';
import type { ActiveEditorSnapshot, ActiveSuggestionModel, ActiveSuggestionSettings, BackendSuggestionRequestContext, BackendSuggestionRequestScope, BackendSuggestionResult, BackendSuggestionScope, BackendSuggestionSections, SuggestionTrigger, WorkspaceProjectIndex } from './types';
import { stableStringHash } from './workspace-index';
import { buildLocalActiveSuggestion } from './local-suggestion';
import { buildBackendSuggestionContent, buildBackendSuggestionQuestion } from './suggestion-request';

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
  // 0.0.38: la nota del backend despues de un bloque recortado no se repite como texto de la
  // sugerencia: la ventana y la vista dicen lo mismo con code_application.cut.
  const focusDisplayText = focusResult.codeApplication?.cut ? stripCutNoteAfterFence(focusOutputText) : focusOutputText;
  const focusSections = focusDisplayText
    ? parseBackendSuggestionSections(focusDisplayText)
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
  // 0.0.38: si el backend recorto el codigo por el tope del docente lo dice code_application
  // (truncation, cut); con un backend anterior, la marca vieja dentro del codigo.
  const prepared = prepareSuggestionCode(resolvedModes.completionText, {
    selection: snapshot.selectionText,
    mode: resolvedModes.completionMode,
    language: snapshot.language,
    policy: primaryResult.codeApplication,
  });
  // El codigo que no se puede aplicar tal cual se muestra como guia en vez de borrarse: la accion
  // queda sin codigo y nada lo aplica por error.
  const modes = { ...resolvedModes, ...toSuggestionCodeFields(prepared, resolvedModes.completionMode) };
  // Una respuesta que es solo la linea "Aplicar:" y el bloque de codigo tambien vale
  // (antes se descartaba por no traer texto fuera del bloque).
  const codeOnlyHeadline = modes.completionText
    ? (modes.completionMode === 'replace'
      ? 'El tutor propone una versión mejorada del bloque.'
      : 'El tutor propone código para continuar.')
    : modes.guide
      // Escribio codigo, pero no se puede aplicar tal cual: se muestra como guia con el motivo.
      ? 'El tutor propone código para usar como guía.'
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
      ? focusSummary || fileOverview || truncateInline(focusDisplayText.replace(/\s+/g, ' '), 260)
      : fileOverview || truncateInline(focusDisplayText.replace(/\s+/g, ' '), 260),
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
    ...(modes.guide ? { guide: modes.guide } : {}),
    // Respuesta sin modelo para el foco: antes la ventana decia ademas «El tutor respondio sin
    // codigo para esto», como si hubiera respondido (piloto del 25/10/2026).
    ...(primaryResult === focusResult && focusResult.degraded ? { tutorUnavailable: true } : {}),
  };
}

/**
 * Se ofrece aplicar codigo para este modelo: la respuesta lo permite (no esta bloqueada, hubo
 * modelo y no es una pista local; la misma regla que la ventana flotante) y la politica tambien.
 * Para ofrecer «Aceptar ayuda» con la accion recomendada: canOfferRecommendedAction
 * (src/suggestion-phase.ts), que ademas pide la sugerencia lista, sin aplicar y con su codigo.
 */
export function isSuggestionApplyOffered(model: ActiveSuggestionModel) {
  return responseAllowsApply(model) && model.codeApplication?.allowed !== false;
}

export function summarizeActiveSuggestion(model: ActiveSuggestionModel) {
  return uniqueCompactStrings([
    model.lineSummary,
    ...model.lineSuggestions,
    ...model.fileSuggestions,
  ], 5).join('\n');
}
