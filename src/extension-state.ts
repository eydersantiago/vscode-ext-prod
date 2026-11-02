// ADACEEN (VS Code): servicios que arma activate() y usan sus modulos: salida, conexion, telemetria, quiz y propuestas.
// Antes eran variables locales de activate(); se fijan en el mismo punto de la activacion.
import * as vscode from 'vscode';
import { buildSessionHeaders } from './backend-http';
import { describeBackendUrlSource, detectEditorHost, pairingEditorHost } from './backend-url';
import type { EditorHost } from './backend-url';
import { currentClientId, initClientIdentity } from './client-identity';
import { createCodeApplicationGuardDeps } from './code-actions';
import type { CodeApplicationGuardDeps } from './code-application-guard';
import { setEditorConnection } from './connection-state';
import { EditorConnection } from './editor-connect';
import { detectRepoFullName, parseRepoFromGitConfig, readGitConfigText } from './git-repo';
import { PROPOSAL_SCHEME, ProposalContentProvider } from './proposal-diff';
import { AdaceenQuizViewProvider } from './quiz-view';
import { backendUrlSetByWorkspace, getEnv, isCodespaceRuntime, resolveBackendSettings, resolveCurrentBackendBaseUrl } from './settings';
import { readSuggestionHistory } from './suggestion-history';
import { toQuizHistoryItems } from './suggestion-metrics';
import { TelemetryClient } from './telemetry';
import type { ActiveSuggestionHistoryEntry } from './types';

// initCoreState(), initTelemetryState(), initQuizState() e initProposals(), en ese orden.
export let output: vscode.OutputChannel;
export let safeLog: (line: string) => void;
export let editorMetadata: { editorHost: EditorHost; editorUi: 'web' | 'desktop' };
export let connection: EditorConnection;
export let reportInvalidSession: (sessionId: string) => void;
export let telemetry: TelemetryClient;
export let codeApplicationGuardDeps: CodeApplicationGuardDeps;
export let latestSuggestionHistory: ActiveSuggestionHistoryEntry[];
export let quizView: AdaceenQuizViewProvider;
export let proposals: ProposalContentProvider;
export let extensionContext: vscode.ExtensionContext;

// Lo asignan otros modulos (historial nuevo); devuelve el valor, como una asignacion.
export function setLatestSuggestionHistory(value: ActiveSuggestionHistoryEntry[]) {
  return (latestSuggestionHistory = value);
}

export function initCoreState(context: vscode.ExtensionContext) {
  extensionContext = context;
  output = vscode.window.createOutputChannel('ADACEEN');
  safeLog = (line: string) => {
    try {
      output.appendLine(line);
    } catch {
      // Canal ya cerrado (desactivacion): se descarta la linea.
    }
  };
  // Donde corre el editor (VS Code instalado, tunel, Codespaces), en cada evento.
  editorMetadata = {
    editorHost: detectEditorHost({ remoteName: vscode.env.remoteName, codespace: isCodespaceRuntime() }),
    editorUi: vscode.env.uiKind === vscode.UIKind.Web ? 'web' as const : 'desktop' as const,
  };
  // Identidad unica para TODAS las llamadas al backend (x-adaceen-client-id, el mismo id
  // persistente que usaba la vista de quiz) y, desde la 0.0.37, esta version y donde corre.
  const identity = initClientIdentity(context.globalState, {
    extensionVersion: context.extension?.packageJSON?.version,
    editorHost: editorMetadata.editorHost,
  });
  if (!identity.extensionVersion) {
    safeLog('[ADACEEN] Sin version valida en el package.json: el backend vera esta extension como anterior a la 0.0.37.');
  }
  // Sesion de ADACEEN: SecretStorage, archivo del tunel o ajuste heredado (src/editor-connect.ts).
  connection = new EditorConnection({
    context,
    log: safeLog,
    backendUrl: () => resolveCurrentBackendBaseUrl().baseUrl,
    // Para el canje: vscode.dev sin tunel es "web".
    editorHost: () => pairingEditorHost(editorMetadata.editorHost, editorMetadata.editorUi),
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
}

export function initTelemetryState(context: vscode.ExtensionContext) {
  reportInvalidSession = (sessionId: string) => connection.sessions.reportInvalid(sessionId);
  telemetry = new TelemetryClient({
    getEndpoint: () => {
      const settings = resolveBackendSettings();
      return { baseUrl: settings.baseUrl, sessionId: settings.sessionId, clientId: currentClientId() };
    },
    baseMetadata: () => editorMetadata,
    log: safeLog,
    onSessionInvalid: reportInvalidSession,
  });
  codeApplicationGuardDeps = createCodeApplicationGuardDeps(telemetry, output);
  context.subscriptions.push({ dispose: () => telemetry.dispose() });
  const startupSettings = resolveBackendSettings();
  output.appendLine(
    `[Worker] Inicializado | auto=${startupSettings.autoWorkerEnabled} | backend=${startupSettings.baseUrl} | pollMs=${startupSettings.workerPollMs} | workerId=${startupSettings.workerId}`,
  );
  output.appendLine(
    `[Backend] ${startupSettings.baseUrl} (${describeBackendUrlSource(startupSettings.baseUrlSource)}) | editor=${editorMetadata.editorHost}/${editorMetadata.editorUi}`,
  );
  output.appendLine(`[Identidad] clientId=${currentClientId()} | clientSessionId=${telemetry.clientSessionId}`);
}

export function initQuizState(context: vscode.ExtensionContext) {
  latestSuggestionHistory = readSuggestionHistory(context.workspaceState);
  // Vista movible "Quiz y seguimiento" (reemplaza el panel de sugerencias):
  // quiz tras aceptar una sugerencia o lanzado por el docente, e historial.
  quizView = new AdaceenQuizViewProvider({
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
}

export function initProposals(context: vscode.ExtensionContext) {
  // «Ver cambios»: la propuesta del tutor aplicada, en un documento de solo lectura.
  proposals = new ProposalContentProvider();
  context.subscriptions.push(
    proposals,
    vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, proposals),
  );
}
