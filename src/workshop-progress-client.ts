// ADACEEN (VS Code): la consulta del avance del taller al backend (0.0.38).
//
// GET /api/workspaces/my-progress con las mismas cabeceras que /suggest-tab (sesion, cliente,
// version y editor: buildSessionHeaders). Sin sesion no se pregunta (el avance es por
// estudiante). El repositorio va en ?repo= si se reconoce la carpeta abierta (owner/name).
import * as vscode from 'vscode';
import { buildSessionHeaders, fetchJsonWithTimeout } from './backend-http';
import { detectRepoFullName } from './git-repo';
import { resolveBackendSettings } from './settings';
import { progressUrl } from './workshop-progress';

const PROGRESS_TIMEOUT_MS = 10_000;

/** El avance del estudiante (JSON del backend), o null sin backend o sin sesion. Lanza ante un error. */
export async function fetchMyWorkshopProgress(): Promise<unknown | null> {
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
