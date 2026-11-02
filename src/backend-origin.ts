// ADACEEN (VS Code): indicador de origen de la GPU en la barra de estado (consulta al activar, cada 30 s y con su comando).
// Movido desde activate() (src/extension.ts): mismo texto; el estado compartido esta en *-state.ts.
import * as vscode from 'vscode';
import { describeBackendUrlSource } from './backend-url';
import { connection, safeLog } from './extension-state';
import { refreshLocalBackendDetection, resolveBackendSettings } from './settings';
import { fetchBackendOrigin, UNKNOWN_BACKEND_ORIGIN, updateBackendOriginStatusBar } from './status-bar';

export function registerBackendOrigin(context: vscode.ExtensionContext) {
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
}
