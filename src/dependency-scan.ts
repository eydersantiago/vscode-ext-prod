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
import type { WorkspaceProjectIndex, WorkspaceProjectIndexEntry } from './types';

export type ActiveFileDependencies = {
  uriString: string;
  filePath: string;
  /** Version del documento cuyo texto se leyo (se toma junto con el texto, antes de esperar nada). */
  version: number;
  /** Indice con el que se calculo (para no repetir el calculo si nada cambio). */
  indexKey: string;
  deps: FileDependencies;
  /** Ruta relativa -> URI (del indice y de la busqueda en el disco), para abrir con un clic. */
  uris: Map<string, string>;
  /** El indice llego a su tope de archivos: «La usan» puede quedar corta. */
  partial: boolean;
  /** Fuera de la carpeta abierta (o sin guardar): solo se muestran sus bibliotecas. */
  outside: boolean;
};

const PROBE_TTL_MS = 30_000;
/** Solo nombres de archivo simples (letras de cualquier idioma: lógica.h) y el ".*" de JS. */
const PROBE_NAME = /^[\p{L}\p{N}_.+@-]+(?:\.\*)?$/u;

/** Lo que encontro la busqueda en el disco, por carpeta y nombre (se borra al crear o borrar archivos). */
export class DependencyProbeCache {
  private readonly entries = new Map<string, { at: number; uris: vscode.Uri[] }>();

  clear() {
    this.entries.clear();
  }

  /** Archivos con ese nombre dentro de `folder` (la carpeta del proyecto del archivo activo). */
  async find(name: string, folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
    if (!PROBE_NAME.test(name)) {
      return [];
    }
    const key = `${folder.uri.toString()}|${name}`;
    const cached = this.entries.get(key);
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) {
      return cached.uris;
    }
    let uris: vscode.Uri[] = [];
    try {
      uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, `**/${name}`),
        new vscode.RelativePattern(folder, resolveScanOptions(undefined).excludeGlob),
        20,
      );
    } catch {
      uris = [];
    }
    this.entries.set(key, { at: Date.now(), uris });
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
 * Las entradas del indice que son de la misma carpeta del proyecto que `uri`. Con varias
 * carpetas abiertas (taller1 y taller2, cada una con su main.cpp) las rutas relativas chocaban:
 * un clic abria el archivo de la otra carpeta y «La usan» lo repetia.
 */
export function indexFilesInFolderOf(index: WorkspaceProjectIndex | null, uri: vscode.Uri): WorkspaceProjectIndexEntry[] {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!index || !folder) {
    return [];
  }
  if ((vscode.workspace.workspaceFolders || []).length <= 1) {
    return index.files;
  }
  const prefix = folder.uri.toString().replace(/\/?$/, '/');
  return index.files.filter((entry) => !entry.uri || entry.uri.startsWith(prefix));
}

/** ¿El documento es un archivo de la carpeta abierta (no uno sin guardar ni de otra parte)? */
export function isWorkspaceDocument(document: vscode.TextDocument) {
  return !document.isUntitled && !!vscode.workspace.getWorkspaceFolder(document.uri);
}

async function exists(uri: vscode.Uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Dependencias del documento. Un archivo fuera de la carpeta abierta (o sin guardar) no se
 * compara con el proyecto: sus #include "x" quedarian como «no encontrados» aunque existan al
 * lado en el disco, asi que solo se muestran sus bibliotecas conocidas.
 */
export async function computeActiveFileDependencies(
  document: vscode.TextDocument,
  index: WorkspaceProjectIndex | null,
  probes: DependencyProbeCache,
): Promise<ActiveFileDependencies> {
  // El texto y su version juntos, antes de esperar nada (si no, un resultado del texto viejo
  // quedaba guardado con la version nueva y no se volvia a calcular).
  const text = document.getText();
  const version = document.version;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const inWorkspace = isWorkspaceDocument(document) && !!folder;
  const filePath = workspaceRelativePath(document.uri);
  const language = inferActiveLanguage(filePath, document.languageId);
  const files = inWorkspace ? indexFilesInFolderOf(index, document.uri) : [];
  const uris = new Map<string, string>();
  for (const entry of files) {
    if (entry.uri && !uris.has(entry.path)) {
      uris.set(entry.path, entry.uri);
    }
  }
  let deps = resolveFileDependencies({ activePath: filePath, language, text, files });
  if (inWorkspace && folder && (deps.probes.length || deps.expectedPaths.length)) {
    const extraPaths: string[] = [];
    const remember = (uri: vscode.Uri) => {
      const path = workspaceRelativePath(uri);
      if (!uris.has(path)) {
        uris.set(path, uri.toString());
      }
      extraPaths.push(path);
    };
    // Primero donde deberia estar (junto al archivo): una busqueda por nombre trae a lo sumo
    // unos cuantos y podia elegir el de otra carpeta.
    for (const path of deps.expectedPaths) {
      const uri = vscode.Uri.joinPath(folder.uri, ...path.split('/').filter(Boolean));
      if (await exists(uri)) {
        remember(uri);
      }
    }
    for (const name of deps.probes) {
      for (const uri of await probes.find(name, folder)) {
        remember(uri);
      }
    }
    if (extraPaths.length) {
      deps = resolveFileDependencies({ activePath: filePath, language, text, files, extraPaths });
    }
  }
  if (!inWorkspace) {
    deps = {
      ...deps,
      local: [],
      missing: [],
      dependents: [],
      probes: [],
      expectedPaths: [],
      // Un modulo de Python que no se encontro puede ser un archivo de al lado: no se adivina.
      libraries: deps.libraries.filter((item) => !item.guessed),
    };
  }
  return {
    uriString: document.uri.toString(),
    filePath,
    version,
    indexKey: indexKeyOf(index),
    deps,
    uris,
    partial: inWorkspace && (index?.capped ?? (index?.totalFiles || 0) >= ACTIVE_SUGGESTION_INDEX_MAX_FILES),
    outside: !inWorkspace,
  };
}
