// ADACEEN (VS Code): pedir y mostrar la sugerencia del foco o del archivo (refreshActiveSuggestion) y su origen (trigger).
// Movido desde activate() (src/extension.ts): mismo texto; el estado compartido esta en *-state.ts.
import * as vscode from 'vscode';
import { buildBackendActiveSuggestionModel, isSuggestionApplyOffered } from './active-suggestion';
import { ACTIVE_SUGGESTION_FALLBACK_DELAY_MS, BLOCKING_TRIGGER_TTL_MS } from './constants';
import { buildActiveEditorSnapshot, hasActiveSelection, isSnapshotStillActive, isSuggestionModelDocumentVisible, resolveBackendScopeForSnapshot } from './editor-snapshot';
import { output, telemetry } from './extension-state';
import { fileView } from './file-view-state';
import { buildLocalActiveSuggestion } from './local-suggestion';
import { resolveActiveSuggestionSettings, resolveTriggerSettings } from './settings';
import { buildBackendSuggestionTextCacheKey, getBackendSuggestionText, getWorkspaceProjectIndex } from './suggestion-backend';
import { getBackendSuggestionScopeLabel } from './suggestion-format';
import { publishActiveEditorRack } from './suggestion-metrics';
import { suggestionPhase } from './suggestion-phase';
import { armSlowNotice, publishSuggestionModel, recordSuggestionMetric } from './suggestion-publish';
import { createEmptyBackendSuggestionResult, delay, formatBackendSuggestionError, settleBackendSuggestionResult, truncateInline, withActiveSuggestionDeadline } from './suggestion-results';
import { activeSuggestionModel, autoRevealedSuggestionUri, backendSuggestionCache, selectionHint, lastRequestedModel, pendingBlocking, pendingFileOpenUri, rackSyncErrorNotified, setAutoRevealedSuggestionUri, setLastKnownRepoFullName, setLastRequestedModel, setPendingBlocking, setPendingFileOpenUri, setRackSyncErrorNotified, setSuggestionTimer, suggestionExposure, suggestionTimer } from './suggestion-state';
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
  // 0.0.40: «Sugerencia ADACEEN» se pide sobre la seleccion: un bloqueo pendiente del archivo no
  // la convierte en una pregunta por el error (la respuesta seria para otra linea).
  if (reason === 'selection-request' && hasActiveSelection(snapshot)) {
    return 'selection';
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
  // 0.0.40: ya no hay una consulta automatica cada 3 s que reemplace esta espera. Si el foco
  // cambio, el «consultando al tutor» de esta consulta se retira (la respuesta igual entra a la
  // cache local y sale al volver a seleccionar). La respuesta de un bloqueo sin seleccion es sobre
  // el error: se muestra aunque el cursor se haya movido dentro del mismo archivo.
  let loadingMetricId = model.metricId;
  const stillActive = () => isSnapshotStillActive(snapshot, backendScope)
    || (trigger === 'blocking' && !hasActiveSelection(snapshot) && isSnapshotStillActive(snapshot, 'file')
      && !!vscode.window.activeTextEditor?.selection.isEmpty);
  const abandon = () => {
    const current = activeSuggestionModel;
    if (current?.loading && current.metricId === loadingMetricId && current.uriString === snapshot.uriString) {
      publishSuggestionModel(null, true);
    }
    return activeSuggestionModel;
  };
  publishActiveRackSnapshot(snapshot, model, null, `${reason}:local`);
  if (settings.autoRevealPanel && backendScope === 'file' && autoRevealedSuggestionUri !== snapshot.uriString) {
    void fileView?.reveal(true);
    setAutoRevealedSuggestionUri(snapshot.uriString);
  }

  let projectIndex: WorkspaceProjectIndex | null = null;
  if (settings.useBackend) {
    projectIndex = await getWorkspaceProjectIndex();
    if (!stillActive()) {
      return abandon();
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
    loadingMetricId = model.metricId;
    if (!model.slow) {
      armSlowNotice(model);
    }
    publishActiveRackSnapshot(snapshot, model, projectIndex, `${reason}:indexed-local`);
  }

  if (settings.useBackend) {
    try {
      // 0.0.40: la sugerencia del foco ya no pide tambien el resumen del archivo (antes salian las
      // dos y se esperaba a la mas lenta). El resumen lo pide la vista «Este archivo» al abrirse.
      const fileSummaryRequest = backendScope === 'cursor'
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
          getBackendSuggestionText(settings, snapshot, projectIndex, 'cursor', requestContext),
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
      const backendErrorMessage = formatBackendSuggestionError(error);
      const remainingMs = fallbackDelayMs - (Date.now() - backendStartedAt);
      // El tutor ya contesto (sin nada utilizable): la pista local sale de una vez, sin
      // dejar la ventana «consultando al tutor» hasta el tiempo limite.
      if (remainingMs > 0 && !(error instanceof BackendAnsweredWithoutSuggestion)) {
        await delay(remainingMs);
      }
      if (!stillActive()) {
        return abandon();
      }
      model = {
        ...model,
        source: 'local-fallback',
        backendError: truncateInline(backendErrorMessage, 180),
        loading: false,
      };
      output.appendLine(
        `[Suggestions] Backend no disponible (${reason}, ${getBackendSuggestionScopeLabel(backendScope)}): ${backendErrorMessage}`,
      );
    }
  }

  if (!stillActive()) {
    return abandon();
  }
  const keepVisibleActions = backendScope === 'cursor'
    && !!activeSuggestionModel?.actionsVisible
    && activeSuggestionModel.uriString === snapshot.uriString
    && (activeSuggestionModel.selectionRangeKey
      ? activeSuggestionModel.selectionRangeKey === snapshot.selectionRangeKey
      : activeSuggestionModel.line === snapshot.line && activeSuggestionModel.column === snapshot.column);
  // 0.0.40: una respuesta pedida con «Sugerencia ADACEEN» trae sus acciones a la vista (el
  // temporizador que las revelaba ya paso, sobre las opciones).
  const showActions = (keepVisibleActions || reason === 'selection-request') && isSuggestionApplyOffered(model);
  const revealOnArrival = showActions && !keepVisibleActions;
  const visibleModel = showActions ? { ...model, actionsVisible: true } : model;
  // 0.0.40: la foto del editor de la respuesta del foco. Si el estudiante vuelve a seleccionar el
  // mismo bloque sin cambios, showSelectionRequestOptions muestra esta y no vuelve a las opciones.
  const finalModel = backendScope === 'cursor' && !visibleModel.snapshotKey
    ? { ...visibleModel, snapshotKey: snapshot.cacheKey }
    : visibleModel;
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
  if (revealOnArrival) {
    // Lo mismo que contaba revealSuggestionActions cuando la respuesta llegaba sola.
    recordSuggestionMetric(finalModel, 'vscode_suggestion_actions_revealed', finalModel.applyMode, { reason }, true);
  }
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

/**
 * 0.0.40 (prueba del 5-11-2026: ~1 min por respuesta). Antes cada pausa del cursor (3 s) le pedia
 * al tutor la sugerencia de esa linea y el resumen del archivo, y cada pausa de la seleccion
 * (1,2 s) otra. Nada las cancelaba en el servidor: la GPU generaba respuestas que nadie leia y la
 * que el estudiante si esperaba quedaba detras. Ahora seleccionar solo abre la ventana con los
 * pedidos («Sugerencia ADACEEN», «Proponer una mejora», «Proponer código para continuar») y el
 * tutor trabaja cuando el estudiante elige uno.
 *
 * Si ya hay una respuesta para esta misma seleccion sin cambios en el codigo (la de la ventana,
 * un codigo pedido o la pista en la cache local), se muestra esa, sin volver a las opciones.
 */
export const showSelectionRequestOptions = async () => {
  const settings = resolveActiveSuggestionSettings();
  if (!settings.enabled) {
    publishSuggestionModel(null, false);
    return null;
  }
  if (!settings.useBackend) {
    // Sin tutor no hay GPU que cuidar: la pista local de siempre.
    return refreshActiveSuggestion('cursor-idle');
  }
  const snapshot = await buildActiveEditorSnapshot(settings);
  if (!snapshot || !hasActiveSelection(snapshot) || !isSnapshotStillActive(snapshot, 'cursor')) {
    return null;
  }
  const sameSnapshot = (model: ActiveSuggestionModel | null): model is ActiveSuggestionModel =>
    !!model && !model.applied && model.uriString === snapshot.uriString && model.selectionRangeKey === snapshot.selectionRangeKey;
  const active = activeSuggestionModel;
  if (sameSnapshot(active)) {
    // Ya se esta consultando al tutor por esta seleccion: se espera esa respuesta.
    if (active.loading || active.pendingMode) {
      return active;
    }
    // La respuesta de esta misma foto del editor (la ventana se habia cerrado al soltar la
    // seleccion: se vuelve a pintar). Una pista local o «tutor no disponible» si vuelven a las
    // opciones, para poder pedir otra vez.
    const phase = suggestionPhase(active);
    if (active.snapshotKey === snapshot.cacheKey && (phase === 'ready' || phase === 'blocked') && active.source === 'backend') {
      publishSuggestionModel(active, true);
      return active;
    }
  }
  // Codigo pedido antes para esta misma foto del editor (refreshActiveSuggestion hace lo mismo).
  if (sameSnapshot(lastRequestedModel) && lastRequestedModel.snapshotKey === snapshot.cacheKey) {
    publishSuggestionModel(lastRequestedModel, true);
    return lastRequestedModel;
  }
  const projectIndex = await getWorkspaceProjectIndex();
  if (!isSnapshotStillActive(snapshot, 'cursor')) {
    return activeSuggestionModel;
  }
  const trigger = resolveSuggestionTrigger('selection-request', snapshot);
  // La pista de esta seleccion ya llego antes: sale de la cache local, sin pasar por la GPU.
  if (backendSuggestionCache.cursor.has(buildBackendSuggestionTextCacheKey(snapshot, projectIndex, 'cursor', trigger))) {
    return refreshActiveSuggestion('selection-request');
  }
  const model: ActiveSuggestionModel = {
    ...buildLocalActiveSuggestion(snapshot, projectIndex),
    triggerKind: 'cursor',
    actionsVisible: false,
    loading: false,
    awaitingRequest: true,
    trigger,
  };
  publishSuggestionModel(model, true);
  publishActiveRackSnapshot(snapshot, model, projectIndex, 'selection:awaiting');
  return model;
};

/**
 * 0.0.40: «Sugerencia ADACEEN» (ventana flotante, su titulo, el CodeLens o el hover): la pista de
 * la seleccion, que antes salia sola al seleccionar. Va con el trigger "selection" de entonces: el
 * backend la trata igual (cache, politica, etapa). «Otra sugerencia» sigue siendo "manual" y es la
 * que sube la etapa.
 */
export async function requestSelectionSuggestion() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage('ADACEEN: selecciona el bloque de código y elige «Sugerencia ADACEEN».');
    return null;
  }
  selectionHint.lastRequestAt = Date.now();
  return refreshActiveSuggestion('selection-request');
}

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
