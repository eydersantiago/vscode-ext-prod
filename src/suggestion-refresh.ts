// ADACEEN (VS Code): pedir y mostrar la sugerencia del foco o del archivo (refreshActiveSuggestion) y su origen (trigger).
// Movido desde activate() (src/extension.ts): mismo texto; el estado compartido esta en *-state.ts.
import { buildBackendActiveSuggestionModel, isSuggestionApplyOffered } from './active-suggestion';
import { ACTIVE_SUGGESTION_FALLBACK_DELAY_MS, BLOCKING_TRIGGER_TTL_MS } from './constants';
import { buildActiveEditorSnapshot, hasActiveSelection, isSnapshotStillActive, isSuggestionModelDocumentVisible, resolveBackendScopeForSnapshot } from './editor-snapshot';
import { output, telemetry } from './extension-state';
import { fileView } from './file-view-state';
import { buildLocalActiveSuggestion } from './local-suggestion';
import { resolveActiveSuggestionSettings, resolveTriggerSettings } from './settings';
import { getBackendSuggestionText, getWorkspaceProjectIndex } from './suggestion-backend';
import { getBackendSuggestionScopeLabel } from './suggestion-format';
import { publishActiveEditorRack } from './suggestion-metrics';
import { armSlowNotice, publishSuggestionModel, recordSuggestionMetric, startLivePainter } from './suggestion-publish';
import { createEmptyBackendSuggestionResult, delay, formatBackendSuggestionError, settleBackendSuggestionResult, truncateInline, withActiveSuggestionDeadline } from './suggestion-results';
import { activeSuggestionModel, autoRevealedSuggestionUri, lastRequestedModel, pendingBlocking, pendingFileOpenUri, rackSyncErrorNotified, setAutoRevealedSuggestionUri, setLastKnownRepoFullName, setLastRequestedModel, setPendingBlocking, setPendingFileOpenUri, setRackSyncErrorNotified, setSuggestionTimer, suggestionExposure, suggestionTimer } from './suggestion-state';
import type { ActiveEditorSnapshot, ActiveSuggestionModel, BackendSuggestionRequestContext, BackendSuggestionResult, SuggestionTrigger, WorkspaceProjectIndex } from './types';

/** /suggest-tab respondio, pero sin texto ni codigo que mostrar. */
class BackendAnsweredWithoutSuggestion extends Error {
  constructor() {
    super('Backend no devolvio sugerencias aplicables.');
    this.name = 'BackendAnsweredWithoutSuggestion';
  }
}

/** Hay un bloqueo detectado en este archivo que todavia no recibio su sugerencia. */
const hasPendingBlocking = (uriString: string) => {
  if (!pendingBlocking) {
    return false;
  }
  if (Date.now() - pendingBlocking.detectedAt >= BLOCKING_TRIGGER_TTL_MS || !resolveTriggerSettings().suggestOnBlocking) {
    setPendingBlocking(null);
    return false;
  }
  return pendingBlocking.uriString === uriString;
};

/**
 * Origen real de la peticion (campo trigger de /suggest-tab). Las acciones
 * explicitas del estudiante mandan; despues un bloqueo pendiente, la
 * seleccion, el archivo recien abierto y por ultimo el cursor quieto.
 */
const resolveSuggestionTrigger = (reason: string, snapshot: ActiveEditorSnapshot): SuggestionTrigger => {
  if (reason === 'manual-refresh') {
    return 'manual';
  }
  if (reason === 'open-panel') {
    return 'panel';
  }
  if (reason === 'blocking' || hasPendingBlocking(snapshot.uriString)) {
    return 'blocking';
  }
  if (hasActiveSelection(snapshot)) {
    return 'selection';
  }
  if (pendingFileOpenUri && pendingFileOpenUri === snapshot.uriString) {
    return 'file_open';
  }
  return 'cursor_idle';
};

const publishActiveRackSnapshot = (
  snapshot: ActiveEditorSnapshot,
  model: ActiveSuggestionModel,
  projectIndex: WorkspaceProjectIndex | null,
  reason: string,
) => {
  void publishActiveEditorRack(snapshot, model, projectIndex)
    .then(() => {
      setRackSyncErrorNotified(false);
    })
    .catch((error) => {
      if (!rackSyncErrorNotified) {
        setRackSyncErrorNotified(true);
        output.appendLine(`[Sync] No se pudo publicar el archivo activo hacia el navegador (${reason}): ${String(error)}`);
      }
    });
};

export const refreshActiveSuggestion = async (reason = 'auto') => {
  const settings = resolveActiveSuggestionSettings();

  if (!settings.enabled) {
    publishSuggestionModel(null, false);
    return null;
  }

  const snapshot = await buildActiveEditorSnapshot(settings);
  if (!snapshot) {
    if (isSuggestionModelDocumentVisible(activeSuggestionModel)) {
      return activeSuggestionModel;
    }
    publishSuggestionModel(null, true);
    return null;
  }

  if (snapshot.repoFullName) {
    setLastKnownRepoFullName(snapshot.repoFullName);
  }
  // Codigo pedido por el estudiante (0.0.34) para esta misma foto del editor: al volver de
  // «Ver cambios» o de otra pestaña se vuelve a mostrar, no se cambia por la sugerencia normal.
  // «Otra sugerencia» (manual-refresh) si pide una nueva.
  if (reason === 'manual-refresh') {
    setLastRequestedModel(null);
  }
  const active = activeSuggestionModel;
  const current = active && (active.requestedAction || active.pendingMode) ? active : lastRequestedModel;
  if (
    reason !== 'manual-refresh'
    && current
    && !current.applied
    && current.uriString === snapshot.uriString
    && !!current.snapshotKey
    && current.snapshotKey === snapshot.cacheKey
  ) {
    publishSuggestionModel(current, true);
    return current;
  }
  const trigger = resolveSuggestionTrigger(reason, snapshot);
  if (pendingFileOpenUri === snapshot.uriString) {
    // "file_open" solo describe la primera peticion tras abrir el archivo.
    setPendingFileOpenUri('');
  }
  const requestContext: BackendSuggestionRequestContext = {
    trigger,
    clientSessionId: telemetry.clientSessionId,
  };
  const backendScope = resolveBackendScopeForSnapshot(reason, snapshot, trigger);
  const backendStartedAt = Date.now();
  let backendLatencyMs: number | null = null;
  const fallbackDelayMs = Math.min(settings.backendTimeoutMs, ACTIVE_SUGGESTION_FALLBACK_DELAY_MS);
  let model = buildLocalActiveSuggestion(snapshot);
  model = {
    ...model,
    triggerKind: backendScope === 'cursor' ? 'cursor' : 'file',
    actionsVisible: false,
    loading: settings.useBackend,
    trigger,
  };
  publishSuggestionModel(model, true);
  if (model.loading) {
    armSlowNotice(model);
  }
  publishActiveRackSnapshot(snapshot, model, null, `${reason}:local`);
  if (settings.autoRevealPanel && backendScope === 'file' && autoRevealedSuggestionUri !== snapshot.uriString) {
    void fileView?.reveal(true);
    setAutoRevealedSuggestionUri(snapshot.uriString);
  }

  let projectIndex: WorkspaceProjectIndex | null = null;
  if (settings.useBackend) {
    projectIndex = await getWorkspaceProjectIndex();
    if (!isSnapshotStillActive(snapshot, backendScope)) {
      return activeSuggestionModel;
    }
    const previousLoading = activeSuggestionModel;
    model = {
      ...buildLocalActiveSuggestion(snapshot, projectIndex),
      triggerKind: backendScope === 'cursor' ? 'cursor' : 'file',
      actionsVisible: false,
      loading: true,
      trigger,
    };
    // Si ya se habia avisado que tarda, el aviso se mantiene.
    if (previousLoading?.slow && previousLoading.metricId === model.metricId) {
      model = { ...model, slow: true };
    }
    publishSuggestionModel(model, true);
    if (!model.slow) {
      armSlowNotice(model);
    }
    publishActiveRackSnapshot(snapshot, model, projectIndex, `${reason}:indexed-local`);
  }

  // 0.0.39: la explicacion en vivo del foco va a la sugerencia que se esta mostrando (loading).
  const livePainter = settings.useBackend && backendScope === 'cursor' ? startLivePainter(model, snapshot) : null;
  if (settings.useBackend) {
    try {
      const selectedFocus = hasActiveSelection(snapshot);
      const fileSummaryRequest = selectedFocus
        ? null
        : withActiveSuggestionDeadline(
          getBackendSuggestionText(settings, snapshot, projectIndex, 'file_summary', requestContext),
          fallbackDelayMs,
        );
      let focusResult: BackendSuggestionResult;
      let fileSummaryResult: BackendSuggestionResult = createEmptyBackendSuggestionResult();
      let partialBackendError = '';

      if (backendScope === 'cursor') {
        const cursorRequest = withActiveSuggestionDeadline(
          getBackendSuggestionText(settings, snapshot, projectIndex, 'cursor', requestContext, livePainter?.onEvent),
          fallbackDelayMs,
        );
        const cursorSettled = await settleBackendSuggestionResult(cursorRequest);
        const fileSummarySettled = fileSummaryRequest
          ? await settleBackendSuggestionResult(fileSummaryRequest)
          : null;
        const backendErrors: string[] = [];

        if (cursorSettled.ok) {
          focusResult = cursorSettled.result;
        } else {
          focusResult = createEmptyBackendSuggestionResult();
          backendErrors.push(`seleccion: ${formatBackendSuggestionError(cursorSettled.error)}`);
        }

        if (fileSummarySettled?.ok) {
          fileSummaryResult = fileSummarySettled.result;
        } else if (fileSummarySettled) {
          backendErrors.push(`resumen archivo: ${formatBackendSuggestionError(fileSummarySettled.error)}`);
        }

        if (!cursorSettled.ok && (!fileSummarySettled || !fileSummarySettled.ok)) {
          throw new Error(backendErrors.join(' | ') || 'Backend no disponible para sugerencias.');
        }

        partialBackendError = backendErrors.join(' | ');
        if (partialBackendError) {
          output.appendLine(
            `[Suggestions] Backend parcial (${reason}, ${getBackendSuggestionScopeLabel(backendScope)}): ${partialBackendError}`,
          );
        }
      } else {
        focusResult = await fileSummaryRequest!;
      }
      backendLatencyMs = focusResult.latencyMs ?? fileSummaryResult.latencyMs;

      const backendModel = buildBackendActiveSuggestionModel(
        snapshot,
        projectIndex,
        backendScope,
        focusResult,
        fileSummaryResult,
        partialBackendError,
        trigger,
      );
      if (backendModel) {
        model = backendModel;
      } else {
        throw new BackendAnsweredWithoutSuggestion();
      }
    } catch (error) {
      livePainter?.dispose();
      const backendErrorMessage = formatBackendSuggestionError(error);
      const remainingMs = fallbackDelayMs - (Date.now() - backendStartedAt);
      // El tutor ya contesto (sin nada utilizable): la pista local sale de una vez, sin
      // dejar la ventana «consultando al tutor» hasta el tiempo limite.
      if (remainingMs > 0 && !(error instanceof BackendAnsweredWithoutSuggestion)) {
        await delay(remainingMs);
      }
      if (!isSnapshotStillActive(snapshot, backendScope)) {
        return activeSuggestionModel;
      }
      model = {
        ...model,
        source: 'local-fallback',
        backendError: truncateInline(backendErrorMessage, 180),
        loading: false,
        partialText: undefined,
      };
      output.appendLine(
        `[Suggestions] Backend no disponible (${reason}, ${getBackendSuggestionScopeLabel(backendScope)}): ${backendErrorMessage}`,
      );
    }
  }

  // Llego la respuesta (o el respaldo): lo que quede en vivo ya no se pinta.
  livePainter?.dispose();
  if (!isSnapshotStillActive(snapshot, backendScope)) {
    return activeSuggestionModel;
  }
  const keepVisibleActions = backendScope === 'cursor'
    && !!activeSuggestionModel?.actionsVisible
    && activeSuggestionModel.uriString === snapshot.uriString
    && (activeSuggestionModel.selectionRangeKey
      ? activeSuggestionModel.selectionRangeKey === snapshot.selectionRangeKey
      : activeSuggestionModel.line === snapshot.line && activeSuggestionModel.column === snapshot.column);
  const finalModel = keepVisibleActions && isSuggestionApplyOffered(model) ? { ...model, actionsVisible: true } : model;
  const shownLatencyMs = Date.now() - backendStartedAt;
  publishSuggestionModel(finalModel, true);
  if (!finalModel.blocked) {
    // Un mensaje bloqueado no se puede aplicar: no cuenta para "ignorada".
    suggestionExposure.markShown(finalModel.metricId, finalModel, Date.now());
  }
  recordSuggestionMetric(finalModel, 'vscode_suggestion_shown', finalModel.applyMode, {
    reason,
    cacheNamespace: backendScope,
    projectIndexKey: projectIndex?.cacheKey || '',
    backendLatencyMs,
    visibleErrorLine: snapshot.diagnostics.firstError?.line ?? null,
  }, true, { latencyMs: shownLatencyMs });
  if (finalModel.blocked) {
    recordSuggestionMetric(
      finalModel,
      'vscode_suggestion_blocked_by_policy',
      finalModel.policyApplied?.reasonCode || 'controlled_message',
      { reason },
      true,
      { category: 'tutor' },
    );
  }
  if (trigger === 'blocking' && finalModel.source === 'backend' && pendingBlocking?.uriString === finalModel.uriString) {
    // El bloqueo ya recibio su sugerencia; las siguientes vuelven a su trigger normal.
    setPendingBlocking(null);
  }
  publishActiveRackSnapshot(snapshot, finalModel, projectIndex, `${reason}:final`);
  if (backendScope === 'file' && settings.autoRevealPanel && autoRevealedSuggestionUri !== finalModel.uriString) {
    void fileView?.reveal(true);
    setAutoRevealedSuggestionUri(finalModel.uriString);
  }
  output.appendLine(
    `[Suggestions] ${finalModel.filePath} | scope=${backendScope} | trigger=${trigger} | fuente=${finalModel.source} | linea=${finalModel.line}${finalModel.decisionId ? ` | decision=${finalModel.decisionId}` : ''}${finalModel.blocked ? ' | bloqueada por politica' : ''}`,
  );
  return finalModel;
};

const scheduleActiveSuggestionRefresh = (reason = 'auto') => {
  const settings = resolveActiveSuggestionSettings();
  if (!settings.enabled) {
    publishSuggestionModel(null, false);
    return;
  }
  if (suggestionTimer) {
    clearTimeout(suggestionTimer);
  }
  setSuggestionTimer(setTimeout(() => {
    setSuggestionTimer(null);
    void refreshActiveSuggestion(reason);
  }, settings.debounceMs));
};
