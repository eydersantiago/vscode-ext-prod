// ADACEEN (VS Code): punto de entrada: activate() registra comandos, vistas, proveedores y temporizadores; deactivate().
// Las funciones auxiliares se movieron sin cambios a modulos de src/ (settings, workspace-scan, backend-http,
// git-repo, editor-snapshot, active-suggestion, suggestion-*, code-actions, status-bar...).
import * as vscode from 'vscode';
import { buildBackendActiveSuggestionModel, buildLocalActiveSuggestion, fetchBackendSuggestionText, isSuggestionApplyOffered, primarySuggestionText } from './active-suggestion';
import { buildSessionHeaders, claimNextScanRequest, classifyScannedDocuments, sendScanFailure, sendScanResult } from './backend-http';
import { describeBackendUrlSource, detectEditorHost } from './backend-url';
import { currentClientId, initClientIdentity } from './client-identity';
import { createCodeApplicationGuardDeps, processNextCodeActionForRepo } from './code-actions';
import { guardCodeApplication, isExplicitClickOrigin } from './code-application-guard';
import { setEditorConnection } from './connection-state';
import { ACTIVE_SUGGESTION_ACTION_IDLE_MS, ACTIVE_SUGGESTION_CURSOR_IDLE_MS, ACTIVE_SUGGESTION_FALLBACK_DELAY_MS, ACTIVE_SUGGESTION_INDEX_TTL_MS, ACTIVE_SUGGESTION_POST_APPLY_GRACE_MS, ACTIVE_SUGGESTION_SELECTION_ACTION_IDLE_MS, ACTIVE_SUGGESTION_SELECTION_IDLE_MS, BLOCKING_TRIGGER_TTL_MS, WORKER_TICK_MS } from './constants';
import { EditorConnection } from './editor-connect';
import { buildActiveEditorSnapshot, collectDocumentDiagnostics, getCursorIdleAnchor, hasActiveSelection, isCursorIdleAnchorStillActive, isSnapshotStillActive, isSuggestionModelDocumentVisible, isSupportedActiveDocument } from './editor-snapshot';
import { ERROR_TEXT_MAX_CHARS, ErrorSignalTracker } from './error-signals';
import type { BlockingSignal, ErrorSignal } from './error-signals';
import { detectBranchName, detectRepoFullName, parseRepoFromGitConfig, readGitConfigText } from './git-repo';
import { AdaceenQuizViewProvider } from './quiz-view';
import { AdaceenSelectionWidget, SELECTION_WIDGET_ORIGIN } from './selection-widget';
import { asRecord, backendUrlSetByWorkspace, getEnv, isCodespaceRuntime, refreshLocalBackendDetection, resolveActiveSuggestionSettings, resolveBackendSettings, resolveCurrentBackendBaseUrl, resolveScanOptions, resolveTriggerSettings, toOptionalString } from './settings';
import { UNKNOWN_BACKEND_ORIGIN, fetchBackendOrigin, updateBackendOriginStatusBar } from './status-bar';
import { applySuggestionDecoration, clearSuggestionDecorations, updateSuggestionStatusBar } from './suggestion-decorations';
import { buildAppliedSuggestionModel, planSuggestionEdit, resolveWorkspaceFileUri } from './suggestion-edit';
import { buildRagSourceMarkdown, buildRagSourceTargetUrl, getBackendSuggestionScopeLabel } from './suggestion-format';
import { formatSuggestionHistoryMarkdown, readSuggestionHistory, rememberSuggestionHistory, toSelectionWidgetModel, writeSuggestionHistory } from './suggestion-history';
import { editorPageContext, publishActiveEditorRack, recordVscodeSuggestionMetric, toQuizHistoryItems } from './suggestion-metrics';
import type { SuggestionMetricFields } from './suggestion-metrics';
import { AdaceenSuggestionCodeActionProvider, AdaceenSuggestionCodeLensProvider, AdaceenSuggestionInlayHintProvider, isSuggestionCodeActionRequestFocused } from './suggestion-providers';
import { createEmptyBackendSuggestionResult, delay, formatBackendSuggestionError, inferActiveLanguage, normalizeCourseCode, normalizeRagSources, settleBackendSuggestionResult, truncateInline, withActiveSuggestionDeadline } from './suggestion-results';
import { inlineSurfaceModel, selectionWidgetPresence as selectionWidgetPresenceFor } from './suggestion-surfaces';
import type { SelectionWidgetPresence } from './suggestion-surfaces';
import { SuggestionExposureTracker, TelemetryClient } from './telemetry';
import type { TelemetryEventInput } from './telemetry';
import type { ActiveEditorSnapshot, ActiveSuggestionModel, ActiveSuggestionSettings, BackendSuggestionInFlight, BackendSuggestionRequestContext, BackendSuggestionRequestScope, BackendSuggestionResult, BackendSuggestionScope, CursorIdleAnchor, ScanCommandArgs, ScanPayload, SuggestionApplyMode, SuggestionTrigger, WorkspaceProjectIndex } from './types';
import { buildWorkspaceProjectIndexForSuggestions, getWorkspaceProjectIndexIdentity, stableStringHash } from './workspace-index';
import { askScanPermission, performWorkspaceScan, renderScanOutput } from './workspace-scan';

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('ADACEEN');
  const safeLog = (line: string) => {
    try {
      output.appendLine(line);
    } catch {
      // Canal ya cerrado (desactivacion): se descarta la linea.
    }
  };
  // Identidad unica para TODAS las llamadas al backend (x-adaceen-client-id);
  // es el mismo id persistente que usaba la vista de quiz.
  initClientIdentity(context.globalState);
  // Donde corre el editor (VS Code instalado, tunel, Codespaces), en cada evento.
  const editorMetadata = {
    editorHost: detectEditorHost({ remoteName: vscode.env.remoteName, codespace: isCodespaceRuntime() }),
    editorUi: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
  };
  // Sesion de ADACEEN: SecretStorage, archivo del tunel o ajuste heredado (src/editor-connect.ts).
  const connection = new EditorConnection({
    context,
    log: safeLog,
    backendUrl: () => resolveCurrentBackendBaseUrl().baseUrl,
    // Para el canje: vscode.dev sin tunel es "web".
    editorHost: () => (editorMetadata.editorHost === 'local' && editorMetadata.editorUi === 'web' ? 'web' : editorMetadata.editorHost),
    detectWorkspaceRepo: (folders) => detectRepoFullName(folders),
    readRepoOfFolder: async (uri) => {
      const text = await readGitConfigText({ uri, name: '', index: 0 });
      return text ? parseRepoFromGitConfig(text) : undefined;
    },
    getEnv,
    // Un repo clonado por enlace puede traer su propio adaceen.backend.baseUrl:
    // a ese backend no se le manda en silencio el token de GitHub de VS Code.
    silentGithubAllowed: () => !backendUrlSetByWorkspace(),
  });
  setEditorConnection(connection);
  context.subscriptions.push(connection);
  // Antes de la primera llamada: backend local si esta corriendo, si no produccion
  // (sin nada escuchando en el 3000 la prueba termina al instante, maximo 800 ms),
  // y despues la sesion guardada (SecretStorage y ~/.adaceen/editor-session.json):
  // la emparejada solo vale en su backend, asi que primero hay que saber cual es.
  await refreshLocalBackendDetection();
  await connection.initialize();
  const reportInvalidSession = (sessionId: string) => connection.sessions.reportInvalid(sessionId);
  const telemetry = new TelemetryClient({
    getEndpoint: () => {
      const settings = resolveBackendSettings();
      return { baseUrl: settings.baseUrl, sessionId: settings.sessionId, clientId: currentClientId() };
    },
    baseMetadata: () => editorMetadata,
    log: safeLog,
    onSessionInvalid: reportInvalidSession,
  });
  const codeApplicationGuardDeps = createCodeApplicationGuardDeps(telemetry, output);
  context.subscriptions.push({ dispose: () => telemetry.dispose() });
  const startupSettings = resolveBackendSettings();
  output.appendLine(
    `[Worker] Inicializado | auto=${startupSettings.autoWorkerEnabled} | backend=${startupSettings.baseUrl} | pollMs=${startupSettings.workerPollMs} | workerId=${startupSettings.workerId}`,
  );
  output.appendLine(
    `[Backend] ${startupSettings.baseUrl} (${describeBackendUrlSource(startupSettings.baseUrlSource)}) | editor=${editorMetadata.editorHost}/${editorMetadata.editorUi}`,
  );
  output.appendLine(`[Identidad] clientId=${currentClientId()} | clientSessionId=${telemetry.clientSessionId}`);

  let latestSuggestionHistory = readSuggestionHistory(context.workspaceState);
  // Vista movible "Quiz y seguimiento" (reemplaza el panel de sugerencias):
  // quiz tras aceptar una sugerencia o lanzado por el docente, e historial.
  const quizView = new AdaceenQuizViewProvider({
    memento: context.globalState,
    output,
    getRequestContext: () => {
      const settings = resolveBackendSettings();
      return settings.baseUrl ? { baseUrl: settings.baseUrl, headers: buildSessionHeaders(settings, false) } : null;
    },
    openHistoryEntry: (id) => {
      void vscode.commands.executeCommand('adaceen.openSuggestionHistoryEntry', id);
    },
    openAllHistory: () => {
      void vscode.commands.executeCommand('adaceen.openSuggestionHistory');
    },
    onSessionInvalid: reportInvalidSession,
  });
  quizView.updateHistory(toQuizHistoryItems(latestSuggestionHistory));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AdaceenQuizViewProvider.viewType, quizView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('adaceen.quiz.checkPending', () => quizView.checkPending(true)),
  );
  // Ventana flotante anclada a la seleccion: una sola sugerencia, en un solo sitio.
  const selectionWidget = new AdaceenSelectionWidget();
  // Con comments.visible=false el hilo existe pero no se ve: no cuenta como abierta.
  const selectionWidgetPresence = (): SelectionWidgetPresence => selectionWidgetPresenceFor({
    hasThread: selectionWidget.visible,
    uriString: selectionWidget.uriString,
    commentsVisible: vscode.workspace.getConfiguration('comments').get<boolean>('visible', true) !== false,
  });
  // Sugerencia que el estudiante descarto con la X de la ventana flotante: no se vuelve a
  // ofrecer en el CodeLens ni en la pista hasta que llegue otra.
  let dismissedSuggestionMetricId = '';
  const suggestionCodeLensProvider = new AdaceenSuggestionCodeLensProvider(
    selectionWidgetPresence,
    () => dismissedSuggestionMetricId,
  );
  // Cuando ADACEEN abre solo el menu de arreglos rapidos (maybeOpenSelectionInlinePanel).
  let quickFixAutoOpenedAt = 0;
  const suggestionCodeActionProvider = new AdaceenSuggestionCodeActionProvider(() => quickFixAutoOpenedAt);
  const suggestionInlayHintProvider = new AdaceenSuggestionInlayHintProvider();
  const suggestionStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  suggestionStatusBar.command = 'adaceen.openAssistant';
  updateSuggestionStatusBar(suggestionStatusBar, null, resolveActiveSuggestionSettings().enabled);

  // Indicador de origen de la GPU: PC, Mac, Google Cloud o Colab.
  const backendOriginStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99,
  );
  backendOriginStatusBar.command = 'adaceen.refreshBackendOrigin';
  updateBackendOriginStatusBar(
    backendOriginStatusBar,
    UNKNOWN_BACKEND_ORIGIN,
    resolveBackendSettings(),
  );
  let backendOriginTimer: ReturnType<typeof setInterval> | null = null;

  const refreshBackendOrigin = async (announce = false) => {
    // Si se enciende o se apaga el backend local (npm run dev:local), se cambia solo.
    if (await refreshLocalBackendDetection()) {
      const switched = resolveBackendSettings();
      safeLog(`[Backend] Cambia a ${switched.baseUrl} (${describeBackendUrlSource(switched.baseUrlSource)})`);
      // La sesion emparejada solo vale en su backend: la barra y la cache se actualizan.
      connection.sessions.refresh();
    }
    const settings = resolveBackendSettings();
    const origin = await fetchBackendOrigin(settings);
    updateBackendOriginStatusBar(backendOriginStatusBar, origin, settings);
    if (announce) {
      const message = !origin.reachable
        ? `ADACEEN: no se pudo consultar el backend. ${origin.detail}`
        : origin.noWorker
          ? `ADACEEN: GPU sin worker activo. ${origin.detail}`
          : `ADACEEN: la inferencia sale de ${origin.label}${origin.id ? ` (${origin.id})` : ''}.`;
      if (origin.reachable && !origin.noWorker) {
        void vscode.window.showInformationMessage(message);
      } else {
        void vscode.window.showWarningMessage(message);
      }
    }
    return origin;
  };

  context.subscriptions.push(
    backendOriginStatusBar,
    vscode.commands.registerCommand('adaceen.refreshBackendOrigin', () =>
      refreshBackendOrigin(true),
    ),
    new vscode.Disposable(() => {
      if (backendOriginTimer) {
        clearInterval(backendOriginTimer);
        backendOriginTimer = null;
      }
    }),
  );

  void refreshBackendOrigin();
  backendOriginTimer = setInterval(() => {
    void refreshBackendOrigin();
  }, 30000);

  // Barra «ADACEEN: sin conectar / <nombre>», «ADACEEN: Conectar», enlaces
  // vscode://adaceen.adaceen/... y, sin sesion, GitHub de VS Code en silencio.
  // Un fallo aqui no debe dejar sin sugerencias ni telemetria.
  try {
    connection.start();
  } catch (error) {
    safeLog(`[Sesion] No se pudo iniciar la conexion con la cuenta: ${String(error)}`);
  }
  const suggestionDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'normal',
      margin: '0 0 0 1rem',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const backendSuggestionCache: Record<BackendSuggestionRequestScope, Map<string, BackendSuggestionResult>> = {
    cursor: new Map(),
    file_summary: new Map(),
  };
  const backendSuggestionInFlight = new Map<string, BackendSuggestionInFlight>();
  let activeSuggestionModel: ActiveSuggestionModel | null = null;
  let suggestionTimer: ReturnType<typeof setTimeout> | null = null;
  let cursorIdleSuggestionTimer: ReturnType<typeof setTimeout> | null = null;
  let cursorActionTimer: ReturnType<typeof setTimeout> | null = null;
  const recordedSuggestionMetricKeys = new Set<string>();
  let suppressSuggestionRefreshUntil = 0;
  let suppressSuggestionRefreshUri = '';
  let autoRevealedSuggestionUri = '';
  let autoOpenedSelectionActionKey = '';
  let selectionInlinePanelTimer: ReturnType<typeof setTimeout> | null = null;
  let rackSyncErrorNotified = false;
  let workspaceProjectIndexCache: {
    identity: string;
    expiresAt: number;
    value: WorkspaceProjectIndex | null;
  } | null = null;
  let workspaceProjectIndexInFlight: Promise<WorkspaceProjectIndex | null> | null = null;
  // Cuanto estuvo a la vista cada sugerencia, para vscode_suggestion_ignored.
  const suggestionExposure = new SuggestionExposureTracker<ActiveSuggestionModel>();
  // Origen real de las peticiones (trigger): archivo recien abierto y bloqueo pendiente.
  let lastActiveDocumentUri = vscode.window.activeTextEditor?.document.uri.toString() || '';
  let pendingFileOpenUri = lastActiveDocumentUri;
  let pendingBlocking: { uriString: string; key: string; text: string; detectedAt: number } | null = null;
  let applyInProgress = false;
  let lastKnownRepoFullName = '';

  const recordIgnoredSuggestion = (model: ActiveSuggestionModel, durationMs: number, reason: 'replaced' | 'dismissed' | 'closed') => {
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
    autoOpenedSelectionActionKey = key;

    if (selectionInlinePanelTimer) {
      clearTimeout(selectionInlinePanelTimer);
    }
    selectionInlinePanelTimer = setTimeout(() => {
      selectionInlinePanelTimer = null;
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
            quickFixAutoOpenedAt = Date.now();
            void vscode.commands.executeCommand('editor.action.quickFix');
          }, 220);
        }
      }
    }, model.loading ? 160 : 80);
  };

  /**
   * Pista en linea y decoracion de fin de linea de la sugerencia activa. Con la
   * ventana flotante abierta en ese archivo se apagan (ella ofrece la accion);
   * vuelven al cerrarla (suggestion-surfaces.ts).
   */
  const refreshInlineSuggestionSurfaces = () => {
    const model = inlineSurfaceModel(activeSuggestionModel, selectionWidgetPresence(), dismissedSuggestionMetricId);
    suggestionInlayHintProvider.update(model);
    applySuggestionDecoration(suggestionDecorationType, model);
  };
  // La ventana flotante se abrio o se cerro: el CodeLens y la pista no repiten «Aceptar ayuda».
  context.subscriptions.push(selectionWidget.onDidChangeVisibility(() => {
    suggestionCodeLensProvider.refresh();
    refreshInlineSuggestionSurfaces();
  }));

  const publishSuggestionModel = (model: ActiveSuggestionModel | null, enabled = true) => {
    // Una sugerencia mostrada que se reemplaza por otra o desaparece sin
    // aplicarse cuenta como ignorada (con el tiempo que estuvo a la vista).
    const ignored = suggestionExposure.onPublish(
      model ? { id: model.metricId, loading: !!model.loading, applied: !!model.applied } : null,
      Date.now(),
    );
    if (ignored) {
      recordIgnoredSuggestion(ignored.item, ignored.durationMs, model ? 'replaced' : 'dismissed');
    }
    activeSuggestionModel = model;
    if (!model || model.applied || model.metricId !== dismissedSuggestionMetricId) {
      // Llego otra sugerencia (o se aplico): lo descartado con la X deja de contar.
      dismissedSuggestionMetricId = '';
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
    if (model && !model.loading && !model.applied) {
      void rememberSuggestionHistory(context.workspaceState, model)
        .then((history) => {
          latestSuggestionHistory = history;
          quizView.updateHistory(toQuizHistoryItems(latestSuggestionHistory));
        })
        .catch((error) => {
          output.appendLine(`[Suggestions] No se pudo guardar historial: ${String(error)}`);
        });
    }
  };

  const recordSuggestionMetric = (
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

  const clearWorkspaceProjectIndexCache = () => {
    workspaceProjectIndexCache = null;
    workspaceProjectIndexInFlight = null;
  };

  const clearBackendSuggestionCaches = () => {
    backendSuggestionCache.cursor.clear();
    backendSuggestionCache.file_summary.clear();
    backendSuggestionInFlight.clear();
  };

  const buildBackendSuggestionTextCacheKey = (
    snapshot: ActiveEditorSnapshot,
    projectIndex: WorkspaceProjectIndex | null,
    scope: BackendSuggestionRequestScope,
    trigger: SuggestionTrigger,
  ) => {
    const projectKey = projectIndex?.cacheKey || 'sin-mapa';
    const backend = resolveBackendSettings();
    const activeRagCourse = normalizeCourseCode(resolveActiveSuggestionSettings().ragCourseCode);
    const sessionKey = stableStringHash(`${backend.sessionId || 'sin-sesion'}:${activeRagCourse || 'curso-backend'}`);
    if (scope === 'file_summary') {
      return `${sessionKey}:${snapshot.fileSummaryCacheKey}:${projectKey}`;
    }
    // Un bloqueo siempre llega al backend (su pregunta y su politica son otras).
    const triggerKey = trigger === 'blocking' ? ':blocking' : '';
    return `${sessionKey}:${snapshot.cacheKey}:${projectKey}${triggerKey}`;
  };

  const getBackendSuggestionText = async (
    settings: ActiveSuggestionSettings,
    snapshot: ActiveEditorSnapshot,
    projectIndex: WorkspaceProjectIndex | null,
    scope: BackendSuggestionRequestScope,
    requestContext: BackendSuggestionRequestContext,
  ): Promise<BackendSuggestionResult> => {
    const cacheKey = buildBackendSuggestionTextCacheKey(snapshot, projectIndex, scope, requestContext.trigger);
    const cached = backendSuggestionCache[scope].get(cacheKey);
    if (cached) {
      // Sale de la cache local: no hubo viaje al backend, asi que no hay latencia que medir.
      return { ...cached, latencyMs: null };
    }

    const inFlightKey = `${scope}:${cacheKey}`;
    let inFlight = backendSuggestionInFlight.get(inFlightKey);
    if (!inFlight) {
      const request = fetchBackendSuggestionText(settings, snapshot, projectIndex, scope, requestContext);
      inFlight = { key: cacheKey, request };
      backendSuggestionInFlight.set(inFlightKey, inFlight);
      request.then(
        () => backendSuggestionInFlight.delete(inFlightKey),
        () => backendSuggestionInFlight.delete(inFlightKey),
      );
    }

    const result = await inFlight.request;
    if (result.outputText) {
      backendSuggestionCache[scope].set(cacheKey, result);
    }
    return result;
  };

  const getWorkspaceProjectIndex = async () => {
    const identity = getWorkspaceProjectIndexIdentity();
    if (!identity) {
      return null;
    }

    const now = Date.now();
    if (
      workspaceProjectIndexCache &&
      workspaceProjectIndexCache.identity === identity &&
      workspaceProjectIndexCache.expiresAt > now
    ) {
      return workspaceProjectIndexCache.value;
    }

    if (!workspaceProjectIndexInFlight) {
      workspaceProjectIndexInFlight = buildWorkspaceProjectIndexForSuggestions(output)
        .catch((error) => {
          output.appendLine(`[Suggestions] No se pudo construir el mapa local del proyecto: ${String(error)}`);
          return null;
        });
    }

    try {
      const value = await workspaceProjectIndexInFlight;
      workspaceProjectIndexCache = {
        identity,
        expiresAt: Date.now() + ACTIVE_SUGGESTION_INDEX_TTL_MS,
        value,
      };
      return value;
    } finally {
      workspaceProjectIndexInFlight = null;
    }
  };

  const resolveBackendScopeForSnapshot = (
    reason: string,
    snapshot: ActiveEditorSnapshot,
    trigger?: SuggestionTrigger,
  ): BackendSuggestionScope => {
    if (hasActiveSelection(snapshot)) {
      return 'cursor';
    }
    return reason === 'cursor-idle' || trigger === 'blocking' ? 'cursor' : 'file';
  };

  /** Hay un bloqueo detectado en este archivo que todavia no recibio su sugerencia. */
  const hasPendingBlocking = (uriString: string) => {
    if (!pendingBlocking) {
      return false;
    }
    if (Date.now() - pendingBlocking.detectedAt >= BLOCKING_TRIGGER_TTL_MS || !resolveTriggerSettings().suggestOnBlocking) {
      pendingBlocking = null;
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
        rackSyncErrorNotified = false;
      })
      .catch((error) => {
        if (!rackSyncErrorNotified) {
          rackSyncErrorNotified = true;
          output.appendLine(`[Sync] No se pudo publicar el archivo activo hacia el navegador (${reason}): ${String(error)}`);
        }
      });
  };

  const refreshActiveSuggestion = async (reason = 'auto') => {
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
      lastKnownRepoFullName = snapshot.repoFullName;
    }
    const trigger = resolveSuggestionTrigger(reason, snapshot);
    if (pendingFileOpenUri === snapshot.uriString) {
      // "file_open" solo describe la primera peticion tras abrir el archivo.
      pendingFileOpenUri = '';
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
    publishActiveRackSnapshot(snapshot, model, null, `${reason}:local`);
    if (settings.autoRevealPanel && backendScope === 'file' && autoRevealedSuggestionUri !== snapshot.uriString) {
      void quizView.reveal(true);
      autoRevealedSuggestionUri = snapshot.uriString;
    }

    let projectIndex: WorkspaceProjectIndex | null = null;
    if (settings.useBackend) {
      projectIndex = await getWorkspaceProjectIndex();
      if (!isSnapshotStillActive(snapshot, backendScope)) {
        return activeSuggestionModel;
      }
      model = {
        ...buildLocalActiveSuggestion(snapshot, projectIndex),
        triggerKind: backendScope === 'cursor' ? 'cursor' : 'file',
        actionsVisible: false,
        loading: true,
        trigger,
      };
      publishSuggestionModel(model, true);
      publishActiveRackSnapshot(snapshot, model, projectIndex, `${reason}:indexed-local`);
    }

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
          throw new Error('Backend no devolvio sugerencias aplicables.');
        }
      } catch (error) {
        const backendErrorMessage = formatBackendSuggestionError(error);
        const remainingMs = fallbackDelayMs - (Date.now() - backendStartedAt);
        if (remainingMs > 0) {
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
        };
        output.appendLine(
          `[Suggestions] Backend no disponible (${reason}, ${getBackendSuggestionScopeLabel(backendScope)}): ${backendErrorMessage}`,
        );
      }
    }

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
      pendingBlocking = null;
    }
    publishActiveRackSnapshot(snapshot, finalModel, projectIndex, `${reason}:final`);
    if (backendScope === 'file' && settings.autoRevealPanel && autoRevealedSuggestionUri !== finalModel.uriString) {
      void quizView.reveal(true);
      autoRevealedSuggestionUri = finalModel.uriString;
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
    suggestionTimer = setTimeout(() => {
      suggestionTimer = null;
      void refreshActiveSuggestion(reason);
    }, settings.debounceMs);
  };

  const clearCursorSuggestionTimers = () => {
    if (cursorIdleSuggestionTimer) {
      clearTimeout(cursorIdleSuggestionTimer);
      cursorIdleSuggestionTimer = null;
    }
    if (cursorActionTimer) {
      clearTimeout(cursorActionTimer);
      cursorActionTimer = null;
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
      // Respuesta bloqueada o sin permiso para aplicar: no hay acciones que revelar.
      return;
    }

    const visibleModel = { ...model, actionsVisible: true, triggerKind: 'cursor' as const };
    publishSuggestionModel(visibleModel, true);
    recordSuggestionMetric(visibleModel, 'vscode_suggestion_actions_revealed', visibleModel.applyMode, {
      idleMs,
    }, true);
  };

  const suppressAutoRefreshForActiveApply = (uriString: string) => {
    suppressSuggestionRefreshUri = uriString;
    suppressSuggestionRefreshUntil = Date.now() + ACTIVE_SUGGESTION_POST_APPLY_GRACE_MS;
  };

  const isAutoRefreshSuppressed = () => {
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

  const scheduleCursorIdleSuggestionRefresh = () => {
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

    cursorIdleSuggestionTimer = setTimeout(() => {
      cursorIdleSuggestionTimer = null;
      if (!isCursorIdleAnchorStillActive(anchor)) {
        return;
      }
      void refreshActiveSuggestion('cursor-idle');
    }, suggestionIdleMs);

    cursorActionTimer = setTimeout(() => {
      cursorActionTimer = null;
      void revealSuggestionActions(anchor, actionIdleMs);
    }, actionIdleMs);
  };

  const resolveEditorForSuggestion = async (model: ActiveSuggestionModel) => {
    const active = vscode.window.activeTextEditor;
    if (active && active.document.uri.toString() === model.uriString) {
      return active;
    }
    // Pulsado desde el panel: el editor sigue abierto a un lado; se le
    // devuelve el foco (conserva su seleccion) y se aplica ahi.
    const visible = vscode.window.visibleTextEditors.find((item) => item.document.uri.toString() === model.uriString);
    if (visible) {
      return vscode.window.showTextDocument(visible.document, { viewColumn: visible.viewColumn, preserveFocus: false });
    }
    try {
      return await vscode.window.showTextDocument(vscode.Uri.parse(model.uriString), { preview: false });
    } catch {
      return undefined;
    }
  };

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

    const mode = modeOverride || model.applyMode || 'insert';
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
      suppressSuggestionRefreshUntil = 0;
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

  const applySuggestionCompletion = async (modeOverride?: SuggestionApplyMode, origin = 'command') => {
    if (applyInProgress) {
      // Doble clic mientras se consulta apply-check o se espera la confirmacion.
      return;
    }
    applyInProgress = true;
    try {
      await applySuggestionCompletionNow(modeOverride, origin);
    } finally {
      applyInProgress = false;
    }
  };

  // Botones de la ventana flotante. Reciben el hilo de comentarios como
  // argumento (lo pone VS Code), que aqui no hace falta: la accion siempre
  // va sobre la sugerencia activa.
  const selectionWidgetDisposables = [
    selectionWidget,
    vscode.commands.registerCommand('adaceen.selectionWidget.insert', () => applySuggestionCompletion('insert', SELECTION_WIDGET_ORIGIN)),
    vscode.commands.registerCommand('adaceen.selectionWidget.replace', () => applySuggestionCompletion('replace', SELECTION_WIDGET_ORIGIN)),
    vscode.commands.registerCommand('adaceen.selectionWidget.delete', () => applySuggestionCompletion('delete', SELECTION_WIDGET_ORIGIN)),
    vscode.commands.registerCommand('adaceen.selectionWidget.close', () => {
      // Cerrar la ventana sin aplicar cuenta como sugerencia descartada.
      const model = activeSuggestionModel;
      const dismissed = model ? suggestionExposure.dismiss(model.metricId, Date.now()) : null;
      if (dismissed) {
        recordIgnoredSuggestion(dismissed.item, dismissed.durationMs, 'closed');
      }
      // Descartada: al cerrarse la ventana, el CodeLens y la pista no la vuelven a ofrecer.
      dismissedSuggestionMetricId = model?.metricId || '';
      selectionWidget.hide();
    }),
  ];
  context.subscriptions.push(...selectionWidgetDisposables);

  const openAssistantDisposable = vscode.commands.registerCommand('adaceen.openAssistant', async () => {
    const model = activeSuggestionModel || await refreshActiveSuggestion('open-panel');
    void quizView.reveal(false);
    if (!model) {
      return;
    }
    recordSuggestionMetric(model, 'vscode_suggestion_panel_opened', model.applyMode);
  });

  const refreshSuggestionsDisposable = vscode.commands.registerCommand('adaceen.refreshSuggestions', async () => {
    const model = await refreshActiveSuggestion('manual-refresh');
    if (model) {
      void quizView.reveal(false);
      recordSuggestionMetric(model, 'vscode_suggestion_manual_refresh', model.applyMode);
    }
  });

  const openSuggestionHistoryDisposable = vscode.commands.registerCommand('adaceen.openSuggestionHistory', async () => {
    latestSuggestionHistory = readSuggestionHistory(context.workspaceState);
    quizView.updateHistory(toQuizHistoryItems(latestSuggestionHistory));
    if (latestSuggestionHistory.length === 0) {
      vscode.window.showInformationMessage('ADACEEN: aun no hay recomendaciones guardadas en el historial.');
      return;
    }

    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: formatSuggestionHistoryMarkdown(latestSuggestionHistory),
    });
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  });

  const clearSuggestionHistoryDisposable = vscode.commands.registerCommand('adaceen.clearSuggestionHistory', async () => {
    const answer = await vscode.window.showWarningMessage(
      'ADACEEN: se borrara el historial de recomendaciones guardado para este workspace.',
      'Limpiar historial',
    );
    if (answer !== 'Limpiar historial') {
      return;
    }

    latestSuggestionHistory = [];
    await writeSuggestionHistory(context.workspaceState, latestSuggestionHistory);
    quizView.updateHistory(toQuizHistoryItems(latestSuggestionHistory));
    vscode.window.showInformationMessage('ADACEEN: historial de recomendaciones limpiado.');
  });

  const openSuggestionHistoryEntryDisposable = vscode.commands.registerCommand(
    'adaceen.openSuggestionHistoryEntry',
    async (entryId?: string) => {
      latestSuggestionHistory = readSuggestionHistory(context.workspaceState);
      const entry = latestSuggestionHistory.find((item) => item.id === entryId);
      if (!entry) {
        vscode.window.showInformationMessage('ADACEEN: esa recomendacion ya no esta en el historial.');
        return;
      }

      const uri = await resolveWorkspaceFileUri(entry.filePath);
      if (!uri) {
        vscode.window.showWarningMessage(`ADACEEN: no se encontro ${entry.filePath} en el workspace abierto.`);
        return;
      }

      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
      const startLineNumber = entry.selectionStartLine || entry.line || 1;
      const endLineNumber = entry.selectionEndLine || startLineNumber;
      const startLine = Math.max(0, Math.min(document.lineCount - 1, startLineNumber - 1));
      const endLine = Math.max(startLine, Math.min(document.lineCount - 1, endLineNumber - 1));
      const range = new vscode.Range(new vscode.Position(startLine, 0), document.lineAt(endLine).range.end);
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    },
  );

  const applySuggestionCompletionDisposable = vscode.commands.registerCommand(
    'adaceen.applySuggestionCompletion',
    async (mode?: string, origin?: unknown) => {
      const normalizedMode: SuggestionApplyMode | undefined =
        mode === 'insert' || mode === 'replace' || mode === 'delete' ? mode : undefined;
      // origin lo ponen la ventana flotante, el CodeLens, el quick fix...: va a las metricas y
      // decide si el clic cuenta como confirmacion (isExplicitClickOrigin). Sin origin, la paleta.
      const normalizedOrigin = typeof origin === 'string' && /^[a-z_]{1,40}$/.test(origin) ? origin : 'command';
      await applySuggestionCompletion(normalizedMode, normalizedOrigin);
    },
  );

  const openRagSourceDisposable = vscode.commands.registerCommand('adaceen.openRagSource', async (sourceArg?: unknown) => {
    const sourceItem = normalizeRagSources([sourceArg])[0];
    if (!sourceItem) {
      vscode.window.showInformationMessage('ADACEEN: esta sugerencia no trae una fuente RAG abrible.');
      return;
    }

    const targetUrl = buildRagSourceTargetUrl(sourceItem);
    if (targetUrl) {
      await vscode.env.openExternal(vscode.Uri.parse(targetUrl));
      recordSuggestionMetric(activeSuggestionModel, 'vscode_rag_source_opened', sourceItem.citationLabel || sourceItem.title, {
        sourceId: sourceItem.sourceId,
        chunkId: sourceItem.chunkId,
        title: sourceItem.title,
        citationLabel: sourceItem.citationLabel,
        pageStart: sourceItem.pageStart,
        pageEnd: sourceItem.pageEnd,
        courseCode: sourceItem.courseCode,
        url: targetUrl,
      });
      return;
    }

    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: buildRagSourceMarkdown(sourceItem),
    });
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    recordSuggestionMetric(activeSuggestionModel, 'vscode_rag_source_opened', sourceItem.citationLabel || sourceItem.title, {
      sourceId: sourceItem.sourceId,
      chunkId: sourceItem.chunkId,
      title: sourceItem.title,
      citationLabel: sourceItem.citationLabel,
      pageStart: sourceItem.pageStart,
      pageEnd: sourceItem.pageEnd,
      courseCode: sourceItem.courseCode,
      openedAsMarkdown: true,
    });
  });

  // Compatibilidad: lo mismo que «ADACEEN: Conectar» → «Tengo un codigo o sesion»; acepta un
  // codigo XXXX-XXXX (lo canjea) o el UUID de antes. Sigue en la paleta: el navegador lo cita.
  // La sesion va a SecretStorage (no a settings), por encima del ajuste heredado.
  const setBackendSessionIdDisposable = vscode.commands.registerCommand('adaceen.setBackendSessionId', () =>
    connection.promptLegacySession(),
  );
  // Con otra sesion cambian la cache de sugerencias y lo que se sincroniza con el navegador.
  connection.onDidChangeSession((_session, idChanged) => {
    if (idChanged) {
      scheduleCursorIdleSuggestionRefresh();
    }
  });

  const applyNextCodeActionDisposable = vscode.commands.registerCommand('adaceen.applyNextCodeAction', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) {
      vscode.window.showWarningMessage('ADACEEN: abre una carpeta o workspace antes de aplicar reemplazos.');
      return;
    }

    const repoFullName = await detectRepoFullName(workspaceFolders);
    if (!repoFullName) {
      vscode.window.showWarningMessage('ADACEEN: no pude detectar el repositorio GitHub owner/repo del workspace.');
      return;
    }

    await processNextCodeActionForRepo(resolveBackendSettings(), repoFullName, output, codeApplicationGuardDeps, true);
  });

  const scanWorkspaceDisposable = vscode.commands.registerCommand(
    'adaceen.scanWorkspace',
    async (args?: ScanCommandArgs) => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) {
        vscode.window.showWarningMessage('ADACEEN: abre una carpeta o workspace antes de escanear.');
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'ADACEEN está leyendo el workspace...',
          cancellable: false,
        },
        async () => {
          const scan = await performWorkspaceScan(args, output);
          renderScanOutput(output, scan);
          output.show(true);
          vscode.window.showInformationMessage(
            `ADACEEN leyó ${scan.payload.totalFiles} archivos (${scan.selection.mode}). Revisa Output.`,
          );
        },
      );
    },
  );

  // --- Senales de error y bloqueo (A6.2): activacion por eventos definidos ---
  const errorSignalSettingsFromConfig = () => ({ blockingMs: resolveTriggerSettings().blockingSeconds * 1000 });
  const errorSignalTracker = new ErrorSignalTracker(errorSignalSettingsFromConfig());
  const lastEditAtByUri = new Map<string, number>();
  let errorSignalTimer: ReturnType<typeof setTimeout> | null = null;

  const clearErrorSignalTimer = () => {
    if (errorSignalTimer) {
      clearTimeout(errorSignalTimer);
      errorSignalTimer = null;
    }
  };

  const rememberEdit = (uriString: string) => {
    lastEditAtByUri.delete(uriString);
    lastEditAtByUri.set(uriString, Date.now());
    while (lastEditAtByUri.size > 50) {
      lastEditAtByUri.delete(lastEditAtByUri.keys().next().value as string);
    }
  };

  const recordErrorSignal = (signal: ErrorSignal, document: vscode.TextDocument, errorCount: number) => {
    const filePath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
    const base: TelemetryEventInput = {
      source: 'vscode_extension',
      category: 'signal',
      eventType: signal.type,
      pageContext: editorPageContext(),
      repoFullName: lastKnownRepoFullName || undefined,
      branch: detectBranchName(),
      filePath,
      language: inferActiveLanguage(filePath, document.languageId),
      // El backend lo convierte en errorHash y no guarda el texto.
      errorText: signal.text.slice(0, ERROR_TEXT_MAX_CHARS),
    };
    if (signal.type === 'compile_error_detected') {
      telemetry.track({ ...base, metadata: { line: signal.line, errorCount } });
      return;
    }
    if (signal.type === 'blocking_resolved') {
      // Cierra el episodio de bloqueo: su duracion es el tiempo hasta desbloqueo (A3.3).
      telemetry.track({
        ...base,
        durationMs: signal.durationMs,
        metadata: {
          line: signal.line,
          blockedForMs: signal.blockedForMs,
          resolvedWhileAway: signal.resolvedWhileAway,
          errorCount,
        },
      });
      return;
    }
    telemetry.track({
      ...base,
      durationMs: signal.durationMs,
      count: signal.count,
      metadata: {
        line: signal.line,
        reason: signal.reason,
        blockingSeconds: resolveTriggerSettings().blockingSeconds,
        errorCount,
      },
    });
  };

  /** Pide una sugerencia con trigger "blocking" (si adaceen.triggers.suggestOnBlocking lo permite). */
  const requestBlockingSuggestion = (signal: BlockingSignal, document: vscode.TextDocument) => {
    if (!resolveTriggerSettings().suggestOnBlocking || !resolveActiveSuggestionSettings().enabled) {
      return;
    }
    // Las peticiones siguientes de este archivo salen con trigger "blocking" hasta que una responda.
    pendingBlocking = { uriString: document.uri.toString(), key: signal.key, text: signal.text, detectedAt: Date.now() };
    if (isAutoRefreshSuppressed()) {
      return;
    }
    if (cursorIdleSuggestionTimer) {
      clearTimeout(cursorIdleSuggestionTimer);
      cursorIdleSuggestionTimer = null;
    }
    void refreshActiveSuggestion('blocking');
  };

  /** Relee los errores del archivo activo y emite compile_error_detected / blocking_detected. */
  const evaluateErrorSignals = () => {
    clearErrorSignalTimer();
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSupportedActiveDocument(editor.document)) {
      return;
    }
    const document = editor.document;
    const uriString = document.uri.toString();
    const summary = collectDocumentDiagnostics(document.uri);
    const now = Date.now();
    const lastEditAt = lastEditAtByUri.get(uriString) ?? Number.NEGATIVE_INFINITY;
    const signals = errorSignalTracker.observe(uriString, summary.errors, now, lastEditAt);
    if (pendingBlocking?.uriString === uriString && !errorSignalTracker.isPresent(pendingBlocking.key)) {
      // El error que causo el bloqueo ya se corrigio.
      pendingBlocking = null;
    }
    let firstBlocking: BlockingSignal | null = null;
    for (const signal of signals) {
      recordErrorSignal(signal, document, summary.errors.length);
      if (signal.type === 'blocking_resolved') {
        output.appendLine(
          `[Signals] Desbloqueo en ${vscode.workspace.asRelativePath(document.uri, false)}:${signal.line} tras ${Math.round(signal.durationMs / 1000)} s${signal.resolvedWhileAway ? ' (corregido desde otro archivo)' : ''}.`,
        );
        continue;
      }
      if (signal.type === 'blocking_detected') {
        output.appendLine(
          `[Signals] Bloqueo en ${vscode.workspace.asRelativePath(document.uri, false)}:${signal.line} (${signal.reason === 'persistent' ? `${Math.round(signal.durationMs / 1000)} s con el mismo error` : `${signal.count} apariciones en 10 min`}): ${truncateInline(signal.text, 140)}`,
        );
        firstBlocking = firstBlocking || signal;
      }
    }
    if (firstBlocking) {
      // Una sola peticion aunque en la misma lectura se bloqueen varios errores.
      requestBlockingSuggestion(firstBlocking, document);
    }
    // Los diagnosticos pueden no cambiar mas: se vuelve a mirar cuando venza el siguiente plazo.
    const deadline = errorSignalTracker.nextDeadline(now, lastEditAt);
    if (deadline !== null) {
      errorSignalTimer = setTimeout(evaluateErrorSignals, Math.min(10 * 60_000, Math.max(250, deadline - now + 50)));
    }
  };

  const textDocumentSelector: vscode.DocumentSelector = [
    { scheme: 'file' },
    { scheme: 'vscode-remote' },
    { scheme: 'untitled' },
  ];

  context.subscriptions.push(
    openAssistantDisposable,
    refreshSuggestionsDisposable,
    openSuggestionHistoryDisposable,
    clearSuggestionHistoryDisposable,
    openSuggestionHistoryEntryDisposable,
    applySuggestionCompletionDisposable,
    openRagSourceDisposable,
    setBackendSessionIdDisposable,
    applyNextCodeActionDisposable,
    quizView,
    suggestionCodeLensProvider,
    suggestionCodeActionProvider,
    suggestionInlayHintProvider,
    suggestionStatusBar,
    suggestionDecorationType,
    vscode.languages.registerCodeLensProvider(textDocumentSelector, suggestionCodeLensProvider),
    vscode.languages.registerInlayHintsProvider(textDocumentSelector, suggestionInlayHintProvider),
    vscode.languages.registerCodeActionsProvider(
      textDocumentSelector,
      suggestionCodeActionProvider,
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) {
        // El foco se fue al panel de ADACEEN, a la terminal o a la salida:
        // el archivo sigue abierto, asi que no se toca nada.
        return;
      }
      if (editor.document.uri.toString() !== selectionWidget.uriString) {
        selectionWidget.hide();
      }
      const activeUri = editor.document.uri.toString();
      if (activeUri !== lastActiveDocumentUri) {
        // La primera peticion de este archivo sale con trigger "file_open".
        lastActiveDocumentUri = activeUri;
        pendingFileOpenUri = activeUri;
      }
      refreshInlineSuggestionSurfaces();
      scheduleCursorIdleSuggestionRefresh();
      evaluateErrorSignals();
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      selectionWidget.onSelectionChanged(event.textEditor);
      if (vscode.window.activeTextEditor?.document.uri.toString() === event.textEditor.document.uri.toString()) {
        scheduleCursorIdleSuggestionRefresh();
        refreshInlineSuggestionSurfaces();
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (vscode.window.activeTextEditor?.document.uri.toString() === event.document.uri.toString()) {
        if (event.contentChanges.length > 0) {
          rememberEdit(event.document.uri.toString());
        }
        refreshInlineSuggestionSurfaces();
        scheduleCursorIdleSuggestionRefresh();
      }
    }),
    vscode.languages.onDidChangeDiagnostics((event) => {
      const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
      if (activeUri && event.uris.some((uri) => uri.toString() === activeUri)) {
        evaluateErrorSignals();
      }
    }),
    vscode.workspace.onDidSaveTextDocument(() => {
      clearWorkspaceProjectIndexCache();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearWorkspaceProjectIndexCache();
      clearBackendSuggestionCaches();
      scheduleCursorIdleSuggestionRefresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('adaceen.suggestions') ||
        event.affectsConfiguration('adaceen.backend')
      ) {
        clearBackendSuggestionCaches();
        clearWorkspaceProjectIndexCache();
        scheduleCursorIdleSuggestionRefresh();
      }
      if (event.affectsConfiguration('adaceen.triggers')) {
        errorSignalTracker.updateSettings(errorSignalSettingsFromConfig());
        evaluateErrorSignals();
      }
      if (event.affectsConfiguration('comments.visible')) {
        // Comentarios ocultos: la ventana flotante no se ve y el CodeLens y la pista vuelven.
        suggestionCodeLensProvider.refresh();
        refreshInlineSuggestionSurfaces();
      }
    }),
    {
      dispose: () => {
        if (suggestionTimer) {
          clearTimeout(suggestionTimer);
          suggestionTimer = null;
        }
        clearCursorSuggestionTimers();
        clearErrorSignalTimer();
        if (selectionInlinePanelTimer) {
          clearTimeout(selectionInlinePanelTimer);
          selectionInlinePanelTimer = null;
        }
        clearSuggestionDecorations(suggestionDecorationType);
      },
    },
  );

  let workerBusy = false;
  let workerNextPollAt = 0;
  let idlePollCount = 0;
  let missingWorkspacePollCount = 0;
  let missingRepoPollCount = 0;
  let authErrorNotified = false;

  const runWorkerCycle = async () => {
    const settings = resolveBackendSettings();
    if (!settings.autoWorkerEnabled) {
      return;
    }

    if (Date.now() < workerNextPollAt) {
      return;
    }
    workerNextPollAt = Date.now() + settings.workerPollMs;

    if (workerBusy) {
      return;
    }
    workerBusy = true;

    let requestId = '';
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) {
        missingWorkspacePollCount += 1;
        if (missingWorkspacePollCount % 15 === 0) {
          output.appendLine('[Worker] Sin workspace abierto; esperando para reclamar solicitudes.');
        }
        return;
      }
      missingWorkspacePollCount = 0;

      const repoFullName = await detectRepoFullName(workspaceFolders);
      if (!repoFullName) {
        missingRepoPollCount += 1;
        if (missingRepoPollCount % 10 === 0) {
          output.appendLine('[Worker] No se pudo detectar repo GitHub (owner/repo) desde este workspace.');
        }
        return;
      }
      missingRepoPollCount = 0;

      const processedCodeAction = await processNextCodeActionForRepo(settings, repoFullName, output, codeApplicationGuardDeps, false);
      if (processedCodeAction) {
        idlePollCount = 0;
        return;
      }

      const request = await claimNextScanRequest(settings, repoFullName);
      if (!request) {
        idlePollCount += 1;
        if (idlePollCount % 15 === 0) {
          output.appendLine(`[Worker] Sin solicitudes pendientes para ${repoFullName}.`);
        }
        return;
      }
      idlePollCount = 0;

      requestId = request.id;
      output.appendLine(`[Worker] Solicitud reclamada: ${request.id} (${request.repoFullName}).`);

      // Permiso del estudiante en cada solicitud (A12.12): sin el, no sale nada del equipo.
      const permission = await askScanPermission(
        context.workspaceState,
        request.repoFullName,
        resolveScanOptions(undefined).maxFiles,
      );
      if (permission !== 'allow') {
        const reason = permission === 'timeout'
          ? 'Sin respuesta en VS Code en 2 minutos: no se escaneo el proyecto.'
          : 'El estudiante no autorizo el escaneo en VS Code.';
        output.appendLine(`[Worker] ${reason} (${request.id})`);
        await sendScanFailure(settings, request.id, reason);
        requestId = '';
        return;
      }

      const scan = await performWorkspaceScan(undefined, output);
      const payload: ScanPayload = {
        ...scan.payload,
        repoFullName: request.repoFullName,
      };
      const scanResponse = await sendScanResult(settings, request.id, payload);

      output.appendLine(
        `[Worker] Escaneo enviado al backend: ${request.repoFullName} (${payload.totalFiles} archivos).`,
      );

      const snapshotId = toOptionalString(asRecord(scanResponse).snapshotId);
      await classifyScannedDocuments(settings, {
        repoFullName: request.repoFullName,
        requestId: request.id,
        snapshotId: snapshotId || '',
        documents: scan.documents,
      }, output);
    } catch (error) {
      const errorMessage = String(error);
      // Sin output.show: un error del worker no le quita el foco al estudiante.
      output.appendLine(`[Worker] Error al procesar solicitud de escaneo: ${errorMessage}`);

      const normalized = errorMessage.toLowerCase();
      if (
        !authErrorNotified &&
        (normalized.includes('worker no autorizado') || normalized.includes('http 401') || normalized.includes('401'))
      ) {
        authErrorNotified = true;
        vscode.window.showWarningMessage(
          'ADACEEN Worker: el backend rechazó la solicitud (401/no autorizado). Conecta VS Code con tu cuenta (ADACEEN: Conectar) o revisa adaceen.backend.scanWorkerKey.',
        );
      }

      if (requestId) {
        await sendScanFailure(settings, requestId, errorMessage);
      }
    } finally {
      workerBusy = false;
    }
  };

  const timer = setInterval(() => {
    void runWorkerCycle();
  }, WORKER_TICK_MS);

  context.subscriptions.push(
    scanWorkspaceDisposable,
    output,
    {
      dispose: () => clearInterval(timer),
    },
  );

  scheduleCursorIdleSuggestionRefresh();
  evaluateErrorSignals();
  void runWorkerCycle();
}

export function deactivate() {}
