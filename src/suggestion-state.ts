// ADACEEN (VS Code): estado de la sugerencia activa, de sus superficies (ventana, CodeLens, pista, barra) y de sus temporizadores.
// Antes eran variables locales de activate(); las asignaciones desde otros modulos usan los setters.
import * as vscode from 'vscode';
import { AdaceenSelectionWidget } from './selection-widget';
import { resolveActiveSuggestionSettings } from './settings';
import { updateSuggestionStatusBar } from './suggestion-decorations';
import { SuggestionExposureTracker } from './suggestion-exposure';
import { AdaceenSuggestionCodeActionProvider, AdaceenSuggestionCodeLensProvider, AdaceenSuggestionInlayHintProvider } from './suggestion-providers';
import { selectionWidgetPresence as selectionWidgetPresenceFor } from './suggestion-surfaces';
import type { SelectionWidgetPresence } from './suggestion-surfaces';
import type { ActiveSuggestionModel, BackendSuggestionInFlight, BackendSuggestionRequestScope, BackendSuggestionResult, WorkspaceProjectIndex } from './types';

// initSuggestionSurfaces(): ventana flotante, CodeLens, arreglo rapido, pista y barra.
export let selectionWidget: AdaceenSelectionWidget;
export let selectionWidgetPresence: () => SelectionWidgetPresence;
export let dismissedSuggestionMetricId: string;
export let suggestionCodeLensProvider: AdaceenSuggestionCodeLensProvider;
export let quickFixAutoOpenedAt: number;
export let suggestionCodeActionProvider: AdaceenSuggestionCodeActionProvider;
export let suggestionInlayHintProvider: AdaceenSuggestionInlayHintProvider;
export let suggestionStatusBar: vscode.StatusBarItem;
// initSuggestionState(): sugerencia activa, caches del tutor e indice, temporizadores y origen del pedido.
export let suggestionDecorationType: vscode.TextEditorDecorationType;
export let backendSuggestionCache: Record<BackendSuggestionRequestScope, Map<string, BackendSuggestionResult>>;
export let backendSuggestionInFlight: Map<string, BackendSuggestionInFlight>;
export let activeSuggestionModel: ActiveSuggestionModel | null;
export let lastRequestedModel: ActiveSuggestionModel | null;
export let suggestionTimer: ReturnType<typeof setTimeout> | null;
export let cursorIdleSuggestionTimer: ReturnType<typeof setTimeout> | null;
export let cursorActionTimer: ReturnType<typeof setTimeout> | null;
export let recordedSuggestionMetricKeys: Set<string>;
export let suppressSuggestionRefreshUntil: number;
export let suppressSuggestionRefreshUri: string;
export let autoRevealedSuggestionUri: string;
export let autoOpenedSelectionActionKey: string;
export let selectionInlinePanelTimer: ReturnType<typeof setTimeout> | null;
export let rackSyncErrorNotified: boolean;
export let workspaceProjectIndexCache: {
  identity: string;
  expiresAt: number;
  value: WorkspaceProjectIndex | null;
} | null;
export let workspaceProjectIndexInFlight: Promise<WorkspaceProjectIndex | null> | null;
export let workspaceProjectIndexGeneration: number;
export let suggestionExposure: SuggestionExposureTracker<ActiveSuggestionModel>;
export let lastActiveDocumentUri: string;
export let pendingFileOpenUri: string;
export let pendingBlocking: { uriString: string; key: string; text: string; detectedAt: number } | null;
export let applyInProgress: boolean;
export let lastKnownRepoFullName: string;
// activate() los fija con su setter (aviso de espera larga y pedido de codigo en curso).
export let slowNoticeTimer: ReturnType<typeof setTimeout> | null;
export let codeRequestInFlightKey: string;

// Las asignaciones que hacen otros modulos (devuelven el valor, como una asignacion).
export function setDismissedSuggestionMetricId(value: string) {
  return (dismissedSuggestionMetricId = value);
}

export function setQuickFixAutoOpenedAt(value: number) {
  return (quickFixAutoOpenedAt = value);
}

export function setActiveSuggestionModel(value: ActiveSuggestionModel | null) {
  return (activeSuggestionModel = value);
}

export function setLastRequestedModel(value: ActiveSuggestionModel | null) {
  return (lastRequestedModel = value);
}

export function setSuggestionTimer(value: ReturnType<typeof setTimeout> | null) {
  return (suggestionTimer = value);
}

export function setCursorIdleSuggestionTimer(value: ReturnType<typeof setTimeout> | null) {
  return (cursorIdleSuggestionTimer = value);
}

export function setCursorActionTimer(value: ReturnType<typeof setTimeout> | null) {
  return (cursorActionTimer = value);
}

export function setSuppressSuggestionRefreshUntil(value: number) {
  return (suppressSuggestionRefreshUntil = value);
}

export function setSuppressSuggestionRefreshUri(value: string) {
  return (suppressSuggestionRefreshUri = value);
}

export function setAutoRevealedSuggestionUri(value: string) {
  return (autoRevealedSuggestionUri = value);
}

export function setAutoOpenedSelectionActionKey(value: string) {
  return (autoOpenedSelectionActionKey = value);
}

export function setSelectionInlinePanelTimer(value: ReturnType<typeof setTimeout> | null) {
  return (selectionInlinePanelTimer = value);
}

export function setRackSyncErrorNotified(value: boolean) {
  return (rackSyncErrorNotified = value);
}

export function setWorkspaceProjectIndexCache(value: {
  identity: string;
  expiresAt: number;
  value: WorkspaceProjectIndex | null;
} | null) {
  return (workspaceProjectIndexCache = value);
}

export function setWorkspaceProjectIndexInFlight(value: Promise<WorkspaceProjectIndex | null> | null) {
  return (workspaceProjectIndexInFlight = value);
}

export function setWorkspaceProjectIndexGeneration(value: number) {
  return (workspaceProjectIndexGeneration = value);
}

export function setLastActiveDocumentUri(value: string) {
  return (lastActiveDocumentUri = value);
}

export function setPendingFileOpenUri(value: string) {
  return (pendingFileOpenUri = value);
}

export function setPendingBlocking(value: { uriString: string; key: string; text: string; detectedAt: number } | null) {
  return (pendingBlocking = value);
}

export function setApplyInProgress(value: boolean) {
  return (applyInProgress = value);
}

export function setLastKnownRepoFullName(value: string) {
  return (lastKnownRepoFullName = value);
}

export function setSlowNoticeTimer(value: ReturnType<typeof setTimeout> | null) {
  return (slowNoticeTimer = value);
}

export function setCodeRequestInFlightKey(value: string) {
  return (codeRequestInFlightKey = value);
}

export function initSuggestionSurfaces() {
  // Ventana flotante anclada a la seleccion: una sola sugerencia, en un solo sitio.
  selectionWidget = new AdaceenSelectionWidget();
  // Con comments.visible=false el hilo existe pero no se ve: no cuenta como abierta.
  selectionWidgetPresence = (): SelectionWidgetPresence => selectionWidgetPresenceFor({
    hasThread: selectionWidget.visible,
    uriString: selectionWidget.uriString,
    commentsVisible: vscode.workspace.getConfiguration('comments').get<boolean>('visible', true) !== false,
  });
  // Sugerencia que el estudiante descarto con la X de la ventana flotante: no se vuelve a
  // ofrecer en el CodeLens ni en la pista hasta que llegue otra.
  dismissedSuggestionMetricId = '';
  suggestionCodeLensProvider = new AdaceenSuggestionCodeLensProvider(
    selectionWidgetPresence,
    () => dismissedSuggestionMetricId,
  );
  // Cuando ADACEEN abre solo el menu de arreglos rapidos (maybeOpenSelectionInlinePanel).
  quickFixAutoOpenedAt = 0;
  suggestionCodeActionProvider = new AdaceenSuggestionCodeActionProvider(() => quickFixAutoOpenedAt);
  suggestionInlayHintProvider = new AdaceenSuggestionInlayHintProvider();
  suggestionStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  // El bombillo abre «Este archivo» (resumen y material); antes abria el quiz.
  suggestionStatusBar.command = 'adaceen.openFileView';
  updateSuggestionStatusBar(suggestionStatusBar, null, resolveActiveSuggestionSettings().enabled);
}

export function initSuggestionState() {
  suggestionDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'normal',
      margin: '0 0 0 1rem',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  backendSuggestionCache = {
    cursor: new Map(),
    file_summary: new Map(),
  };
  backendSuggestionInFlight = new Map<string, BackendSuggestionInFlight>();
  activeSuggestionModel = null;
  // Ultimo codigo pedido por el estudiante (0.0.34): se vuelve a mostrar si regresa a la
  // misma seleccion sin cambios (p. ej. despues de «Ver cambios»).
  lastRequestedModel = null;
  suggestionTimer = null;
  cursorIdleSuggestionTimer = null;
  cursorActionTimer = null;
  recordedSuggestionMetricKeys = new Set<string>();
  suppressSuggestionRefreshUntil = 0;
  suppressSuggestionRefreshUri = '';
  autoRevealedSuggestionUri = '';
  autoOpenedSelectionActionKey = '';
  selectionInlinePanelTimer = null;
  rackSyncErrorNotified = false;
  workspaceProjectIndexCache = null;
  workspaceProjectIndexInFlight = null;
  // Sube con cada guardado o archivo nuevo: un indice armado antes no entra a la cache (0.0.36).
  workspaceProjectIndexGeneration = 0;
  // Cuanto estuvo a la vista cada sugerencia, para vscode_suggestion_ignored.
  suggestionExposure = new SuggestionExposureTracker<ActiveSuggestionModel>();
  // Origen real de las peticiones (trigger): archivo recien abierto y bloqueo pendiente.
  lastActiveDocumentUri = vscode.window.activeTextEditor?.document.uri.toString() || '';
  pendingFileOpenUri = lastActiveDocumentUri;
  pendingBlocking = null;
  applyInProgress = false;
  lastKnownRepoFullName = '';
}
