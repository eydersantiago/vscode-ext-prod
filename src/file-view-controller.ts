// ADACEEN (VS Code): archivo que muestra la vista «Este archivo» y su cuadro «Dependencias» (calculo, espera y clic).
// Movido desde activate() (src/extension.ts): mismo texto; el estado compartido esta en *-state.ts.
import * as vscode from 'vscode';
import { computeActiveFileDependencies, indexKeyOf, workspaceRelativePath } from './dependency-scan';
import { revealEditorLine } from './editor-snapshot';
import { output, safeLog, telemetry } from './extension-state';
import { dependencyItemId } from './file-view-model';
import type { FileViewDependencyGroup } from './file-view-model';
import { dependencyBuildFiles, dependencyIndex, dependencyIndexAt, dependencyIndexDirty, dependencyProbes, dependencyRun, dependencyState, dependencyTimer, fileView, fileViewDocument, fileViewIdentity, savedSinceDependencyIndex, setDependencyIndex, setDependencyIndexAt, setDependencyIndexDirty, setDependencyRun, setDependencyState, setDependencyTimer, setFileViewDocumentValue, setFileViewIdentity, setWorkshopProgress, workshopProgress } from './file-view-state';
import { getWorkspaceProjectIndex } from './suggestion-backend';
import { resolveWorkspaceFileUri } from './suggestion-edit';
import { editorPageContext } from './suggestion-metrics';
import { refreshFileView } from './suggestion-publish';
import { inferActiveLanguage } from './suggestion-results';
import { fetchMyWorkshopProgress } from './workshop-progress-client';
import { WorkshopProgressPoller } from './workshop-progress-poller';

export const markDependencyIndexDirty = () => {
  setDependencyIndexDirty(dependencyIndexDirty + 1);
};

/** Recalcula el cuadro «Dependencias» del archivo de la vista (solo si la vista se ve). */
const refreshDependencies = async () => {
  const document = fileViewDocument;
  if (!document || document.isClosed) {
    setDependencyState(null);
    refreshFileView();
    return;
  }
  const uriString = document.uri.toString();
  const run = setDependencyRun(dependencyRun + 1);
  if (!dependencyState || dependencyState.uriString !== uriString) {
    // Otro archivo: «Buscando...» en vez de las dependencias del anterior.
    setDependencyState({ uriString, loading: true, result: null });
    refreshFileView();
  }
  try {
    // Por si se perdio un aviso de cambios (otro editor, una carpeta de red): a los 5 minutos
    // el indice se vuelve a pedir.
    if ([...savedSinceDependencyIndex].some((saved) => saved !== uriString) || Date.now() - dependencyIndexAt > 5 * 60_000) {
      markDependencyIndexDirty();
    }
    let index = dependencyIndex;
    if (dependencyIndexDirty || !index) {
      const dirtyAt = dependencyIndexDirty;
      savedSinceDependencyIndex.clear();
      index = await getWorkspaceProjectIndex({ allowStale: true });
      if (dependencyIndexDirty === dirtyAt) {
        setDependencyIndex(index);
        setDependencyIndexDirty(0);
        setDependencyIndexAt(Date.now());
      }
    }
    if (run !== dependencyRun) {
      return;
    }
    const previous = dependencyState?.result;
    if (previous && previous.uriString === uriString && previous.version === document.version
      && previous.languageId === document.languageId && previous.indexKey === indexKeyOf(index)) {
      if (dependencyState && !dependencyState.loading && dependencyState.result === previous) {
        return; // nada cambio: volver a pintar la vista le quitaba el foco al teclado
      }
      setDependencyState({ uriString, loading: false, result: previous });
    } else {
      const result = await computeActiveFileDependencies(document, index, dependencyProbes, dependencyBuildFiles, () => run === dependencyRun);
      if (run !== dependencyRun) {
        return;
      }
      setDependencyState({ uriString, loading: false, result });
    }
  } catch (error) {
    output.appendLine(`[Dependencias] No se pudieron leer las dependencias de ${workspaceRelativePath(document.uri)}: ${String(error)}`);
    if (run !== dependencyRun) {
      return;
    }
    setDependencyState({ uriString, loading: false, result: null });
  }
  refreshFileView();
};

export const scheduleDependencyRefresh = (delayMs: number) => {
  if (dependencyTimer) {
    clearTimeout(dependencyTimer);
    setDependencyTimer(null);
  }
  // Con la vista oculta no se calcula nada: se calcula al mostrarla (onVisibilityChanged).
  if (!fileView?.visible) {
    return;
  }
  setDependencyTimer(setTimeout(() => {
    setDependencyTimer(null);
    void refreshDependencies();
  }, delayMs));
};

/** El archivo de la vista cambio (otra pestaña, o se cerro el que se mostraba). */
export const setFileViewDocument = (document: vscode.TextDocument | null) => {
  // Otro archivo, o el mismo con otro lenguaje (un .tpp que se marca como C++).
  const identity = document ? `${document.uri.toString()}|${document.languageId}` : '';
  const changed = identity !== fileViewIdentity;
  setFileViewDocumentValue(document);
  setFileViewIdentity(identity);
  if (changed) {
    refreshFileView();
    scheduleDependencyRefresh(120);
  }
};

/**
 * Clic en el cuadro «Dependencias»: abre el archivo del proyecto o va a la linea del import.
 * El clic trae el archivo y la version del cuadro que se vio, y el id del elemento: si el
 * cuadro ya cambio (otro archivo se guardo y «La usan» se reordeno), se busca el mismo elemento
 * por su id (o no se hace nada) en vez de abrir otro.
 */
export const openDependency = async (group: FileViewDependencyGroup, index: number, key: string, id: string) => {
  const result = dependencyState?.result;
  if (!result || (key && key !== `${result.uriString}|${result.version}`)) {
    return;
  }
  const list = result.deps[group];
  const item = list[index] && (!id || dependencyItemId(list[index]) === id)
    ? list[index]
    : list.find((entry) => dependencyItemId(entry) === id);
  if (!item) {
    return;
  }
  try {
    if ((group === 'local' || group === 'dependents') && item.path) {
      const known = result.uris.get(item.path);
      const uri = known ? vscode.Uri.parse(known) : await resolveWorkspaceFileUri(item.path);
      if (!uri) {
        void vscode.window.showInformationMessage(`ADACEEN: no se encontró ${item.path} en el proyecto.`);
        return;
      }
      const editor = await vscode.window.showTextDocument(uri, { preview: true });
      if (group === 'dependents' && item.line > 0) {
        revealEditorLine(editor, item.line);
      }
    } else if (item.line > 0) {
      const editor = await vscode.window.showTextDocument(vscode.Uri.parse(result.uriString), { preview: false });
      revealEditorLine(editor, item.line);
    }
    telemetry.track({
      source: 'vscode_extension',
      category: 'navigation',
      eventType: 'vscode_dependency_opened',
      pageContext: editorPageContext(),
      value: group,
      language: inferActiveLanguage(result.filePath, ''),
      metadata: { family: result.deps.family, implicit: !!item.implicit, warning: !!item.warning },
    });
  } catch (error) {
    output.appendLine(`[Dependencias] No se pudo abrir ${item.path || item.label}: ${String(error)}`);
  }
};

export function registerWorkshopProgress(context: vscode.ExtensionContext) {
  // 0.0.38: avance del taller en la esquina de la vista (GET /api/workshop-progress/me). Sin
  // sesion o sin red: no se muestra nada.
  setWorkshopProgress(new WorkshopProgressPoller({
    fetchProgress: fetchMyWorkshopProgress,
    onChange: () => refreshFileView(),
    log: safeLog,
  }));
  context.subscriptions.push(workshopProgress);
}
