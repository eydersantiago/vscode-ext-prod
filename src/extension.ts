// ADACEEN (VS Code): punto de entrada: activate() registra comandos, vistas, proveedores y temporizadores; deactivate().
// Cada paso esta en su modulo y aqui solo se llaman en el orden de siempre: el estado compartido en
// extension-state, file-view-state y suggestion-state; la sugerencia en suggestion-* (publish, refresh,
// schedule, apply, backend); la vista en file-view-*; eventos, comandos, senales, worker y origen de la
// GPU en editor-events, extension-commands, error-signal-watch, scan-worker y backend-origin.
import * as vscode from 'vscode';
import { registerBackendOrigin } from './backend-origin';
import { registerEditorEvents } from './editor-events';
import { createErrorSignals } from './error-signal-watch';
import { registerExtensionCommands } from './extension-commands';
import { connection, initCoreState, initProposals, initQuizState, initTelemetryState, safeLog } from './extension-state';
import { registerFileView } from './file-view-commands';
import { registerWorkshopProgress } from './file-view-controller';
import { initDependencyIndexState, initFileViewState, workshopProgress } from './file-view-state';
import { registerScanWorker } from './scan-worker';
import { registerSelectionHint } from './selection-hint-reminder';
import { refreshLocalBackendDetection } from './settings';
import { registerSelectionWidgetCommands } from './suggestion-apply';
import { registerSelectionWidgetVisibility } from './suggestion-publish';
import { scheduleCursorIdleSuggestionRefresh } from './suggestion-schedule';
import { initSuggestionState, initSuggestionSurfaces, setCodeRequestInFlightKey, setSlowNoticeTimer } from './suggestion-state';
import { registerWorkshopProgressTriggers } from './workshop-progress-client';

export async function activate(context: vscode.ExtensionContext) {
  initCoreState(context);
  // Antes de la primera llamada: backend local si esta corriendo, si no produccion
  // (sin nada escuchando en el 3000 la prueba termina al instante, maximo 800 ms),
  // y despues la sesion guardada (SecretStorage y ~/.adaceen/editor-session.json):
  // la emparejada solo vale en su backend, asi que primero hay que saber cual es.
  await refreshLocalBackendDetection();
  await connection.initialize();
  initTelemetryState(context);
  initQuizState(context);
  initFileViewState();
  registerWorkshopProgress(context);
  initDependencyIndexState();
  initProposals(context);
  initSuggestionSurfaces();
  registerBackendOrigin(context);
  // Barra «ADACEEN: sin conectar / <nombre>», «ADACEEN: Conectar», enlaces
  // vscode://adaceen.adaceen/... y, sin sesion, GitHub de VS Code en silencio.
  // Un fallo aqui no debe dejar sin sugerencias ni telemetria.
  try {
    connection.start();
  } catch (error) {
    safeLog(`[Sesion] No se pudo iniciar la conexion con la cuenta: ${String(error)}`);
  }
  initSuggestionState();
  registerSelectionWidgetVisibility(context);
  // Aviso de espera larga (0.0.34): a los 20 s sin respuesta la ventana y la barra lo dicen.
  setSlowNoticeTimer(null);
  /** Pedido de codigo en curso (sugerencia y accion): un doble clic no manda dos. */
  setCodeRequestInFlightKey('');
  registerSelectionWidgetCommands(context);
  registerFileView(context);
  const {
    openAssistantDisposable,
    refreshSuggestionsDisposable,
    requestSuggestionDisposable,
    openSuggestionHistoryDisposable,
    clearSuggestionHistoryDisposable,
    openSuggestionHistoryEntryDisposable,
    applySuggestionCompletionDisposable,
    openRagSourceDisposable,
    setBackendSessionIdDisposable,
    applyNextCodeActionDisposable,
    scanWorkspaceDisposable,
  } = registerExtensionCommands(context);
  const { errorSignalTracker, clearErrorSignalTimer, rememberEdit, evaluateErrorSignals } = createErrorSignals();
  registerEditorEvents(context, {
    openAssistantDisposable,
    refreshSuggestionsDisposable,
    requestSuggestionDisposable,
    openSuggestionHistoryDisposable,
    clearSuggestionHistoryDisposable,
    openSuggestionHistoryEntryDisposable,
    applySuggestionCompletionDisposable,
    openRagSourceDisposable,
    setBackendSessionIdDisposable,
    applyNextCodeActionDisposable,
    errorSignalTracker,
    clearErrorSignalTimer,
    rememberEdit,
    evaluateErrorSignals,
  });
  const runWorkerCycle = registerScanWorker(context, scanWorkspaceDisposable);
  // 0.0.38: el avance del taller se vuelve a pedir al guardar, al compilar y al cambiar de sesion.
  context.subscriptions.push(...registerWorkshopProgressTriggers(workshopProgress, {
    onDidChangeSessionId: (listener) => connection.onDidChangeSession((_session, idChanged) => {
      if (idChanged) {
        listener();
      }
    }),
  }));
  registerSelectionHint(context);
  scheduleCursorIdleSuggestionRefresh();
  evaluateErrorSignals();
  void runWorkerCycle();
}

export function deactivate() {}
