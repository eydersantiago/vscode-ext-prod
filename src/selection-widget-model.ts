// ADACEEN (VS Code): de la sugerencia activa al modelo de la ventana flotante (0.0.38), sin
// importar vscode. Antes vivia en suggestion-history.ts (con vscode): aqui se prueba que la ventana
// y la vista «Este archivo» muestran lo mismo de un mismo modelo.
import { codeApplicationNote } from './code-application';
import type { SelectionWidgetModel } from './selection-widget-text';
import { producedMode } from './suggestion-code';
import type { ActiveSuggestionModel } from './types';

/** La frase principal de la sugerencia: la del foco, la del archivo, o el resumen. */
export function primarySuggestionText(model: ActiveSuggestionModel) {
  return model.lineSuggestions[0] ||
    model.fileSuggestions[0] ||
    model.suggestions[0] ||
    model.summary ||
    model.fileOverview;
}

/**
 * Lo que la ventana flotante necesita del modelo activo. Solo tiene sentido cuando hay seleccion:
 * sin seleccion no hay a que anclarla.
 */
export function toSelectionWidgetModel(model: ActiveSuggestionModel | null): SelectionWidgetModel | null {
  if (!model || model.selectionLineCount <= 0) {
    return null;
  }
  const startLine = Math.max(1, Number(model.line) || 1);
  const endLine = startLine + Math.max(0, model.selectionLineCount - 1);
  const policy = model.codeApplication;
  return {
    uriString: model.uriString,
    startLine,
    endLine,
    headline: model.lineSummary || primarySuggestionText(model) || '',
    completionText: model.completionText || '',
    completionMode: producedMode(model),
    language: model.language || '',
    recommendedMode: model.applyMode || 'insert',
    source: model.source,
    ragCourseCode: model.ragCourseCode || '',
    loading: !!model.loading,
    applied: !!model.applied,
    blocked: !!model.blocked,
    tutorMessage: model.tutorMessage || '',
    // Solo la politica: lo que descarta la respuesta lo deriva la ventana de las otras banderas.
    codeApplication: policy ? { allowed: policy.allowed, reason: policy.reason, reasonCode: policy.reasonCode } : null,
    applicationNote: codeApplicationNote(model),
    pendingMode: model.pendingMode || '',
    slow: !!model.slow,
    codeRequestNote: model.codeRequestNote || '',
    requestedAction: model.requestedAction || '',
    proposalWarning: model.proposalWarning || '',
    tutorUnavailable: !!model.tutorUnavailable,
    guide: model.guide || null,
    partialText: model.loading || model.pendingMode ? model.partialText || '' : '',
    explanationText: model.explanationText || '',
  };
}
