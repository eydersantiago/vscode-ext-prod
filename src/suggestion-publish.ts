// ADACEEN (VS Code): publicar la sugerencia activa en sus superficies y en la vista «Este archivo», y registrar sus metricas.
// Movido desde activate() (src/extension.ts): mismo texto; el estado compartido esta en *-state.ts.
import * as vscode from 'vscode';
import { SLOW_NOTICE_MS } from './constants';
import { workspaceRelativePath } from './dependency-scan';
import { extensionContext, latestSuggestionHistory, output, quizView, setLatestSuggestionHistory, telemetry } from './extension-state';
import { buildDependencyViewState, buildFileViewState } from './file-view-model';
import type { FileViewActiveFile } from './file-view-model';
import { dependencyState, fileSummaries, fileSummaryInFlight, fileView, fileViewDocument, materialState, workshopProgress } from './file-view-state';
import { toSelectionWidgetModel } from './selection-widget-model';
import { resolveActiveSuggestionSettings } from './settings';
import { applySuggestionDecoration, updateSuggestionStatusBar } from './suggestion-decorations';
import { rememberSuggestionHistory } from './suggestion-history';
import { recordVscodeSuggestionMetric, toQuizHistoryItems } from './suggestion-metrics';
import type { SuggestionMetricFields } from './suggestion-metrics';
import { isSuggestionCodeActionRequestFocused } from './suggestion-providers';
import { inferActiveLanguage, pathBaseName } from './suggestion-results';
import { activeSuggestionModel, autoOpenedSelectionActionKey, dismissedSuggestionMetricId, recordedSuggestionMetricKeys, selectionInlinePanelTimer, selectionWidget, selectionWidgetPresence, setActiveSuggestionModel, setAutoOpenedSelectionActionKey, setDismissedSuggestionMetricId, setQuickFixAutoOpenedAt, setSelectionInlinePanelTimer, setSlowNoticeTimer, slowNoticeTimer, suggestionCodeActionProvider, suggestionCodeLensProvider, suggestionDecorationType, suggestionExposure, suggestionInlayHintProvider, suggestionStatusBar } from './suggestion-state';
import { inlineSurfaceModel } from './suggestion-surfaces';
import type { ActiveSuggestionModel } from './types';
import { buildProgressPill } from './workshop-progress';

export const recordIgnoredSuggestion = (model: ActiveSuggestionModel, durationMs: number, reason: 'replaced' | 'dismissed' | 'closed') => {
  recordVscodeSuggestionMetric(telemetry, model, 'vscode_suggestion_ignored', reason, { reason }, { durationMs });
};

const maybeOpenSelectionInlinePanel = (model: ActiveSuggestionModel | null) => {
  const settings = resolveActiveSuggestionSettings();
  if (settings.selectionWidget) {
    // El widget flotante ya muestra la sugerencia y las tres acciones; abrir
    // ademas el hover y el menu de quick fix era lo que "esparcia" la informacion.
    return;
  }
  if (
    !settings.enabled ||
    !settings.autoOpenSelectionActions ||
    !model ||
    model.applied ||
    model.selectionLineCount <= 0
  ) {
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor || !isSuggestionCodeActionRequestFocused(model, editor.document, editor.selection)) {
    return;
  }

  const key = [
    model.uriString,
    model.selectionRangeKey,
    model.applyMode,
    model.updatedAt,
    model.loading ? 'loading' : 'ready',
    model.actionsVisible ? 'actions' : 'preview',
  ].join(':');
  if (autoOpenedSelectionActionKey === key) {
    return;
  }
  setAutoOpenedSelectionActionKey(key);

  if (selectionInlinePanelTimer) {
    clearTimeout(selectionInlinePanelTimer);
  }
  setSelectionInlinePanelTimer(setTimeout(() => {
    setSelectionInlinePanelTimer(null);
    if (
      activeSuggestionModel &&
      activeSuggestionModel.selectionLineCount > 0 &&
      [
        activeSuggestionModel.uriString,
        activeSuggestionModel.selectionRangeKey,
        activeSuggestionModel.applyMode,
        activeSuggestionModel.updatedAt,
        activeSuggestionModel.loading ? 'loading' : 'ready',
        activeSuggestionModel.actionsVisible ? 'actions' : 'preview',
      ].join(':') === key
    ) {
      void vscode.commands.executeCommand('editor.action.showHover');
      if (activeSuggestionModel.actionsVisible && !activeSuggestionModel.loading) {
        setTimeout(() => {
          // La accion recomendada queda preseleccionada: no cuenta como clic.
          setQuickFixAutoOpenedAt(Date.now());
          void vscode.commands.executeCommand('editor.action.quickFix');
        }, 220);
      }
    }
  }, model.loading ? 160 : 80));
};

/**
 * Pista en linea y decoracion de fin de linea de la sugerencia activa. Con la
 * ventana flotante abierta en ese archivo se apagan (ella ofrece la accion);
 * vuelven al cerrarla (suggestion-surfaces.ts).
 */
export const refreshInlineSuggestionSurfaces = () => {
  const model = inlineSurfaceModel(activeSuggestionModel, selectionWidgetPresence(), dismissedSuggestionMetricId);
  suggestionInlayHintProvider.update(model);
  applySuggestionDecoration(suggestionDecorationType, model);
};

/** Resumen del tutor (file_summary) que trae un modelo: se guarda por archivo para la vista. */
const rememberFileSummary = (model: ActiveSuggestionModel | null) => {
  if (!model || model.source !== 'backend' || !model.fileOverviewFromTutor || !model.fileOverview) {
    return;
  }
  fileSummaries.delete(model.uriString);
  fileSummaries.set(model.uriString, {
    uriString: model.uriString,
    overview: model.fileOverview,
    tips: model.fileSuggestions.slice(0, 3),
    updatedAt: new Date().toISOString(),
  });
  while (fileSummaries.size > 40) {
    fileSummaries.delete(fileSummaries.keys().next().value as string);
  }
};

const fileViewActiveFile = (): FileViewActiveFile | null => {
  const document = fileViewDocument;
  if (!document || document.isClosed) {
    return null;
  }
  const relativePath = workspaceRelativePath(document.uri);
  return {
    uriString: document.uri.toString(),
    fileName: pathBaseName(relativePath),
    language: inferActiveLanguage(relativePath, document.languageId),
  };
};

export const refreshFileView = () => {
  if (!fileView) {
    return;
  }
  const model = activeSuggestionModel;
  const activeFile = fileViewActiveFile();
  const uri = activeFile?.uriString || '';
  const deps = dependencyState && dependencyState.uriString === uri ? dependencyState : null;
  fileView.update(buildFileViewState(
    model,
    uri ? fileSummaries.get(uri) || null : null,
    !!uri && fileSummaryInFlight.has(uri),
    materialState,
    {
      activeFile,
      progress: buildProgressPill(workshopProgress.reply),
      dependencies: deps
        ? buildDependencyViewState(deps.result?.deps || null, deps.result?.filePath || '', deps.loading, {
          partial: deps.result?.partial,
          outside: deps.result?.outside,
          packageCode: deps.result?.packageCode,
          key: deps.result ? `${deps.result.uriString}|${deps.result.version}` : '',
        })
        : null,
    },
  ));
};

export const armSlowNotice = (model: ActiveSuggestionModel) => {
  if (slowNoticeTimer) {
    clearTimeout(slowNoticeTimer);
  }
  setSlowNoticeTimer(setTimeout(() => {
    setSlowNoticeTimer(null);
    const current = activeSuggestionModel;
    if (
      current
      && current.metricId === model.metricId
      && current.uriString === model.uriString
      && (current.loading || current.pendingMode)
      && !current.slow
    ) {
      publishSuggestionModel({ ...current, slow: true }, true);
    }
  }, SLOW_NOTICE_MS));
};

export const publishSuggestionModel = (model: ActiveSuggestionModel | null, enabled = true) => {
  // Una sugerencia mostrada que se reemplaza por otra o desaparece sin
  // aplicarse cuenta como ignorada (con el tiempo que estuvo a la vista).
  const ignored = suggestionExposure.onPublish(
    model ? { id: model.metricId, loading: !!model.loading, applied: !!model.applied } : null,
    Date.now(),
  );
  if (ignored) {
    recordIgnoredSuggestion(ignored.item, ignored.durationMs, model ? 'replaced' : 'dismissed');
  }
  setActiveSuggestionModel(model);
  rememberFileSummary(model);
  if (slowNoticeTimer && !(model?.loading || model?.pendingMode)) {
    clearTimeout(slowNoticeTimer);
    setSlowNoticeTimer(null);
  }
  if (!model || model.applied || model.metricId !== dismissedSuggestionMetricId) {
    // Llego otra sugerencia (o se aplico): lo descartado con la X deja de contar.
    setDismissedSuggestionMetricId('');
  }
  updateSuggestionStatusBar(suggestionStatusBar, model, enabled);
  quizView.updateHistory(toQuizHistoryItems(latestSuggestionHistory));
  suggestionCodeLensProvider.update(model);
  suggestionCodeActionProvider.update(model);
  const widgetModel = resolveActiveSuggestionSettings().selectionWidget && enabled
    ? toSelectionWidgetModel(model)
    : null;
  selectionWidget.show(widgetModel);
  // Con el widget a la vista, el inlay hint y la decoracion de fin de linea
  // repetirian lo mismo a dos centimetros: se apagan mientras dure.
  refreshInlineSuggestionSurfaces();
  maybeOpenSelectionInlinePanel(model);
  refreshFileView();
  if (model && !model.loading && !model.pendingMode && !model.applied) {
    void rememberSuggestionHistory(extensionContext.workspaceState, model)
      .then((history) => {
        setLatestSuggestionHistory(history);
        quizView.updateHistory(toQuizHistoryItems(latestSuggestionHistory));
      })
      .catch((error) => {
        output.appendLine(`[Suggestions] No se pudo guardar historial: ${String(error)}`);
      });
  }
};

export const recordSuggestionMetric = (
  model: ActiveSuggestionModel | null,
  eventType: string,
  value = "",
  extra: Record<string, unknown> = {},
  once = false,
  fields: SuggestionMetricFields = {},
) => {
  if (!model || model.loading) {
    return;
  }
  const key = `${eventType}:${model.metricId}:${value || model.applyMode}`;
  if (once && recordedSuggestionMetricKeys.has(key)) {
    return;
  }
  if (once) {
    recordedSuggestionMetricKeys.add(key);
  }
  recordVscodeSuggestionMetric(telemetry, model, eventType, value, extra, fields);
};

export function registerSelectionWidgetVisibility(context: vscode.ExtensionContext) {
  // La ventana flotante se abrio o se cerro: el CodeLens y la pista no repiten «Aceptar ayuda».
  context.subscriptions.push(selectionWidget.onDidChangeVisibility(() => {
    suggestionCodeLensProvider.refresh();
    refreshInlineSuggestionSurfaces();
  }));
}
