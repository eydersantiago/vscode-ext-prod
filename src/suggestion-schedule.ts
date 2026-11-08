// ADACEEN (VS Code): cuando se pide la sugerencia: cursor quieto, acciones a la vista y pausa mientras se aplica.
// Movido desde activate() (src/extension.ts): mismo texto; el estado compartido esta en *-state.ts.
import * as vscode from 'vscode';
import { isSuggestionApplyOffered } from './active-suggestion';
import { ACTIVE_SUGGESTION_ACTION_IDLE_MS, LOCAL_HINT_CURSOR_IDLE_MS, ACTIVE_SUGGESTION_POST_APPLY_GRACE_MS, ACTIVE_SUGGESTION_SELECTION_ACTION_IDLE_MS, ACTIVE_SUGGESTION_SELECTION_IDLE_MS } from './constants';
import { getCursorIdleAnchor, isCursorIdleAnchorStillActive, isSuggestionModelDocumentVisible } from './editor-snapshot';
import { resolveActiveSuggestionSettings } from './settings';
import { publishSuggestionModel, recordSuggestionMetric } from './suggestion-publish';
import { refreshActiveSuggestion, showSelectionRequestOptions } from './suggestion-refresh';
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

  const model = activeSuggestionModel;
  // 0.0.40: solo se revelan las acciones de una respuesta que ya esta para este mismo foco. Antes,
  // si no la habia, se le pedia al tutor (otra consulta automatica a la GPU).
  if (
    !model ||
    model.uriString !== anchor.uriString ||
    model.triggerKind !== 'cursor' ||
    (model.selectionRangeKey
      ? model.selectionRangeKey !== anchor.selectionRangeKey
      : model.line !== anchor.line + 1 || model.column !== anchor.column + 1)
  ) {
    return;
  }
  if (model.awaitingRequest || !isSuggestionApplyOffered(model)) {
    // Las opciones (0.0.40) no son una respuesta: nada que revelar ni que contar.
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
  const actionIdleMs = hasSelection ? ACTIVE_SUGGESTION_SELECTION_ACTION_IDLE_MS : ACTIVE_SUGGESTION_ACTION_IDLE_MS;

  // Las opciones de una seleccion que ya no esta (se quito o cambio) no se quedan colgadas: su
  // CodeLens «Sugerencia ADACEEN» pediria ayuda para un bloque que el estudiante ya solto.
  // Tampoco la espera ni la respuesta de una seleccion que ya no esta (antes las reemplazaba la
  // consulta automatica del cursor). Al volver a seleccionarla salen de la cache local o de
  // lastRequestedModel, sin GPU.
  const active = activeSuggestionModel;
  const staleSelection = !!active && !active.applied && active.selectionLineCount > 0
    && (active.uriString !== anchor.uriString || active.selectionRangeKey !== anchor.selectionRangeKey);
  if (staleSelection || (active && active.uriString !== anchor.uriString)) {
    publishSuggestionModel(null, true);
  } else {
    hideSuggestionActions();
  }

  // 0.0.40: el cursor quieto ya no consulta al tutor (antes: la linea y el resumen del archivo cada
  // 3 s). Con seleccion, la ventana se abre con los pedidos y el tutor responde al que se elija.
  // Sin tutor (useBackend apagado) no hay GPU que cuidar: la pista local de siempre.
  if (!settings.useBackend) {
    setCursorIdleSuggestionTimer(setTimeout(() => {
      setCursorIdleSuggestionTimer(null);
      if (isCursorIdleAnchorStillActive(anchor)) {
        void refreshActiveSuggestion('cursor-idle');
      }
    }, hasSelection ? ACTIVE_SUGGESTION_SELECTION_IDLE_MS : LOCAL_HINT_CURSOR_IDLE_MS));
  } else if (hasSelection) {
    setCursorIdleSuggestionTimer(setTimeout(() => {
      setCursorIdleSuggestionTimer(null);
      if (!isCursorIdleAnchorStillActive(anchor)) {
        return;
      }
      void showSelectionRequestOptions();
    }, ACTIVE_SUGGESTION_SELECTION_IDLE_MS));
  }

  setCursorActionTimer(setTimeout(() => {
    setCursorActionTimer(null);
    void revealSuggestionActions(anchor, actionIdleMs);
  }, actionIdleMs));
};
