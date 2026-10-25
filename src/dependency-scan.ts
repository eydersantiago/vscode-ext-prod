// ADACEEN (VS Code): dependencias del archivo activo con la API de vscode (0.0.36).
// La lectura y la resolucion estan en file-dependencies.ts (puro, con pruebas); aqui se junta
// el documento del editor, el indice del proyecto y una busqueda en el disco de lo que el
// indice no tiene (tope de 90 archivos y solo algunas extensiones: un .tpp o un .hh no estan).
import * as vscode from 'vscode';
import { ACTIVE_SUGGESTION_INDEX_MAX_FILES } from './constants';
import { isThirdPartyPath, resolveFileDependencies } from './file-dependencies';
import type { FileDependencies } from './file-dependencies';
import { resolveScanOptions } from './settings';
import { inferActiveLanguage } from './suggestion-results';
import type { WorkspaceProjectIndex, WorkspaceProjectIndexEntry } from './types';

export type ActiveFileDependencies = {
  uriString: string;
  filePath: string;
  /** Lenguaje con el que se calculo (cambiarlo, un .tpp a C++, obliga a recalcular). */
  languageId: string;
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
  /** Codigo de un paquete instalado (.venv, node_modules) dentro de la carpeta: tampoco se compara. */
  packageCode: boolean;
};

/**
 * Lo encontrado en el disco vale hasta que el vigilante de archivos avisa que se creo o se borro
 * algo (entonces se borra todo). El tope de tiempo es solo por si un aviso se pierde: con 30 s,
 * escribir en un archivo con 8 #include sin resolver repetia 8 busquedas en todo el proyecto cada
 * 30 s (revision independiente del 25/10/2026).
 */
const DISK_CACHE_TTL_MS = 10 * 60_000;
/** Solo nombres de archivo simples (letras de cualquier idioma: lógica.h) y el ".*" de JS. */
const PROBE_NAME = /^[\p{L}\p{N}_.+@-]+(?:\.\*)?$/u;

/** ¿El archivo es de esa carpeta del proyecto y no de otra abierta adentro de ella? */
function inFolder(uri: vscode.Uri, folder: vscode.WorkspaceFolder) {
  return vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === folder.uri.toString();
}

/**
 * Lo que encontro la busqueda en el disco, por carpeta y nombre, y si existen las rutas exactas
 * que se miraron. Cada `clear()` cambia la generacion: una busqueda que empezo antes no guarda
 * su respuesta (si no, un archivo creado mientras se buscaba seguia «sin encontrar»).
 */
export class DependencyProbeCache {
  private readonly entries = new Map<string, { at: number; uris: vscode.Uri[] }>();
  private readonly files = new Map<string, { at: number; exists: boolean }>();
  private generation = 0;

  clear() {
    this.entries.clear();
    this.files.clear();
    this.generation += 1;
  }

  /** Archivos con ese nombre dentro de `folder` (la carpeta del proyecto del archivo activo). */
  async find(name: string, folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
    if (!PROBE_NAME.test(name)) {
      return [];
    }
    const key = `${folder.uri.toString()}|${name}`;
    const cached = this.entries.get(key);
    if (cached && Date.now() - cached.at < DISK_CACHE_TTL_MS) {
      return cached.uris;
    }
    const generation = this.generation;
    let uris: vscode.Uri[] = [];
    try {
      uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, `**/${name}`),
        new vscode.RelativePattern(folder, resolveScanOptions(undefined).excludeGlob),
        20,
      );
      uris = uris.filter((uri) => inFolder(uri, folder));
    } catch {
      uris = [];
    }
    if (generation === this.generation) {
      this.entries.set(key, { at: Date.now(), uris });
    }
    return uris;
  }

  /** ¿Existe y es un archivo? (`#include "modelo/"` a medio escribir no es la carpeta modelo). */
  async isFile(uri: vscode.Uri): Promise<boolean> {
    const key = uri.toString();
    const cached = this.files.get(key);
    if (cached && Date.now() - cached.at < DISK_CACHE_TTL_MS) {
      return cached.exists;
    }
    const generation = this.generation;
    let exists = false;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      exists = (stat.type & vscode.FileType.File) !== 0;
    } catch {
      exists = false;
    }
    if (generation === this.generation) {
      this.files.set(key, { at: Date.now(), exists });
    }
    return exists;
  }
}

/**
 * Archivos de compilacion o de proyecto por carpeta (CMakeLists.txt, Makefile, pom.xml,
 * build.gradle...): no estan en el indice (no son codigo) y dicen donde empieza cada proyecto.
 */
const BUILD_FILES_GLOB = '**/{CMakeLists.txt,Makefile,makefile,GNUmakefile,meson.build,build.ninja,compile_commands.json,*.vcxproj,pom.xml,build.gradle,build.gradle.kts,settings.gradle,settings.gradle.kts,pyproject.toml,setup.py,Gemfile}';

export class BuildFileCache {
  private readonly entries = new Map<string, { at: number; paths: string[] }>();
  private generation = 0;

  clear() {
    this.entries.clear();
    this.generation += 1;
  }

  async list(folder: vscode.WorkspaceFolder): Promise<string[]> {
    const key = folder.uri.toString();
    const cached = this.entries.get(key);
    if (cached && Date.now() - cached.at < DISK_CACHE_TTL_MS) {
      return cached.paths;
    }
    const generation = this.generation;
    let paths: string[] = [];
    try {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, BUILD_FILES_GLOB),
        new vscode.RelativePattern(folder, resolveScanOptions(undefined).excludeGlob),
        60,
      );
      paths = uris.filter((uri) => inFolder(uri, folder)).map((uri) => workspaceRelativePath(uri));
    } catch {
      paths = [];
    }
    if (generation === this.generation) {
      this.entries.set(key, { at: Date.now(), paths });
    }
    return paths;
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
 * un clic abria el archivo de la otra carpeta y «La usan» lo repetia. Se mira la carpeta mas
 * interna de cada archivo: con `curso` y `curso/taller2` abiertas, lo de taller2 es de taller2.
 */
export function indexFilesInFolderOf(index: WorkspaceProjectIndex | null, uri: vscode.Uri): WorkspaceProjectIndexEntry[] {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!index || !folder) {
    return [];
  }
  if ((vscode.workspace.workspaceFolders || []).length <= 1) {
    return index.files;
  }
  return index.files.filter((entry) => {
    if (!entry.uri) {
      return false;
    }
    try {
      return inFolder(vscode.Uri.parse(entry.uri), folder);
    } catch {
      return false;
    }
  });
}

/**
 * ¿El documento es un archivo del proyecto? No uno sin guardar, ni de otra parte, ni el codigo
 * de un paquete instalado (un .py de .venv abierto con F12): esos solo muestran sus bibliotecas.
 */
export function isWorkspaceDocument(document: vscode.TextDocument) {
  return !document.isUntitled
    && !!vscode.workspace.getWorkspaceFolder(document.uri)
    && !isThirdPartyPath(workspaceRelativePath(document.uri));
}

/**
 * Dependencias del documento. Un archivo fuera de la carpeta abierta (o sin guardar) no se
 * compara con el proyecto: sus #include "x" quedarian como «no encontrados» aunque existan al
 * lado en el disco, asi que solo se muestran sus bibliotecas conocidas. `isCurrent` dice si el
 * calculo todavia hace falta (si ya se pidio otro, no se sigue buscando en el disco).
 */
export async function computeActiveFileDependencies(
  document: vscode.TextDocument,
  index: WorkspaceProjectIndex | null,
  probes: DependencyProbeCache,
  buildFiles: BuildFileCache,
  isCurrent: () => boolean = () => true,
): Promise<ActiveFileDependencies> {
  // El texto y su version juntos, antes de esperar nada (si no, un resultado del texto viejo
  // quedaba guardado con la version nueva y no se volvia a calcular).
  const text = document.getText();
  const version = document.version;
  const languageId = document.languageId;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const inWorkspace = isWorkspaceDocument(document) && !!folder;
  const filePath = workspaceRelativePath(document.uri);
  const packageCode = !document.isUntitled && !!folder && isThirdPartyPath(filePath);
  const language = inferActiveLanguage(filePath, document.languageId);
  const files = inWorkspace ? indexFilesInFolderOf(index, document.uri) : [];
  const uris = new Map<string, string>();
  for (const entry of files) {
    if (entry.uri && !uris.has(entry.path)) {
      uris.set(entry.path, entry.uri);
    }
  }
  const projectFiles = inWorkspace && folder ? await buildFiles.list(folder) : [];
  let deps = resolveFileDependencies({ activePath: filePath, language, text, files, buildFiles: projectFiles });
  if (inWorkspace && folder && (deps.probes.length || deps.expectedPaths.length) && isCurrent()) {
    const extraPaths: string[] = [];
    const remember = (uri: vscode.Uri) => {
      if (!inFolder(uri, folder)) {
        return; // de una carpeta abierta dentro de esta: su ruta relativa es de la otra
      }
      const path = workspaceRelativePath(uri);
      if (!uris.has(path)) {
        uris.set(path, uri.toString());
      }
      extraPaths.push(path);
    };
    // Primero donde deberia estar (junto al archivo): una busqueda por nombre trae a lo sumo
    // unos cuantos y podia elegir el de otra carpeta.
    for (const path of deps.expectedPaths) {
      if (!isCurrent()) {
        break;
      }
      const uri = vscode.Uri.joinPath(folder.uri, ...path.split('/').filter(Boolean));
      if (await probes.isFile(uri)) {
        remember(uri);
      }
    }
    for (const name of deps.probes) {
      if (!isCurrent()) {
        break;
      }
      for (const uri of await probes.find(name, folder)) {
        remember(uri);
      }
    }
    if (extraPaths.length) {
      deps = resolveFileDependencies({ activePath: filePath, language, text, files, extraPaths, buildFiles: projectFiles });
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
    languageId,
    version,
    indexKey: indexKeyOf(index),
    deps,
    uris,
    partial: inWorkspace && (index?.capped ?? (index?.totalFiles || 0) >= ACTIVE_SUGGESTION_INDEX_MAX_FILES),
    outside: !inWorkspace,
    packageCode,
  };
}
