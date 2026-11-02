// ADACEEN (VS Code): cuando se pide la sugerencia: cursor quieto, acciones a la vista y pausa mientras se aplica.
// Movido desde activate() (src/extension.ts): mismo texto; el estado compartido esta en *-state.ts.
import * as vscode from 'vscode';
import { isSuggestionApplyOffered } from './active-suggestion';
import { ACTIVE_SUGGESTION_ACTION_IDLE_MS, ACTIVE_SUGGESTION_CURSOR_IDLE_MS, ACTIVE_SUGGESTION_POST_APPLY_GRACE_MS, ACTIVE_SUGGESTION_SELECTION_ACTION_IDLE_MS, ACTIVE_SUGGESTION_SELECTION_IDLE_MS } from './constants';
import { getCursorIdleAnchor, isCursorIdleAnchorStillActive, isSuggestionModelDocumentVisible } from './editor-snapshot';
import { resolveActiveSuggestionSettings } from './settings';
import { publishSuggestionModel, recordSuggestionMetric } from './suggestion-publish';
import { refreshActiveSuggestion } from './suggestion-refresh';
import { activeSuggestionModel, applyInProgress, cursorActionTimer, cursorIdleSuggestionTimer, setCursorActionTimer, setCursorIdleSuggestionTimer, setSuppressSuggestionRefreshUntil, setSuppressSuggestionRefreshUri, suggestionCodeLensProvider, suppressSuggestionRefreshUntil, suppressSuggestionRefreshUri } from './suggestion-state';
import type { CursorIdleAnchor } from './types';

export const clearCursorSuggestionTimers = () => {
  if (cursorIdleSuggestionTimer) {
    clearTimeout(cursorIdleSuggestionTimer);
    setCursorIdleSuggestionTimer(null);
  }
  if (cursorActionTimer) {
    clearTimeout(cursorActionTimer);
    setCursorActionTimer(null);
  }
};

const hideSuggestionActions = () => {
  if (!activeSuggestionModel?.actionsVisible) {
    suggestionCodeLensProvider.update(activeSuggestionModel);
    return;
  }
  publishSuggestionModel({ ...activeSuggestionModel, actionsVisible: false }, true);
};

const revealSuggestionActions = async (anchor: CursorIdleAnchor | null, idleMs = ACTIVE_SUGGESTION_ACTION_IDLE_MS) => {
  if (!anchor || !isCursorIdleAnchorStillActive(anchor)) {
    return;
  }

  let model = activeSuggestionModel;
  if (
    !model ||
    model.uriString !== anchor.uriString ||
    model.triggerKind !== 'cursor' ||
    (model.selectionRangeKey
      ? model.selectionRangeKey !== anchor.selectionRangeKey
      : model.line !== anchor.line + 1 || model.column !== anchor.column + 1)
  ) {
    model = await refreshActiveSuggestion('cursor-idle');
  }

  if (!model || !isCursorIdleAnchorStillActive(anchor)) {
    return;
  }
  if (!isSuggestionApplyOffered(model)) {
    // Respuesta bloqueada, sin modelo, pista local o sin permiso para aplicar: no hay acciones
    // que revelar (ni vscode_suggestion_actions_revealed que contar).
    return;
  }

  const visibleModel = { ...model, actionsVisible: true, triggerKind: 'cursor' as const };
  publishSuggestionModel(visibleModel, true);
  recordSuggestionMetric(visibleModel, 'vscode_suggestion_actions_revealed', visibleModel.applyMode, {
    idleMs,
  }, true);
};

export const suppressAutoRefreshForActiveApply = (uriString: string) => {
  setSuppressSuggestionRefreshUri(uriString);
  setSuppressSuggestionRefreshUntil(Date.now() + ACTIVE_SUGGESTION_POST_APPLY_GRACE_MS);
};

export const isAutoRefreshSuppressed = () => {
  if (applyInProgress) {
    // Mientras se consulta apply-check o se espera la confirmacion, la
    // sugerencia que el estudiante eligio no debe cambiar por debajo.
    return true;
  }
  const editor = vscode.window.activeTextEditor;
  return !!editor
    && Date.now() < suppressSuggestionRefreshUntil
    && editor.document.uri.toString() === suppressSuggestionRefreshUri;
};

export const scheduleCursorIdleSuggestionRefresh = () => {
  const settings = resolveActiveSuggestionSettings();
  clearCursorSuggestionTimers();
  if (isAutoRefreshSuppressed()) {
    return;
  }
  if (!settings.enabled) {
    publishSuggestionModel(null, false);
    return;
  }

  const anchor = getCursorIdleAnchor();
  if (!anchor) {
    // Sin editor con foco no se borra la sugerencia mientras su archivo
    // siga a la vista (p. ej. el estudiante esta leyendo el panel).
    if (!isSuggestionModelDocumentVisible(activeSuggestionModel)) {
      publishSuggestionModel(null, true);
    }
    return;
  }
  const hasSelection = !!vscode.window.activeTextEditor && !vscode.window.activeTextEditor.selection.isEmpty;
  const suggestionIdleMs = hasSelection ? ACTIVE_SUGGESTION_SELECTION_IDLE_MS : ACTIVE_SUGGESTION_CURSOR_IDLE_MS;
  const actionIdleMs = hasSelection ? ACTIVE_SUGGESTION_SELECTION_ACTION_IDLE_MS : ACTIVE_SUGGESTION_ACTION_IDLE_MS;

  if (activeSuggestionModel && activeSuggestionModel.uriString !== anchor.uriString) {
    publishSuggestionModel(null, true);
  } else {
    hideSuggestionActions();
  }

  setCursorIdleSuggestionTimer(setTimeout(() => {
    setCursorIdleSuggestionTimer(null);
    if (!isCursorIdleAnchorStillActive(anchor)) {
      return;
    }
    void refreshActiveSuggestion('cursor-idle');
  }, suggestionIdleMs));

  setCursorActionTimer(setTimeout(() => {
    setCursorActionTimer(null);
    void revealSuggestionActions(anchor, actionIdleMs);
  }, actionIdleMs));
};
