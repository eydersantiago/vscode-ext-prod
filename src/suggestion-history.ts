// ADACEEN (VS Code): historial de sugerencias (modelo del widget, guardar y mostrar).
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import * as vscode from 'vscode';
import { isSuggestionApplyOffered, primarySuggestionText, suggestionApplicationNote } from './active-suggestion';
import { ACTIVE_SUGGESTION_HISTORY_LIMIT, ACTIVE_SUGGESTION_HISTORY_STORAGE_KEY } from './constants';
import type { SelectionWidgetModel } from './selection-widget';
import { toOptionalString } from './settings';
import { firstPositiveNumber, truncateInline, uniqueCompactStrings } from './suggestion-results';
import type { ActiveSuggestionHistoryEntry, ActiveSuggestionHistoryKind, ActiveSuggestionModel } from './types';
import { stableStringHash } from './workspace-index';

/**
 * Lo que el widget flotante necesita del modelo activo. Solo tiene sentido
 * cuando hay seleccion: sin seleccion no hay a que anclarlo.
 */
export function toSelectionWidgetModel(model: ActiveSuggestionModel | null): SelectionWidgetModel | null {
  if (!model || model.selectionLineCount <= 0) {
    return null;
  }
  const startLine = Math.max(1, Number(model.line) || 1);
  const endLine = startLine + Math.max(0, model.selectionLineCount - 1);
  return {
    uriString: model.uriString,
    startLine,
    endLine,
    headline: model.lineSummary || primarySuggestionText(model) || '',
    completionText: model.completionText || '',
    language: model.language || '',
    recommendedMode: model.applyMode || 'insert',
    source: model.source,
    ragCourseCode: model.ragCourseCode || '',
    loading: !!model.loading,
    applied: !!model.applied,
    blocked: !!model.blocked,
    tutorMessage: model.tutorMessage || '',
    applyAllowed: isSuggestionApplyOffered(model),
    applicationNote: suggestionApplicationNote(model),
  };
}

export function normalizeHistoryText(value: string, max = 360) {
  return truncateInline(value.replace(/\s+/g, ' ').trim(), max);
}

export function normalizeHistoryEntry(value: unknown): ActiveSuggestionHistoryEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Partial<ActiveSuggestionHistoryEntry>;
  const kind = source.kind === 'line' || source.kind === 'file' ? source.kind : null;
  const id = toOptionalString(source.id);
  const filePath = toOptionalString(source.filePath);
  if (!kind || !id || !filePath || source.source === 'local-fallback') {
    return null;
  }

  const suggestions = Array.isArray(source.suggestions)
    ? uniqueCompactStrings(source.suggestions.map((item) => toOptionalString(item) || ''), 6)
    : [];
  const updatedAt = toOptionalString(source.updatedAt) || toOptionalString(source.createdAt) || new Date().toISOString();
  return {
    id,
    kind,
    filePath,
    fileName: toOptionalString(source.fileName) || filePath.split('/').filter(Boolean).pop() || filePath,
    language: toOptionalString(source.language) || 'general',
    repoFullName: toOptionalString(source.repoFullName) || '',
    title: normalizeHistoryText(toOptionalString(source.title) || (kind === 'line' ? 'Recomendacion de linea' : 'Resumen de archivo'), 160),
    summary: normalizeHistoryText(toOptionalString(source.summary) || suggestions[0] || '', 420),
    suggestions,
    source: source.source === 'backend' ? 'backend' : 'local',
    triggerKind: source.triggerKind === 'cursor' ? 'cursor' : 'file',
    applyMode: source.applyMode === 'replace' || source.applyMode === 'delete' ? source.applyMode : 'insert',
    line: firstPositiveNumber(source.line) || 0,
    column: firstPositiveNumber(source.column) || 0,
    selectionStartLine: firstPositiveNumber(source.selectionStartLine) || 0,
    selectionEndLine: firstPositiveNumber(source.selectionEndLine) || 0,
    selectionLineCount: firstPositiveNumber(source.selectionLineCount) || 0,
    selectionOriginalLineCount: firstPositiveNumber(source.selectionOriginalLineCount) || 0,
    selectionTruncated: source.selectionTruncated === true,
    ragCourseCode: toOptionalString(source.ragCourseCode) || '',
    backendError: normalizeHistoryText(toOptionalString(source.backendError) || '', 180),
    metricId: toOptionalString(source.metricId) || id,
    createdAt: toOptionalString(source.createdAt) || updatedAt,
    updatedAt,
  };
}

export function readSuggestionHistory(storage: vscode.Memento): ActiveSuggestionHistoryEntry[] {
  const raw = storage.get<unknown>(ACTIVE_SUGGESTION_HISTORY_STORAGE_KEY);
  const items = Array.isArray(raw) ? raw : [];
  return items
    .map(normalizeHistoryEntry)
    .filter((entry): entry is ActiveSuggestionHistoryEntry => !!entry)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, ACTIVE_SUGGESTION_HISTORY_LIMIT);
}

export async function writeSuggestionHistory(storage: vscode.Memento, history: ActiveSuggestionHistoryEntry[]) {
  await storage.update(
    ACTIVE_SUGGESTION_HISTORY_STORAGE_KEY,
    history.filter((entry) => entry.source !== 'local-fallback').slice(0, ACTIVE_SUGGESTION_HISTORY_LIMIT),
  );
}

export function buildSuggestionHistoryEntryId(model: ActiveSuggestionModel, kind: ActiveSuggestionHistoryKind, suggestions: string[]) {
  return stableStringHash([
    kind,
    model.metricId,
    model.filePath,
    model.selectionRangeKey,
    model.line,
    model.column,
    suggestions.join('\n'),
  ].join('\n---history---\n'));
}

export function buildSuggestionHistoryEntries(model: ActiveSuggestionModel): ActiveSuggestionHistoryEntry[] {
  if (model.loading || model.applied || model.source === 'local-fallback') {
    return [];
  }

  const base = {
    filePath: model.filePath,
    fileName: model.fileName,
    language: model.language,
    repoFullName: model.repoFullName,
    source: model.source,
    triggerKind: model.triggerKind,
    applyMode: model.applyMode,
    line: model.line,
    column: model.column,
    selectionLineCount: model.selectionLineCount,
    selectionOriginalLineCount: model.selectionOriginalLineCount,
    selectionTruncated: model.selectionTruncated,
    ragCourseCode: model.ragCourseCode,
    backendError: model.backendError,
    metricId: model.metricId,
    createdAt: model.updatedAt,
    updatedAt: model.updatedAt,
  };
  const entries: ActiveSuggestionHistoryEntry[] = [];
  const hasLineFocus = model.triggerKind === 'cursor' || model.selectionLineCount > 0 || model.lineSuggestions.length > 0;
  const lineSuggestions = uniqueCompactStrings([
    model.lineSummary,
    ...model.lineSuggestions,
    ...(model.triggerKind === 'cursor' ? model.suggestions : []),
  ], 6);

  if (hasLineFocus && lineSuggestions.length > 0) {
    const selectionStartLine = model.selectionLineCount > 0 ? model.line : 0;
    const selectionEndLine = model.selectionLineCount > 0
      ? model.line + Math.max(0, model.selectionLineCount - 1)
      : 0;
    const title = model.selectionLineCount > 0
      ? `Seleccion lineas ${selectionStartLine}-${selectionEndLine}`
      : `Linea ${model.line}`;
    entries.push({
      ...base,
      id: buildSuggestionHistoryEntryId(model, 'line', lineSuggestions),
      kind: 'line',
      title,
      summary: normalizeHistoryText(model.lineSummary || lineSuggestions[0] || primarySuggestionText(model), 420),
      suggestions: lineSuggestions,
      selectionStartLine,
      selectionEndLine,
    });
  }

  const fileSuggestions = uniqueCompactStrings([
    model.fileOverview,
    ...model.fileSuggestions,
  ], 6);
  if (model.triggerKind === 'file' && fileSuggestions.length > 0) {
    entries.push({
      ...base,
      id: buildSuggestionHistoryEntryId(model, 'file', fileSuggestions),
      kind: 'file',
      title: `Resumen de ${model.fileName}`,
      summary: normalizeHistoryText(model.fileOverview || model.summary || fileSuggestions[0], 420),
      suggestions: fileSuggestions,
      selectionStartLine: 0,
      selectionEndLine: 0,
    });
  }

  return entries;
}

export async function rememberSuggestionHistory(
  storage: vscode.Memento,
  model: ActiveSuggestionModel,
): Promise<ActiveSuggestionHistoryEntry[]> {
  const nextEntries = buildSuggestionHistoryEntries(model);
  if (nextEntries.length === 0) {
    return readSuggestionHistory(storage);
  }

  const history = readSuggestionHistory(storage);
  for (const entry of nextEntries) {
    const index = history.findIndex((item) => item.id === entry.id);
    if (index >= 0) {
      history.splice(index, 1, {
        ...history[index],
        ...entry,
        createdAt: history[index].createdAt || entry.createdAt,
        updatedAt: entry.updatedAt || new Date().toISOString(),
      });
    } else {
      history.unshift(entry);
    }
  }

  const compacted = history
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, ACTIVE_SUGGESTION_HISTORY_LIMIT);
  await writeSuggestionHistory(storage, compacted);
  return compacted;
}

export function historyEntryTargetLabel(entry: ActiveSuggestionHistoryEntry) {
  if (entry.kind === 'file') {
    return 'Resumen de archivo';
  }
  if (entry.selectionLineCount > 0 && entry.selectionStartLine > 0) {
    const endLine = entry.selectionEndLine > entry.selectionStartLine ? `-${entry.selectionEndLine}` : '';
    return `Seleccion ${entry.selectionStartLine}${endLine}`;
  }
  return entry.line > 0 ? `Linea ${entry.line}` : 'Linea activa';
}

export function formatSuggestionHistoryMarkdown(history: ActiveSuggestionHistoryEntry[]) {
  const renderGroup = (title: string, entries: ActiveSuggestionHistoryEntry[]) => {
    if (entries.length === 0) {
      return `## ${title}\n\nSin entradas todavia.\n`;
    }

    return [
      `## ${title}`,
      ...entries.map((entry) => [
        `### ${entry.title}`,
        `- Archivo: ${entry.filePath}`,
        `- Foco: ${historyEntryTargetLabel(entry)}`,
        `- Fuente: ${entry.source}${entry.ragCourseCode ? ` | RAG ${entry.ragCourseCode}` : ''}`,
        `- Fecha: ${entry.updatedAt}`,
        '',
        entry.summary,
        '',
        ...entry.suggestions.map((item) => `- ${item}`),
      ].join('\n')),
    ].join('\n\n');
  };

  const lineEntries = history.filter((entry) => entry.kind === 'line');
  const fileEntries = history.filter((entry) => entry.kind === 'file');
  return [
    '# Historial ADACEEN',
    '',
    'Recomendaciones recientes guardadas en este workspace.',
    '',
    renderGroup('Por linea o seleccion', lineEntries),
    '',
    renderGroup('Por resumen de archivo', fileEntries),
  ].join('\n');
}
