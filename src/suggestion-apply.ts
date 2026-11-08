// ADACEEN (VS Code): aplicar la sugerencia activa (con apply-check), pedir al tutor el codigo de otra accion y botones de la ventana.
// Movido desde activate() (src/extension.ts): mismo texto; el estado compartido esta en *-state.ts.
import * as vscode from 'vscode';
import { buildBackendActiveSuggestionModel } from './active-suggestion';
import { guardCodeApplication } from './code-application-guard';
import { isExplicitClickOrigin } from './code-application-origin';
import { ACTIVE_SUGGESTION_FALLBACK_DELAY_MS } from './constants';
import { buildActiveEditorSnapshot, isSnapshotStillActive, resolveEditorForSuggestion } from './editor-snapshot';
import { codeApplicationGuardDeps, output, quizView, telemetry } from './extension-state';
import { SELECTION_WIDGET_ORIGIN } from './selection-widget';
import { primarySuggestionText } from './selection-widget-model';
import { resolveActiveSuggestionSettings } from './settings';
import { getBackendSuggestionText, getWorkspaceProjectIndex } from './suggestion-backend';
import { codeRequestNoteFor, suggestionReadyForMode } from './suggestion-code';
import type { EditorCodeAction } from './suggestion-code';
import { buildAppliedSuggestionModel, planSuggestionEdit } from './suggestion-edit';
import { armSlowNotice, publishSuggestionModel, recordIgnoredSuggestion, recordSuggestionMetric } from './suggestion-publish';
import { createEmptyBackendSuggestionResult, formatBackendSuggestionError, truncateInline, withActiveSuggestionDeadline } from './suggestion-results';
import { requestSelectionSuggestion } from './suggestion-refresh';
import { suppressAutoRefreshForActiveApply } from './suggestion-schedule';
import { activeSuggestionModel, applyInProgress, codeRequestInFlightKey, dismissedSuggestionMetricId, selectionHint, selectionWidget, setApplyInProgress, setCodeRequestInFlightKey, setDismissedSuggestionMetricId, setLastRequestedModel, setSuppressSuggestionRefreshUntil, suggestionExposure } from './suggestion-state';
import type { ActiveSuggestionModel, BackendSuggestionRequestContext, SuggestionApplyMode } from './types';

const notifyQuizOfAcceptedChange = (
  model: ActiveSuggestionModel,
  mode: SuggestionApplyMode,
  originalCode: string,
  newCode: string,
) => {
  void quizView.onSuggestionAccepted({
    filePath: model.filePath,
    language: model.language,
    applyMode: mode,
    originalCode,
    newCode,
    suggestionText: model.lineSummary || primarySuggestionText(model) || '',
    ragCourseCode: model.ragCourseCode || '',
    repoFullName: model.repoFullName || '',
  });
};

/**
 * Pide al tutor el codigo de una accion (0.0.34): «Proponer una mejora»
 * (replace: la seleccion completa mejorada) o «Proponer codigo para continuar»
 * (insert). Antes, elegir una accion distinta de la recomendada aplicaba el
 * codigo escrito para la otra (o un «TODO» inventado) y podia romper el bloque.
 * El resultado se muestra en la ventana flotante; aplicarlo es otro clic.
 */
const requestCodeForMode = async (model: ActiveSuggestionModel, mode: EditorCodeAction, origin: string) => {
  // Se marca antes del primer await. Un pedido para otro bloque si sale: el anterior,
  // al llegar, ve que ya no es la sugerencia activa y no se pinta.
  const key = `${model.metricId}:${mode}`;
  if (codeRequestInFlightKey === key) {
    return;
  }
  setCodeRequestInFlightKey(key);
  try {
    await requestCodeForModeNow(model, mode, origin);
  } finally {
    if (codeRequestInFlightKey === key) {
      setCodeRequestInFlightKey('');
    }
  }
};

const requestCodeForModeNow = async (model: ActiveSuggestionModel, mode: EditorCodeAction, origin: string) => {
  const settings = resolveActiveSuggestionSettings();
  if (!settings.enabled || !settings.useBackend) {
    void vscode.window.showInformationMessage('ADACEEN: para pedir código hace falta el tutor (ajuste adaceen.suggestions.useBackend).');
    return;
  }
  const editor = await resolveEditorForSuggestion(model);
  if (!editor) {
    void vscode.window.showInformationMessage('ADACEEN: abre el archivo de la sugerencia para pedir el código.');
    return;
  }
  const snapshot = await buildActiveEditorSnapshot(settings);
  const sameFocus = !!snapshot
    && snapshot.uriString === model.uriString
    && (model.selectionRangeKey ? snapshot.selectionRangeKey === model.selectionRangeKey : snapshot.line === model.line);
  if (!snapshot || !sameFocus) {
    void vscode.window.showInformationMessage('ADACEEN: la selección cambió. Selecciona otra vez el bloque y vuelve a pedir el código.');
    return;
  }
  const documentVersion = editor.document.version;
  selectionHint.lastRequestAt = Date.now();

  const pending: ActiveSuggestionModel = { ...model, pendingMode: mode, slow: false, codeRequestNote: '', snapshotKey: snapshot.cacheKey };
  publishSuggestionModel(pending, true);
  armSlowNotice(pending);
  recordSuggestionMetric(model, 'vscode_suggestion_manual_refresh', mode, { requestedAction: mode, origin });
  // Lo que se muestra si el pedido no trae codigo: la misma sugerencia con una nota.
  const keepWithNote = (note: string) => {
    const current = activeSuggestionModel;
    if (current && current.metricId === pending.metricId && current.pendingMode === mode) {
      publishSuggestionModel({ ...model, pendingMode: undefined, slow: false, codeRequestNote: note, snapshotKey: snapshot.cacheKey }, true);
    }
  };
  try {
    const projectIndex = await getWorkspaceProjectIndex();
    const requestContext: BackendSuggestionRequestContext = {
      trigger: 'manual',
      clientSessionId: telemetry.clientSessionId,
      requestedAction: mode,
    };
    const result = await withActiveSuggestionDeadline(
      getBackendSuggestionText(settings, snapshot, projectIndex, 'cursor', requestContext),
      Math.min(settings.backendTimeoutMs, ACTIVE_SUGGESTION_FALLBACK_DELAY_MS),
    );
    const current = activeSuggestionModel;
    const stillPending = !!current && current.metricId === pending.metricId && current.pendingMode === mode;
    const next = buildBackendActiveSuggestionModel(
      snapshot,
      projectIndex,
      'cursor',
      result,
      createEmptyBackendSuggestionResult(),
      '',
      'manual',
      mode,
    );
    if (!next) {
      if (stillPending) {
        keepWithNote('El tutor respondió sin código para esto. Prueba «Otra sugerencia» o escríbelo con la pista.');
      }
      return;
    }
    // El resumen del archivo es el de antes: este pedido solo trae el foco.
    const shown: ActiveSuggestionModel = next.blocked
      ? { ...next, snapshotKey: snapshot.cacheKey }
      : {
        ...next,
        fileOverview: model.fileOverview || next.fileOverview,
        fileOverviewFromTutor: model.fileOverviewFromTutor,
        fileSuggestions: model.fileSuggestions.length ? model.fileSuggestions : next.fileSuggestions,
        codeRequestNote: codeRequestNoteFor(next, mode),
        snapshotKey: snapshot.cacheKey,
      };
    if (!shown.blocked) {
      // Si el estudiante vuelve a este mismo bloque sin cambios, se le muestra (refreshActiveSuggestion).
      setLastRequestedModel(shown);
    }
    // Mientras llegaba, el estudiante se fue a otro bloque o archivo, cambio el texto o
    // cerro la ventana con la X: no se pinta sobre las lineas viejas.
    const moved = !isSnapshotStillActive(snapshot, 'cursor') || editor.document.version !== documentVersion;
    if (!stillPending || moved || dismissedSuggestionMetricId === pending.metricId) {
      if (stillPending) {
        publishSuggestionModel(null, true);
      }
      output.appendLine(`[Suggestions] ${shown.filePath} | codigo pedido=${mode} llego cuando ya no estaba a la vista`);
      return;
    }
    // La sugerencia original no se ignoro: el estudiante pidio su codigo.
    suggestionExposure.forget(pending.metricId);
    publishSuggestionModel(shown, true);
    if (!shown.blocked) {
      suggestionExposure.markShown(shown.metricId, shown, Date.now());
    }
    recordSuggestionMetric(shown, 'vscode_suggestion_shown', shown.applyMode, {
      reason: 'code-request',
      requestedAction: mode,
      cacheNamespace: 'cursor',
    }, true, { latencyMs: result.latencyMs });
    output.appendLine(`[Suggestions] ${shown.filePath} | codigo pedido=${mode} | ${suggestionReadyForMode(shown, mode) ? 'con codigo' : 'sin codigo'}${shown.blocked ? ' | bloqueada por politica' : ''}`);
  } catch (error) {
    const message = formatBackendSuggestionError(error);
    output.appendLine(`[Suggestions] No llego el codigo pedido (${mode}): ${message}`);
    keepWithNote(`No llegó el código del tutor (${truncateInline(message, 120)}). Intenta de nuevo en un momento.`);
  }
};

/**
 * Aplica la sugerencia activa. Todos los caminos del editor pasan por aqui
 * (ventana flotante, CodeLens "Aceptar ayuda", quick fix, inlay hint, hover,
 * panel y paleta de comandos) y, antes de editar, por el guard de
 * aplicacion (apply-check).
 */
const applySuggestionCompletionNow = async (modeOverride: SuggestionApplyMode | undefined, origin: string) => {
  const model = activeSuggestionModel;
  const editor = model ? await resolveEditorForSuggestion(model) : undefined;
  if (!editor || !model || editor.document.uri.toString() !== model.uriString) {
    vscode.window.showInformationMessage('ADACEEN: no hay una sugerencia activa para aplicar.');
    return;
  }
  if (model.applied) {
    vscode.window.showInformationMessage('ADACEEN: esta ayuda ya fue aplicada. Valida el cambio o actualiza la sugerencia.');
    return;
  }
  if (model.blocked) {
    vscode.window.showInformationMessage('ADACEEN: esta respuesta del tutor no trae código para aplicar.');
    return;
  }

  if (model.pendingMode) {
    return; // se esta preparando el codigo de una accion: un clic mas no hace nada
  }
  const mode = modeOverride || model.applyMode || 'insert';
  if (model.awaitingRequest && mode === 'delete') {
    // 0.0.40: sin respuesta del tutor no hay nada que recomiende borrar (la accion del modelo
    // seria la de la pista local).
    vscode.window.showInformationMessage('ADACEEN: primero pide una sugerencia o código para esta selección.');
    return;
  }
  if (mode !== 'delete' && !suggestionReadyForMode(model, mode)) {
    // 0.0.34: el codigo de la sugerencia no es para esta accion (o no hay codigo): se pide
    // al tutor y se muestra antes de aplicar nada. Sin esperar aqui: mientras llega, el
    // estudiante puede moverse y las sugerencias de otros bloques siguen llegando
    // (applyInProgress solo cubre apply-check y la confirmacion).
    void requestCodeForMode(model, mode, origin);
    return;
  }
  output.appendLine(
    `[Apply] ${model.fileName}: modo=${mode} (${modeOverride ? 'elegido' : 'recomendado'}) | `
    + `seleccion=${editor.selection.isEmpty ? 'no' : `${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`}`,
  );
  let plan = planSuggestionEdit(editor, model, mode);
  if (!plan.ok) {
    vscode.window.showInformationMessage(plan.message);
    return;
  }

  const versionBeforeCheck = editor.document.version;
  const verdict = await guardCodeApplication({
    decisionId: model.decisionId,
    filePath: model.filePath,
    language: model.language,
    applyMode: mode,
    originalText: plan.removedText,
    newText: plan.proposedText,
    trigger: model.trigger,
    origin,
    fileLabel: model.fileName,
    repoFullName: model.repoFullName,
    // Ventana flotante, CodeLens, arreglo rapido, pista, hover o comando: el clic confirma.
    explicitClick: isExplicitClickOrigin(origin),
  }, codeApplicationGuardDeps);
  if (!verdict.allowed) {
    return;
  }
  if (editor.document.version !== versionBeforeCheck) {
    // El archivo cambio mientras se consultaba o confirmaba: se recalcula sobre el texto actual.
    plan = planSuggestionEdit(editor, model, mode);
    if (!plan.ok) {
      vscode.window.showInformationMessage(plan.message);
      return;
    }
  }

  const readyPlan = plan;
  suppressAutoRefreshForActiveApply(model.uriString);
  const applied = await editor.edit((editBuilder) => {
    if (readyPlan.operation === 'delete') {
      editBuilder.delete(readyPlan.range);
    } else if (readyPlan.operation === 'insert') {
      editBuilder.insert(readyPlan.range.start, readyPlan.text);
    } else {
      editBuilder.replace(readyPlan.range, readyPlan.text);
    }
  });
  if (!applied) {
    setSuppressSuggestionRefreshUntil(0);
    vscode.window.showWarningMessage(mode === 'delete'
      ? 'ADACEEN: no se pudo aplicar la eliminacion en el editor.'
      : 'ADACEEN: no se pudo aplicar la sugerencia en el editor.');
    return;
  }

  const finalPosition = readyPlan.operation === 'delete'
    ? readyPlan.range.start
    : editor.document.positionAt(editor.document.offsetAt(readyPlan.range.start) + readyPlan.text.length);
  editor.selection = new vscode.Selection(finalPosition, finalPosition);
  const shownAt = suggestionExposure.shownAt(model.metricId);
  recordSuggestionMetric(model, 'suggestion_completion_applied', mode, {
    appliedMode: mode,
    ...(mode === 'delete'
      ? { deletedCharacters: readyPlan.removedText.length }
      : { insertedCharacters: readyPlan.text.length }),
    linesChanged: verdict.linesChanged,
    charsChanged: verdict.charsChanged,
    origin,
    applyCheck: verdict.offline ? 'offline' : 'server',
    confirmedByStudent: verdict.confirmed,
    confirmedBy: verdict.confirmedBy || '',
  }, false, {
    decisionId: verdict.decisionId || model.decisionId,
    durationMs: shownAt === null ? null : Date.now() - shownAt,
  });
  publishSuggestionModel(buildAppliedSuggestionModel(model, mode, finalPosition), true);
  notifyQuizOfAcceptedChange(model, mode, readyPlan.quizOriginalCode, mode === 'delete' ? '' : readyPlan.proposedText);
};

export const applySuggestionCompletion = async (modeOverride?: SuggestionApplyMode, origin = 'command') => {
  if (applyInProgress) {
    // Doble clic mientras se consulta apply-check o se espera la confirmacion.
    return;
  }
  setApplyInProgress(true);
  try {
    await applySuggestionCompletionNow(modeOverride, origin);
  } finally {
    setApplyInProgress(false);
  }
};

export function registerSelectionWidgetCommands(context: vscode.ExtensionContext) {
  // Botones de la ventana flotante. Reciben el hilo de comentarios como
  // argumento (lo pone VS Code), que aqui no hace falta: la accion siempre
  // va sobre la sugerencia activa.
  const selectionWidgetDisposables = [
    selectionWidget,
    vscode.commands.registerCommand('adaceen.selectionWidget.insert', () => applySuggestionCompletion('insert', SELECTION_WIDGET_ORIGIN)),
    vscode.commands.registerCommand('adaceen.selectionWidget.replace', () => applySuggestionCompletion('replace', SELECTION_WIDGET_ORIGIN)),
    vscode.commands.registerCommand('adaceen.selectionWidget.delete', () => applySuggestionCompletion('delete', SELECTION_WIDGET_ORIGIN)),
    // 0.0.40: botones de la ventana antes de consultar al tutor (titulo del hilo «elige una ayuda»).
    vscode.commands.registerCommand('adaceen.selectionWidget.suggest', () => requestSelectionSuggestion()),
    vscode.commands.registerCommand('adaceen.selectionWidget.proposeImprovement', () => applySuggestionCompletion('replace', SELECTION_WIDGET_ORIGIN)),
    vscode.commands.registerCommand('adaceen.selectionWidget.proposeContinuation', () => applySuggestionCompletion('insert', SELECTION_WIDGET_ORIGIN)),
    vscode.commands.registerCommand('adaceen.selectionWidget.close', () => {
      // Cerrar la ventana sin aplicar cuenta como sugerencia descartada.
      const model = activeSuggestionModel;
      const dismissed = model ? suggestionExposure.dismiss(model.metricId, Date.now()) : null;
      if (dismissed) {
        recordIgnoredSuggestion(dismissed.item, dismissed.durationMs, 'closed');
      }
      // Descartada: al cerrarse la ventana, el CodeLens y la pista no la vuelven a ofrecer.
      setDismissedSuggestionMetricId(model?.metricId || '');
      selectionWidget.hide();
    }),
  ];
  context.subscriptions.push(...selectionWidgetDisposables);
}
