// ADACEEN (VS Code): lo que lee «Ver diagrama» del proyecto (0.0.38), con la API de vscode.
//
// Busca el diagrama de clases del taller (docs/diagrama-clases.puml o el .puml que mas se le
// parezca; si no hay, un `classDiagram` de Mermaid en un .md de docs/ o de la raiz) y lee los
// archivos de codigo del proyecto para comparar (source-classes.ts) y para el grafo de archivos
// (resolveProjectDependencyGraph). Nada sale del equipo; igual se respetan las reglas del
// escaneo: sin archivos de claves (scan-privacy.ts), sin lo de adaceen.scan.excludeGlob y sin
// paquetes instalados (.venv, node_modules). La lectura y la comparacion son puras y estan
// probadas (class-diagram.ts, source-classes.ts, diagram-model.ts).
import * as vscode from 'vscode';
import { extractMermaidClassDiagram, parseMermaidClassDiagram, parsePlantUmlClassDiagram, pickDiagramFile } from './class-diagram';
import type { ClassDiagram } from './class-diagram';
import { workspaceRelativePath } from './dependency-scan';
import type { BuildFileCache } from './dependency-scan';
import { compareDiagram, EMPTY_DIAGRAM_NOTE, NO_DIAGRAM_NOTE } from './diagram-model';
import type { DiagramTargetView } from './diagram-model';
import { collectJavaPackage, collectNamespaces, collectTypeReferences, dependencyFamily, isThirdPartyPath, parseImports, resolveProjectDependencyGraph } from './file-dependencies';
import type { DependencyIndexFile, ProjectDependencyGraph } from './file-dependencies';
import { isSecretPath } from './scan-privacy';
import { resolveScanOptions } from './settings';
import { extractSourceClasses, mergeSourceClasses } from './source-classes';
import type { SourceClass } from './source-classes';
import { decodeSourceBytes } from './source-text';
import { inferActiveLanguage } from './suggestion-results';

const SOURCE_GLOB = '**/*.{h,hh,hpp,hxx,c,cc,cpp,cxx,tpp,ipp,inl,java,py,cs,ts,tsx,js,jsx,mjs,cjs}';
const DIAGRAM_GLOB = '**/*.{puml,plantuml,pu,iuml,wsd}';
const MARKDOWN_GLOB = '{*.md,docs/**/*.md,doc/**/*.md}';
const MAX_SOURCE_FILES = 300;
const MAX_DIAGRAM_FILES = 40;
const MAX_MARKDOWN_FILES = 20;
const MAX_DIAGRAM_BYTES = 512 * 1024;

export type DiagramScanResult = {
  target: DiagramTargetView | null;
  /** Por que no hay diagrama ('' si lo hay). */
  targetNote: string;
  graph: ProjectDependencyGraph;
  /** Carpeta del proyecto que se leyo (para saber que archivo activo es de ella). */
  folderUri: string;
  /** Ruta relativa -> URI: lo unico que se puede abrir con un clic desde el panel. */
  uris: Map<string, string>;
};

/** El texto del archivo: del editor si esta abierto (con lo no guardado), si no del disco. */
async function readText(uri: vscode.Uri, openDocuments: Map<string, vscode.TextDocument>, maxBytes: number) {
  const open = openDocuments.get(uri.toString());
  if (open) {
    return { text: open.getText(), languageId: open.languageId };
  }
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > maxBytes) {
    return null;
  }
  return { text: decodeSourceBytes(await vscode.workspace.fs.readFile(uri)), languageId: '' };
}

function inFolder(uri: vscode.Uri, folder: vscode.WorkspaceFolder) {
  return vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === folder.uri.toString();
}

async function findInFolder(folder: vscode.WorkspaceFolder, glob: string, max: number) {
  const exclude = new vscode.RelativePattern(folder, resolveScanOptions(undefined).excludeGlob);
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, glob), exclude, max);
  return uris.filter((uri) => inFolder(uri, folder));
}

type FoundDiagram = { diagram: ClassDiagram; path: string };

/** El diagrama del taller: el .puml elegido por pickDiagramFile o, sin .puml, un Mermaid en un .md. */
async function findDiagram(folder: vscode.WorkspaceFolder, openDocuments: Map<string, vscode.TextDocument>, uris: Map<string, string>): Promise<FoundDiagram | null> {
  const diagrams = (await findInFolder(folder, DIAGRAM_GLOB, MAX_DIAGRAM_FILES))
    .filter((uri) => !isSecretPath(workspaceRelativePath(uri)) && !isThirdPartyPath(workspaceRelativePath(uri)));
  const byPath = new Map(diagrams.map((uri) => [workspaceRelativePath(uri), uri]));
  const picked = pickDiagramFile([...byPath.keys()]);
  if (picked) {
    const uri = byPath.get(picked) as vscode.Uri;
    const read = await readText(uri, openDocuments, MAX_DIAGRAM_BYTES);
    if (read) {
      uris.set(picked, uri.toString());
      return { diagram: parsePlantUmlClassDiagram(read.text), path: picked };
    }
  }
  const markdown = (await findInFolder(folder, MARKDOWN_GLOB, MAX_MARKDOWN_FILES))
    .filter((uri) => !isThirdPartyPath(workspaceRelativePath(uri)))
    .sort((left, right) => workspaceRelativePath(left).localeCompare(workspaceRelativePath(right)));
  for (const uri of markdown) {
    const read = await readText(uri, openDocuments, MAX_DIAGRAM_BYTES).catch(() => null);
    const source = read ? extractMermaidClassDiagram(read.text) : '';
    if (source) {
      const path = workspaceRelativePath(uri);
      uris.set(path, uri.toString());
      return { diagram: parseMermaidClassDiagram(source), path };
    }
  }
  return null;
}

/**
 * Lee el proyecto de la carpeta del archivo activo (o la primera abierta) y arma lo que muestra
 * el panel. Nunca lanza: un archivo que no se puede leer se salta (y se anota en `log`).
 */
export async function scanDiagram(options: {
  activeUri?: vscode.Uri;
  buildFiles: BuildFileCache;
  log?: (line: string) => void;
}): Promise<DiagramScanResult> {
  const uris = new Map<string, string>();
  const folder = (options.activeUri && vscode.workspace.getWorkspaceFolder(options.activeUri))
    || vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return {
      target: null,
      targetNote: NO_FOLDER_NOTE,
      graph: { files: [], edges: [], missing: [], libraries: [] },
      folderUri: '',
      uris,
    };
  }
  const openDocuments = new Map(vscode.workspace.textDocuments.map((document) => [document.uri.toString(), document]));
  const scanOptions = resolveScanOptions(undefined);

  const indexFiles: DependencyIndexFile[] = [];
  const classes: SourceClass[] = [];
  let sources: vscode.Uri[] = [];
  try {
    sources = await findInFolder(folder, SOURCE_GLOB, MAX_SOURCE_FILES);
  } catch (error) {
    options.log?.(`[Diagrama] No se pudo buscar el codigo del proyecto: ${String(error)}`);
  }
  sources.sort((left, right) => workspaceRelativePath(left).localeCompare(workspaceRelativePath(right)));
  for (const uri of sources) {
    const path = workspaceRelativePath(uri);
    if (isSecretPath(path) || isThirdPartyPath(path)) {
      continue;
    }
    try {
      const read = await readText(uri, openDocuments, scanOptions.maxFileBytes);
      if (!read) {
        continue;
      }
      const language = inferActiveLanguage(path, read.languageId);
      const family = dependencyFamily(language, path);
      uris.set(path, uri.toString());
      indexFiles.push({
        path,
        language,
        imports: parseImports(read.text, family),
        ...(family === 'java' || family === 'csharp' ? { typeRefs: collectTypeReferences(read.text, family) } : {}),
        ...(family === 'csharp' ? { namespaces: collectNamespaces(read.text, family) } : {}),
        ...(family === 'java' && collectJavaPackage(read.text, family) ? { javaPackage: collectJavaPackage(read.text, family) } : {}),
      });
      classes.push(...extractSourceClasses(read.text, path, language));
    } catch (error) {
      options.log?.(`[Diagrama] No se pudo leer ${path}: ${String(error)}`);
    }
  }

  let found: FoundDiagram | null = null;
  try {
    found = await findDiagram(folder, openDocuments, uris);
  } catch (error) {
    options.log?.(`[Diagrama] No se pudo leer el diagrama del taller: ${String(error)}`);
  }
  const buildFiles = await options.buildFiles.list(folder).catch(() => [] as string[]);
  const graph = resolveProjectDependencyGraph({ files: indexFiles, buildFiles });
  const target = found && found.diagram.classes.length
    ? compareDiagram(found.diagram, mergeSourceClasses(classes), found.path)
    : null;
  return {
    target,
    targetNote: target ? '' : found ? EMPTY_DIAGRAM_NOTE : NO_DIAGRAM_NOTE,
    graph,
    folderUri: folder.uri.toString(),
    uris,
  };
}

export const NO_FOLDER_NOTE = 'Abre la carpeta de tu taller para ver el diagrama y las dependencias.';

/** Ruta relativa del archivo activo si es de la carpeta que se leyo ('' si no). */
export function activePathIn(result: Pick<DiagramScanResult, 'folderUri'>, uri: vscode.Uri | undefined) {
  if (!uri || !result.folderUri) {
    return '';
  }
  return vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === result.folderUri ? workspaceRelativePath(uri) : '';
}
