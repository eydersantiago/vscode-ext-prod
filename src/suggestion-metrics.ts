// ADACEEN (VS Code): metricas de sugerencias, comentarios de accion, rack de reemplazos para el navegador e historial del quiz.
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import { isSuggestionApplyOffered, primarySuggestionText, summarizeActiveSuggestion } from './active-suggestion';
import { buildSessionHeaders, fetchJsonWithTimeout } from './backend-http';
import { ACTIVE_SUGGESTION_HISTORY_PANEL_LIMIT, ACTIVE_SUGGESTION_SELECTION_MAX_LINES } from './constants';
import { detectBranchName } from './git-repo';
import type { QuizHistoryItem } from './quiz-view';
import { isCodespaceRuntime, resolveBackendSettings } from './settings';
import { buildSuggestedCompletion, commentPrefixForLanguage, inferSuggestionApplyMode, lineIndent, normalizeSuggestionForCode, suggestionApplyModeLabel } from './suggestion-edit';
import { historyEntryTargetLabel, normalizeHistoryText } from './suggestion-history';
import { truncateInline } from './suggestion-results';
import type { TelemetryCategory, TelemetryClient } from './telemetry';
import type { ActiveEditorSnapshot, ActiveSuggestionHistoryEntry, ActiveSuggestionModel, SuggestionApplyMode, VscodeReplacementOption, WorkspaceProjectIndex } from './types';

export function buildSuggestionMetricMetadata(
  model: ActiveSuggestionModel,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    metricId: model.metricId,
    triggerKind: model.triggerKind,
    applyMode: model.applyMode,
    source: model.source,
    line: model.line,
    column: model.column,
    selectionLineCount: model.selectionLineCount,
    selectionOriginalLineCount: model.selectionOriginalLineCount,
    selectionTruncated: model.selectionTruncated,
    selectionMaxLines: ACTIVE_SUGGESTION_SELECTION_MAX_LINES,
    fileSummaryCacheKey: model.fileSummaryCacheKey,
    ragCourseCode: model.ragCourseCode,
    ragSourceCount: model.ragSources.length,
    ragSources: model.ragSources.slice(0, 5).map((source) => ({
      sourceId: source.sourceId,
      chunkId: source.chunkId,
      title: source.title,
      citationLabel: source.citationLabel,
      pageStart: source.pageStart,
      pageEnd: source.pageEnd,
      courseCode: source.courseCode,
    })),
    suggestionPreview: truncateInline(primarySuggestionText(model), 240),
    backendError: model.backendError,
    trigger: model.trigger || '',
    blocked: !!model.blocked,
    ...(model.policyApplied
      ? {
        policyName: model.policyApplied.name,
        policyReasonCode: model.policyApplied.reasonCode,
        helpStage: model.policyApplied.helpStage,
      }
      : {}),
    ...(model.codeApplication
      ? {
        codeApplicationAllowed: model.codeApplication.allowed,
        codeApplicationRemaining: model.codeApplication.remaining,
      }
      : {}),
    ...extra,
  };
}

export function buildActionCommentText(snapshot: ActiveEditorSnapshot, model: ActiveSuggestionModel) {
  const baseLine = snapshot.selectionText
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.trim())
    || snapshot.currentLineText
    || '';
  const indent = lineIndent(baseLine);
  const comment = commentPrefixForLanguage(snapshot.language, snapshot.filePath);
  const suggestion = normalizeSuggestionForCode(primarySuggestionText(model) || 'revisar este bloque con ADACEEN');
  return `${indent}${comment.open}TODO: ${suggestion}${comment.close}`;
}

export function appendActionCommentToTarget(targetText: string, commentText: string) {
  const cleanTarget = targetText.replace(/\s+$/g, '');
  if (!cleanTarget) {
    return commentText;
  }
  return `${cleanTarget}\n${commentText}`;
}

export function looksLikeCommentOnlyCompletion(value: string, snapshot: ActiveEditorSnapshot) {
  const clean = value.trim();
  if (!clean) {
    return false;
  }
  const comment = commentPrefixForLanguage(snapshot.language, snapshot.filePath);
  if (comment.open === '// ') {
    return clean.split(/\r?\n/).every((line) => !line.trim() || line.trim().startsWith('//'));
  }
  return clean.startsWith(comment.open.trim()) && (!comment.close || clean.endsWith(comment.close.trim()));
}

export function actionOptionMetadata(
  model: ActiveSuggestionModel,
  snapshot: ActiveEditorSnapshot,
  applyMode: SuggestionApplyMode,
): Record<string, unknown> {
  return {
    source: model.source,
    triggerKind: model.triggerKind,
    applyMode,
    line: model.line,
    column: model.column,
    selectionLineCount: snapshot.selectionLineCount,
    selectionOriginalLineCount: snapshot.selectionOriginalLineCount,
    selectionTruncated: snapshot.selectionTruncated,
    selectionMaxLines: ACTIVE_SUGGESTION_SELECTION_MAX_LINES,
    generatedAt: model.updatedAt,
    language: model.language,
    generatedBy: model.source === 'backend'
      ? 'vscode_extension_agent_decision'
      : 'vscode_extension_local_fallback',
    // Si el navegador devuelve esta opcion como reemplazo, VS Code la valida
    // con apply-check usando la misma decision del tutor.
    ...(model.decisionId ? { decisionId: model.decisionId } : {}),
    ...(model.trigger ? { trigger: model.trigger } : {}),
  };
}

export function actionTypeForApplyMode(snapshot: ActiveEditorSnapshot, applyMode: SuggestionApplyMode) {
  if (applyMode === 'delete') {
    return snapshot.selectionText.trim() ? 'delete_selection' : 'delete_line';
  }
  if (applyMode === 'replace') {
    return snapshot.selectionText.trim() ? 'replace_selection' : 'replace_line';
  }
  return 'insert_after_line';
}

export function optionLabelForApplyMode(snapshot: ActiveEditorSnapshot, applyMode: SuggestionApplyMode) {
  if (applyMode === 'delete') {
    return snapshot.selectionText.trim() ? 'Eliminar seleccion' : 'Eliminar linea actual';
  }
  if (applyMode === 'replace') {
    return snapshot.selectionText.trim() ? 'Modificar seleccion' : 'Modificar linea actual';
  }
  return 'Agregar codigo o comentario';
}

/** Campos de primer nivel (contrato v1.1) que acompanan a una metrica de sugerencia. */
export type SuggestionMetricFields = {
  category?: TelemetryCategory;
  durationMs?: number | null;
  latencyMs?: number | null;
  count?: number | null;
  /** Por defecto el decisionId del modelo. */
  decisionId?: string;
};

export function editorPageContext() {
  return isCodespaceRuntime() ? 'codespace' : 'vscode';
}

/**
 * Metrica de sugerencia hacia /api/behavior/events (telemetria v1.1).
 * Ya no exige sesion: sin sesion viaja con x-adaceen-client-id. El cliente
 * de telemetria agrega schemaVersion, seq y clientSessionId, y hace un
 * reintento ante error de red.
 */
export function recordVscodeSuggestionMetric(
  telemetry: TelemetryClient,
  model: ActiveSuggestionModel,
  eventType: string,
  value = "",
  extra: Record<string, unknown> = {},
  fields: SuggestionMetricFields = {},
) {
  telemetry.track({
    source: 'vscode_extension',
    category: fields.category || 'suggestion',
    eventType,
    pageContext: editorPageContext(),
    repoFullName: model.repoFullName,
    branch: detectBranchName(),
    filePath: model.filePath,
    language: model.language,
    subjectId: model.metricId,
    value: value || model.applyMode,
    decisionId: fields.decisionId || model.decisionId,
    durationMs: fields.durationMs,
    latencyMs: fields.latencyMs,
    count: fields.count,
    metadata: buildSuggestionMetricMetadata(model, extra),
  });
}

export function buildRackReplacementOptions(
  snapshot: ActiveEditorSnapshot,
  model: ActiveSuggestionModel,
): VscodeReplacementOption[] {
  if (!isSuggestionApplyOffered(model)) {
    // Respuesta bloqueada o aplicacion no permitida: el navegador tampoco ofrece reemplazos.
    return [];
  }
  const applyMode = model.applyMode || inferSuggestionApplyMode(snapshot, summarizeActiveSuggestion(model), model.completionText);
  const targetText = snapshot.selectionText.trim() ? snapshot.selectionText : snapshot.currentLineText;
  const actionCommentText = buildActionCommentText(snapshot, model);
  if (applyMode === 'delete') {
    if (!targetText.trim()) {
      return [];
    }
    return [{
      id: 'agent-delete-focused-code',
      label: optionLabelForApplyMode(snapshot, applyMode),
      description: 'ADACEEN decidio que la ayuda aplicable es eliminar el bloque enfocado.',
      actionType: actionTypeForApplyMode(snapshot, applyMode),
      originalText: targetText,
      replacementText: '',
      metadata: {
        ...actionOptionMetadata(model, snapshot, applyMode),
        selectionStartLine: snapshot.selectionStartLine,
        selectionEndLine: snapshot.selectionEndLine,
      },
    }];
  }

  const fallback = buildSuggestedCompletion(snapshot, model.suggestions[0] || model.summary, applyMode === 'replace' ? 'replace' : 'insert');
  const primaryReplacementText = (model.completionText || fallback || actionCommentText).trimEnd();
  if (!primaryReplacementText.trim()) {
    return [];
  }

  const replacementText = applyMode === 'replace'
    && looksLikeCommentOnlyCompletion(primaryReplacementText, snapshot)
    ? appendActionCommentToTarget(targetText, primaryReplacementText)
    : primaryReplacementText;

  return [{
    id: `agent-${applyMode}-focused-code`,
    label: optionLabelForApplyMode(snapshot, applyMode),
    description: `ADACEEN decidio ${suggestionApplyModeLabel(applyMode).toLowerCase()} usando el foco actual del editor.`,
    actionType: actionTypeForApplyMode(snapshot, applyMode),
    originalText: applyMode === 'replace' ? targetText : snapshot.currentLineText,
    replacementText,
    metadata: {
      ...actionOptionMetadata(model, snapshot, applyMode),
      selectionStartLine: snapshot.selectionStartLine,
      selectionEndLine: snapshot.selectionEndLine,
    },
  }];
}

export function buildRackFileList(snapshot: ActiveEditorSnapshot, projectIndex: WorkspaceProjectIndex | null) {
  const files = projectIndex?.files.map((entry) => entry.path).filter(Boolean) || [];
  if (!files.includes(snapshot.filePath)) {
    files.unshift(snapshot.filePath);
  }
  return [...new Set(files)].slice(0, 120000);
}

export async function publishActiveEditorRack(
  snapshot: ActiveEditorSnapshot,
  model: ActiveSuggestionModel,
  projectIndex: WorkspaceProjectIndex | null,
) {
  const settings = resolveBackendSettings();
  if (!settings.baseUrl || !settings.sessionId) {
    return;
  }

  const files = buildRackFileList(snapshot, projectIndex);
  const folders = [...new Set(projectIndex?.folders || [])].slice(0, 120000);
  await fetchJsonWithTimeout(
    `${settings.baseUrl}/api/projects/rack`,
    {
      method: 'POST',
      headers: buildSessionHeaders(settings, true),
      body: JSON.stringify({
        source: 'vscode_extension',
        repoFullName: snapshot.repoFullName,
        branch: detectBranchName(),
        generatedAt: model.updatedAt || snapshot.generatedAt,
        totalEntries: files.length + folders.length,
        totalFiles: files.length,
        totalFolders: folders.length,
        files,
        folders,
        activeFilePath: snapshot.filePath,
        activeCodeSnippet: snapshot.selectionText || snapshot.visibleText || snapshot.currentLineText,
        activeSuggestion: summarizeActiveSuggestion(model),
        replacementOptions: buildRackReplacementOptions(snapshot, model),
      }),
    },
    settings.requestTimeoutMs,
  );
}

/** Historial en el formato compacto que muestra la vista de quiz. */
export function toQuizHistoryItems(history: ActiveSuggestionHistoryEntry[]): QuizHistoryItem[] {
  const seen = new Set<string>();
  return history
    .filter((entry) => {
      const key = `${entry.filePath}\u0000${normalizeHistoryText(entry.summary, 120).toLowerCase()}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, ACTIVE_SUGGESTION_HISTORY_PANEL_LIMIT * 2)
    .map((entry) => ({
      id: entry.id,
      fileName: entry.fileName,
      meta: [historyEntryTargetLabel(entry), entry.ragCourseCode ? `RAG ${entry.ragCourseCode}` : entry.source]
        .filter(Boolean)
        .join(' · '),
      summary: truncateInline(entry.summary || entry.suggestions[0] || '', 140),
    }));
}
