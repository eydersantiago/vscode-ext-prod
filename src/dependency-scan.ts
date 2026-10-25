// ADACEEN (VS Code): dependencias del archivo activo con la API de vscode (0.0.36).
// La lectura y la resolucion estan en file-dependencies.ts (puro, con pruebas); aqui se junta
// el documento del editor, el indice del proyecto y una busqueda en el disco de lo que el
// indice no tiene (tope de 90 archivos y solo algunas extensiones: un .tpp o un .hh no estan).
import * as vscode from 'vscode';
import { ACTIVE_SUGGESTION_INDEX_MAX_FILES } from './constants';
import { resolveFileDependencies } from './file-dependencies';
import type { FileDependencies } from './file-dependencies';
import { resolveScanOptions } from './settings';
import { inferActiveLanguage } from './suggestion-results';
import type { WorkspaceProjectIndex } from './types';

export type ActiveFileDependencies = {
  uriString: string;
  filePath: string;
  version: number;
  /** Indice con el que se calculo (para no repetir el calculo si nada cambio). */
  indexKey: string;
  deps: FileDependencies;
  /** Ruta relativa -> URI (del indice y de la busqueda en el disco), para abrir con un clic. */
  uris: Map<string, string>;
  /** El indice llego a su tope de archivos: «La usan» puede quedar corta. */
  partial: boolean;
};

const PROBE_TTL_MS = 30_000;
/** Solo nombres de archivo simples (y el ".*" que agrega la busqueda de JS): nada de glob ajeno. */
const PROBE_NAME = /^[\w.+@-]+(?:\.\*)?$/;

/** Lo que encontro la busqueda en el disco, por nombre (se borra al crear, borrar o renombrar). */
export class DependencyProbeCache {
  private readonly entries = new Map<string, { at: number; uris: vscode.Uri[] }>();

  clear() {
    this.entries.clear();
  }

  async find(name: string): Promise<vscode.Uri[]> {
    if (!PROBE_NAME.test(name) || !vscode.workspace.workspaceFolders?.length) {
      return [];
    }
    const cached = this.entries.get(name);
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
      return cached.uris;
    }
    let uris: vscode.Uri[] = [];
    try {
      uris = await vscode.workspace.findFiles(`**/${name}`, resolveScanOptions(undefined).excludeGlob, 5);
    } catch {
      uris = [];
    }
    this.entries.set(name, { at: Date.now(), uris });
    return uris;
  }
}

/** Identifica un indice armado (no solo su contenido): uno rearmado tras guardar cuenta como otro. */
export function indexKeyOf(index: WorkspaceProjectIndex | null) {
  return index ? `${index.cacheKey}|${index.generatedAt}` : '';
}

export function workspaceRelativePath(uri: vscode.Uri) {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
}

/**
 * Dependencias del documento. Un archivo fuera de la carpeta abierta (o sin guardar) no se
 * compara con el proyecto: sus #include "x" quedarian como «no encontrados» aunque existan al
 * lado en el disco, asi que solo se muestran sus bibliotecas.
 */
export async function computeActiveFileDependencies(
  document: vscode.TextDocument,
  index: WorkspaceProjectIndex | null,
  probes: DependencyProbeCache,
): Promise<ActiveFileDependencies> {
  const inWorkspace = !document.isUntitled && !!vscode.workspace.getWorkspaceFolder(document.uri);
  const filePath = workspaceRelativePath(document.uri);
  const language = inferActiveLanguage(filePath, document.languageId);
  const text = document.getText();
  const files = inWorkspace ? index?.files || [] : [];
  const uris = new Map<string, string>();
  for (const entry of files) {
    if (entry.uri && !uris.has(entry.path)) {
      uris.set(entry.path, entry.uri);
    }
  }
  let deps = resolveFileDependencies({ activePath: filePath, language, text, files });
  if (inWorkspace && deps.probes.length) {
    const extraPaths: string[] = [];
    for (const name of deps.probes) {
      for (const uri of await probes.find(name)) {
        const path = workspaceRelativePath(uri);
        if (!uris.has(path)) {
          uris.set(path, uri.toString());
        }
        extraPaths.push(path);
      }
    }
    if (extraPaths.length) {
      deps = resolveFileDependencies({ activePath: filePath, language, text, files, extraPaths });
    }
  }
  if (!inWorkspace) {
    deps = { ...deps, local: [], missing: [], dependents: [], probes: [] };
  }
  return {
    uriString: document.uri.toString(),
    filePath,
    version: document.version,
    indexKey: indexKeyOf(index),
    deps,
    uris,
    partial: inWorkspace && (index?.totalFiles || 0) >= ACTIVE_SUGGESTION_INDEX_MAX_FILES,
  };
}
