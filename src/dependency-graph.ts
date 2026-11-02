// ADACEEN (VS Code): grafo de dependencias del proyecto («Ver diagrama») y clases del mismo paquete usadas sin import.
// Movido sin cambios desde src/file-dependencies.ts (solo se agrego "export" y los imports).
import { dependencyFamily } from './dependency-parse';
import { stemOf, dirnameOf, ProjectFiles, THIRD_PARTY_SEGMENT, normalizePath } from './dependency-project-files';
import type { ResolveOptions } from './dependency-project-files';
import { resolveImport } from './dependency-resolve';
import type { DependencyFamily, ParsedImport, DependencyIndexFile, ProjectDependencyGraph } from './file-dependencies';

// ---------------------------------------------------------------------------------------------
// Java y C#: clases que se usan sin import

/** Java y C#: las clases del mismo paquete (o del proyecto) se usan sin import. */
export function usesTypesWithoutImport(family: DependencyFamily) {
  return family === 'java' || family === 'csharp';
}

/**
 * A lo sumo cuantos imports de cada archivo del indice se resuelven para «La usan» y para el grafo:
 * 90 archivos con miles de #include tardaban segundos.
 */
export const MAX_IMPORTS_PER_INDEXED_FILE = 300;

/** Un archivo que puede usar clases sin importarlas: lo que nombra, sus imports y su paquete. */
export type ImplicitUser = {
  path: string;
  family: DependencyFamily;
  /** Nombres que usa (identificadores del codigo, o typeRefs del indice). */
  names: Set<string>;
  imports: ParsedImport[];
  /** Java: su linea package ('' si no tiene). */
  javaPackage: string;
};

/** Un archivo del indice como ImplicitUser: lo que nombra son sus typeRefs. */
export function implicitUserOf(file: DependencyIndexFile, path: string, family: DependencyFamily): ImplicitUser {
  return { path, family, names: new Set(file.typeRefs || []), imports: file.imports || [], javaPackage: file.javaPackage || '' };
}

/**
 * Java y C#: ¿`user` usa sin import la clase que declara `targetPath`? Java: del mismo paquete
 * (en cualquier carpeta de fuentes: src/main/java y src/test/java) o de la misma carpeta si no se
 * sabe el paquete; C#: de todo el proyecto. Una clase importada de otro paquete con el mismo
 * nombre no cuenta (el import manda).
 */
export function usesImplicitly(user: ImplicitUser, targetPath: string, targetPackage: string) {
  if (!usesTypesWithoutImport(user.family) || targetPath === user.path) {
    return false;
  }
  const name = stemOf(targetPath);
  if (!/^\p{Lu}/u.test(name) || name === stemOf(user.path) || !user.names.has(name)) {
    return false;
  }
  if (user.imports.some((imp) => imp.specifier.slice(imp.specifier.lastIndexOf('.') + 1) === name)) {
    return false;
  }
  return user.family === 'csharp'
    || dirnameOf(targetPath) === dirnameOf(user.path)
    || (!!user.javaPackage && user.javaPackage === targetPackage);
}

/**
 * Las clases del proyecto que `user` usa sin import (usesImplicitly). La usan el cuadro
 * «Dependencias» (lo que usa el archivo activo) y el grafo de «Ver diagrama» (0.0.38: antes el
 * grafo no las tenia y un proyecto Java de un solo paquete salia casi sin flechas).
 */
export function implicitLocalDependencies(user: ImplicitUser, project: ProjectFiles): string[] {
  if (!usesTypesWithoutImport(user.family)) {
    return [];
  }
  const candidates = user.family === 'java'
    ? [...new Set([...(user.javaPackage ? project.javaPackages.get(user.javaPackage) || [] : []), ...project.filesInDir(dirnameOf(user.path), '.java')])]
    : project.paths.filter((path) => path.toLowerCase().endsWith('.cs'));
  return candidates.filter((path) => usesImplicitly(user, path, project.entries.get(path)?.javaPackage || ''));
}

const MAX_GRAPH_FILES = 400;
const MAX_GRAPH_MISSING = 60;

/**
 * Lo que usa cada archivo del proyecto, con la misma lectura que el cuadro «Dependencias»
 * (resolveImport sobre un solo ProjectFiles). Sin busqueda en el disco: quien llama pasa en
 * `files` todos los archivos de codigo que encontro (no el indice de 90 del tutor).
 */
export function resolveProjectDependencyGraph(input: { files: DependencyIndexFile[]; buildFiles?: string[] }): ProjectDependencyGraph {
  const files = (input.files || []).slice(0, MAX_GRAPH_FILES);
  const project = new ProjectFiles(files, [], input.buildFiles || []);
  const graph: ProjectDependencyGraph = { files: [], edges: [], missing: [], libraries: [] };
  const libraries = new Map<string, { label: string; description: string; users: Set<string> }>();
  const edgeKeys = new Set<string>();
  for (const file of files) {
    const path = normalizePath(file.path);
    const family = dependencyFamily(file.language || '', path);
    if (family === 'none' || THIRD_PARTY_SEGMENT.test(path)) {
      continue;
    }
    graph.files.push(path);
    const refs = new Set(file.typeRefs || []);
    const options: ResolveOptions = { uses: (name) => refs.has(name), hints: true, ownPackage: file.javaPackage };
    const missingHere = new Set<string>();
    const addEdge = (to: string) => {
      const key = `${path}\n${to}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        graph.edges.push({ from: path, to });
      }
    };
    for (const imp of (file.imports || []).slice(0, MAX_IMPORTS_PER_INDEXED_FILE)) {
      for (const item of resolveImport(imp, path, family, project, options)) {
        if (item.type === 'local' && item.path && item.path !== path) {
          addEdge(item.path);
        } else if (item.type === 'library') {
          const entry = libraries.get(item.label) || { label: item.label, description: item.description || '', users: new Set<string>() };
          entry.users.add(path);
          libraries.set(item.label, entry);
        } else if (item.type === 'missing' && !missingHere.has(item.label) && graph.missing.length < MAX_GRAPH_MISSING) {
          missingHere.add(item.label);
          graph.missing.push({ from: path, label: item.label, line: imp.line, hint: item.hint || '' });
        }
      }
    }
    // Java y C#: las clases del mismo paquete (o del proyecto) que usa sin import.
    implicitLocalDependencies(implicitUserOf(file, path, family), project).forEach(addEdge);
  }
  graph.libraries = [...libraries.values()]
    .map((entry) => ({ label: entry.label, description: entry.description, count: entry.users.size }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  return graph;
}
