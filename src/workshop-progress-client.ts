// ADACEEN (VS Code): el avance del taller con la API de vscode (0.0.38).
//
// La consulta al backend: GET /api/workshop-progress/me con las mismas cabeceras que
// /suggest-tab (sesion, cliente, version y editor: buildSessionHeaders). Sin sesion no se
// pregunta (el avance es por estudiante). El repositorio va en ?repoFullName= si se reconoce la
// carpeta abierta (owner/name).
// Y cuando se pregunta (registerWorkshopProgressTriggers): al activar, al guardar, al terminar
// una tarea o una compilacion en la terminal (a lo sumo una vez cada 2 minutos) y al cambiar de
// sesion (lo de la sesion anterior se esconde ya). Cuando decidir esta en
// workshop-progress-poller.ts y que es una compilacion en workshop-progress.ts, sin vscode.
import * as vscode from 'vscode';
import { buildSessionHeaders, fetchJsonWithTimeout } from './backend-http';
import { detectRepoFullName } from './git-repo';
import { resolveBackendSettings } from './settings';
import { isBuildCommandLine, progressUrl } from './workshop-progress';
import type { WorkshopProgressPoller } from './workshop-progress-poller';

const PROGRESS_TIMEOUT_MS = 10_000;

/**
 * Lo que responde el backend sobre el avance del estudiante, sin revisar (lo revisa
 * normalizeWorkshopProgressReply); sin backend o sin sesion no se pregunta y no hay respuesta
 * (null). Lanza ante un error HTTP o de red.
 */
export async function fetchMyWorkshopProgress(): Promise<unknown> {
  const settings = resolveBackendSettings();
  if (!settings.baseUrl || !settings.sessionId) {
    return null;
  }
  const folders = vscode.workspace.workspaceFolders;
  const repo = folders?.length ? await detectRepoFullName(folders).catch(() => undefined) : undefined;
  return fetchJsonWithTimeout(
    progressUrl(settings.baseUrl, repo),
    { method: 'GET', headers: buildSessionHeaders(settings, false) },
    PROGRESS_TIMEOUT_MS,
  );
}

/**
 * Lo que hace que se vuelva a preguntar el avance. Devuelve lo que hay que desechar al
 * desactivar. La vista «Este archivo» llama aparte a setVisible (cada 5 minutos con la vista a la
 * vista).
 */
export function registerWorkshopProgressTriggers(
  poller: WorkshopProgressPoller,
  options: {
    /** Otra sesion (otra cuenta, se conecto o se cerro la sesion): devuelve como dejar de escuchar. */
    onDidChangeSessionId: (listener: () => void) => vscode.Disposable;
  },
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [
    vscode.workspace.onDidSaveTextDocument(() => poller.refreshAfterWork()),
    options.onDidChangeSessionId(() => {
      void poller.refetchForNewSession();
    }),
  ];
  // Una tarea de VS Code (Ctrl+Shift+B) o una orden de compilar en la terminal con integracion de
  // shell. La extension web puede no tener estas API.
  if (typeof vscode.tasks?.onDidEndTaskProcess === 'function') {
    disposables.push(vscode.tasks.onDidEndTaskProcess(() => poller.refreshAfterWork()));
  }
  if (typeof vscode.window.onDidEndTerminalShellExecution === 'function') {
    disposables.push(vscode.window.onDidEndTerminalShellExecution((event) => {
      if (isBuildCommandLine(event.execution.commandLine.value || '')) {
        poller.refreshAfterWork();
      }
    }));
  }
  void poller.refresh();
  return disposables;
}
