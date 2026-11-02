// ADACEEN (VS Code): dependencias del archivo activo (0.0.36), sin importar vscode.
//
// Pedido del 25/10/2026: «que muestre un cuadro con las dependencias del archivo». La vista
// «Este archivo» muestra lo que usa el archivo activo (#include, import, require, using),
// separado en:
//   - lo que es del proyecto (se abre con un clic), con las clases y funciones que usa de ahi;
//   - las bibliotecas, con una linea de para que sirven;
//   - lo que no se encontro (el error mas comun: el nombre o la carpeta no coinciden), con el
//     archivo de nombre parecido si lo hay;
//   - los archivos del proyecto que lo usan a el.
// No compila nada: lee el texto (sin comentarios) y resuelve las rutas contra el indice del
// proyecto que ya arma la extension (workspace-index.ts). Se prueba con node:test.
// Aqui quedan los tipos y el armado del cuadro; el resto esta en dependency-*.ts (libraries,
// source-mask, parse, project-files, resolve, resolve-c, resolve-python, graph).

import { usesTypesWithoutImport, implicitLocalDependencies, MAX_IMPORTS_PER_INDEXED_FILE, usesImplicitly, implicitUserOf } from './dependency-graph';
import type { ImplicitUser } from './dependency-graph';
import { lineOfIndex, parseImports, lineStartsOf, dependencyFamily } from './dependency-parse';
import { MAX_ITEMS_PER_GROUP, ProjectFiles, basenameOf, normalizePath, stemOf } from './dependency-project-files';
import type { ResolveOptions, Resolved } from './dependency-project-files';
import { resolveImport } from './dependency-resolve';
import { pythonLibrary } from './dependency-resolve-python';
import { codeOnly, collectIdentifiers, collectJavaPackage, collectNamespaces, collectTypeReferences } from './dependency-source-mask';

export type DependencyFamily = 'c' | 'python' | 'java' | 'js' | 'ruby' | 'csharp' | 'none';

/**
 * quoted / angle: #include "x" y #include <x>. module: import a.b, using X, require 'x'.
 * relative: from .x import y, './x', require_relative. wildcard: import a.b.*; (Java).
 */
export type ImportKind = 'quoted' | 'angle' | 'module' | 'relative' | 'wildcard';

export type ParsedImport = {
  /** Como esta escrito: "figura.h", "iostream", "modelo.Figura", "./util/formato", "..utils". */
  specifier: string;
  /** Linea del archivo (1-based). */
  line: number;
  kind: ImportKind;
  /** Nombres que trae: from x import a, b / import { a } from './x' / import static ...C.m. */
  names: string[];
  /**
   * C/C++: dentro de un `#ifdef _WIN32 ... #else ... #endif` (o de otra macro de plataforma):
   * `#include <windows.h>` ahi es a proposito y no lleva el aviso de Linux.
   */
  platformGuarded?: boolean;
};

export type FileDependencyItem = {
  /** Lo que se muestra: el import tal cual (o el nombre del archivo en «La usan»). */
  label: string;
  /** Linea del import en el archivo (0: sin import, por ejemplo una clase del mismo paquete). */
  line: number;
  /** Ruta relativa del archivo del proyecto (en «Usa de tu proyecto» y «La usan»). */
  path?: string;
  description?: string;
  /** Clases y funciones de ese archivo que usa el activo. */
  symbols?: string[];
  /** Algo que conviene revisar aunque se haya encontrado (mayusculas, conio.h en Linux...). */
  warning?: string;
  /** «¿Quisiste decir ...?» en lo que no se encontro. */
  hint?: string;
  /** Sin import: clase del mismo paquete (Java) o del mismo proyecto (C#). */
  implicit?: boolean;
  /** Biblioteca supuesta (un modulo de Python que no se encontro en el proyecto). */
  guessed?: boolean;
};

export type FileDependencies = {
  family: DependencyFamily;
  local: FileDependencyItem[];
  libraries: FileDependencyItem[];
  missing: FileDependencyItem[];
  dependents: FileDependencyItem[];
  /**
   * Nombres de archivo a buscar en el disco antes de dar algo por no encontrado: el indice
   * tiene a lo sumo 90 archivos y solo algunas extensiones (un .tpp o un .hh no estan).
   */
  probes: string[];
  /** Rutas exactas donde deberia estar lo no encontrado (se comprueban antes de buscar por nombre). */
  expectedPaths: string[];
};

/** Entrada del indice del proyecto que sirve para resolver (workspace-index.ts). */
export type DependencyIndexFile = {
  path: string;
  language?: string;
  outline?: string;
  imports?: ParsedImport[];
  /** Nombres con mayuscula que usa el archivo (Java y C#: clases del mismo paquete sin import). */
  typeRefs?: string[];
  /** C#: espacios de nombres que declara (tambien los de archivo, `namespace X;`). */
  namespaces?: string[];
  /** Java: su linea package (las clases del mismo paquete se usan sin import, en cualquier carpeta). */
  javaPackage?: string;
};

export type DependencyInput = {
  /** Ruta relativa del archivo activo, con "/". */
  activePath: string;
  language: string;
  text: string;
  files: DependencyIndexFile[];
  /** Rutas que existen aunque no esten en el indice (lo que encontro la busqueda en el disco). */
  extraPaths?: string[];
  /**
   * Archivos de compilacion o de proyecto de la carpeta (CMakeLists.txt, Makefile, pom.xml,
   * build.gradle, pyproject.toml...): el indice no los tiene (no son codigo) y dicen donde
   * empieza cada proyecto.
   */
  buildFiles?: string[];
};

const MAX_PROBES = 8;
const MAX_SYMBOLS = 4;
const MAX_IMPORTS = 2000;

// ---------------------------------------------------------------------------------------------
// Que usa de cada archivo del proyecto

const GENERIC_NAMES = new Set(['main', 'init', 'constructor', 'toString', 'equals', 'hashCode', 'function', 'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'extends', 'implements']);

/** Clases y funciones declaradas en la estructura de un archivo ("12: class Figura {"). */
export function declaredNames(outline: string) {
  const names = new Map<string, 'type' | 'function'>();
  for (const raw of String(outline || '').split('\n')) {
    const text = raw.replace(/^\s*\d+:\s?/, '').trim();
    if (!text || /^(?:#|import\b|from\b|require|using\b|package\b|\(\d+ declaracion)/.test(text) || /\boperator\b/.test(text)) {
      continue;
    }
    const type = /\b(?:class|struct|interface|enum(?:\s+class)?|union|record|module)\s+([\p{L}_][\p{L}\p{N}_]*)/u.exec(text);
    if (type && !GENERIC_NAMES.has(type[1])) {
      names.set(type[1], 'type');
      continue;
    }
    const def = /^(?:async\s+)?def\s+([\p{L}_][\p{L}\p{N}_]*)/u.exec(text);
    const call = def || /([\p{L}_~][\p{L}\p{N}_]*)\s*\(/u.exec(text);
    const name = call ? call[1] : '';
    if (!name || name.startsWith('~') || name.startsWith('__') || GENERIC_NAMES.has(name) || names.has(name)) {
      continue;
    }
    names.set(name, 'function');
  }
  return names;
}

function symbolsUsed(resolved: Resolved, entry: DependencyIndexFile | undefined, identifiers: Set<string>) {
  const out: string[] = [];
  for (const name of resolved.names || []) {
    if (!out.includes(name)) {
      out.push(name);
    }
  }
  if (!out.length && entry?.outline) {
    for (const [name, kind] of declaredNames(entry.outline)) {
      if (identifiers.has(name)) {
        out.push(kind === 'function' ? `${name}()` : name);
      }
    }
  }
  return out.slice(0, MAX_SYMBOLS);
}

/** Primera linea donde aparece `name` como palabra en el codigo (0 si no aparece). */
function firstUseLine(code: string, starts: number[], name: string, skip = -1) {
  // Bordes de palabra con tildes (\b no ve la ó de «Canción» como letra).
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}_$])${name.replace(/[$]/g, '\\$')}(?![\\p{L}\\p{N}_$])`, 'gu');
  for (const match of code.matchAll(pattern)) {
    const line = lineOfIndex(starts, (match.index || 0) + match[0].length - name.length);
    if (line !== skip) {
      return line;
    }
  }
  return 0;
}

/**
 * Lo que guarda el indice de un archivo para el cuadro «Dependencias» y el grafo (0.0.38: en un
 * solo sitio para workspace-index.ts y diagram-scan.ts): sus imports y, en Java y C#, las clases
 * que nombra, sus espacios de nombres y su paquete.
 */
export function dependencyIndexFields(text: string, family: DependencyFamily): Pick<DependencyIndexFile, 'imports' | 'typeRefs' | 'namespaces' | 'javaPackage'> {
  if (family === 'none') {
    return {};
  }
  const javaPackage = family === 'java' ? collectJavaPackage(text, family) : '';
  return {
    imports: parseImports(text, family),
    ...(usesTypesWithoutImport(family) ? { typeRefs: collectTypeReferences(text, family) } : {}),
    ...(family === 'csharp' ? { namespaces: collectNamespaces(text, family) } : {}),
    ...(javaPackage ? { javaPackage } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Todo junto

/**
 * Dependencias del archivo activo: lo que usa del proyecto, las bibliotecas, lo que no se
 * encontro y los archivos que lo usan (por sus imports, guardados en el indice).
 */
export function resolveFileDependencies(input: DependencyInput): FileDependencies {
  const activePath = normalizePath(input.activePath);
  const family = dependencyFamily(input.language, activePath);
  // El activo cuenta aunque el indice no lo tenga (archivo recien creado, o un proyecto de mas de
  // 90 archivos): si no, «La usan» no encontraba los #include que llegan a el.
  const project = new ProjectFiles(input.files || [], [...(input.extraPaths || []), activePath], input.buildFiles || []);
  const result: FileDependencies = { family, local: [], libraries: [], missing: [], dependents: [], probes: [], expectedPaths: [] };
  const probes = new Set<string>();
  const expected = new Set<string>();
  const text = String(input.text || '');
  const activePackage = collectJavaPackage(text, family);

  if (family !== 'none') {
    const identifiers = collectIdentifiers(text, family);
    const options: ResolveOptions = { uses: (name) => identifiers.has(name), hints: true, ownPackage: activePackage };
    const seen = new Set<string>();
    // A lo sumo 2000 imports (el cuadro muestra 40 por grupo); el mismo import repetido se
    // resuelve una vez (un archivo con miles de `import nada` tardaba mas de un segundo).
    const imports = parseImports(text, family).slice(0, MAX_IMPORTS);
    const resolvedByImport = new Map<string, Resolved[]>();
    const resolveOnce = (imp: ParsedImport) => {
      const key = `${imp.kind}\n${imp.specifier}\n${imp.names.join(',')}\n${imp.platformGuarded ? 1 : 0}`;
      let resolved = resolvedByImport.get(key);
      if (!resolved) {
        resolved = resolveImport(imp, activePath, family, project, options);
        resolvedByImport.set(key, resolved);
      }
      return resolved;
    };
    for (const imp of imports) {
      for (const item of resolveOnce(imp)) {
        if (item.type === 'local' && item.path === activePath) {
          // turtle.py con `import turtle` se importa a si mismo: el error clasico de nombrar el
          // archivo como la biblioteca. Se muestra la biblioteca con el aviso.
          const library = family === 'python' ? pythonLibrary(imp.specifier) : null;
          if (library) {
            if (!seen.has(`library:${library.label}`)) {
              seen.add(`library:${library.label}`);
              result.libraries.push({
                label: library.label,
                line: imp.line,
                description: library.description || '',
                warning: `«import ${imp.specifier.split('.')[0]}» importa este mismo archivo (${basenameOf(activePath)}), no la biblioteca: cámbiale el nombre.`,
              });
            }
            continue;
          }
          // #include "figura.h" dentro de figura.h, o `import main` en main.py (que lo vuelve a
          // ejecutar): antes se omitia sin decir nada.
          if (!seen.has(`self:${activePath}`)) {
            seen.add(`self:${activePath}`);
            result.local.push({
              label: item.label,
              line: imp.line,
              path: activePath,
              warning: family === 'c'
                ? 'Se incluye a sí mismo: borra esta línea.'
                : family === 'python'
                  ? 'Se importa a sí mismo: el archivo se ejecuta dos veces. Borra esta línea.'
                  : 'Se importa a sí mismo: borra esta línea.',
            });
          }
          continue;
        }
        // Un mismo archivo escrito de dos formas ("figura.h" y "./figura.h") va una vez.
        const key = item.type === 'local'
          ? (item.description || !item.path ? `package:${item.label}` : `local:${item.path}`)
          : `${item.type}:${item.label}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        if (item.probe && item.type !== 'local') {
          probes.add(item.probe);
        }
        // Tambien de lo encontrado lejos del archivo (C/C++): se comprueba junto a el en el disco.
        (item.expected || []).forEach((path) => expected.add(path));
        const base: FileDependencyItem = { label: item.label, line: imp.line };
        if (item.type === 'local') {
          const symbols = symbolsUsed(item, item.path ? project.entries.get(item.path) : undefined, identifiers);
          result.local.push({
            ...base,
            path: item.path,
            ...(item.description ? { description: item.description } : {}),
            ...(symbols.length ? { symbols } : {}),
            ...(item.warning ? { warning: item.warning } : {}),
          });
        } else if (item.type === 'library') {
          result.libraries.push({
            ...base,
            description: item.description || '',
            ...(item.warning ? { warning: item.warning } : {}),
            ...(item.guessed ? { guessed: true } : {}),
          });
        } else {
          result.missing.push({ ...base, description: item.description || '', ...(item.hint ? { hint: item.hint } : {}) });
        }
      }
    }

    // Java y C#: clases del mismo paquete (o del proyecto) que se usan sin import
    // (implicitLocalDependencies, la misma regla que el grafo de «Ver diagrama»).
    if (usesTypesWithoutImport(family)) {
      const code = codeOnly(text, family);
      const starts = lineStartsOf(code);
      const already = new Set(result.local.map((item) => item.path));
      const user: ImplicitUser = { path: activePath, family, names: identifiers, imports, javaPackage: activePackage };
      for (const path of implicitLocalDependencies(user, project)) {
        if (!already.has(path)) {
          result.local.push({ label: stemOf(path), line: firstUseLine(code, starts, stemOf(path)), path, implicit: true });
        }
      }
    }
  }

  // «La usan»: los archivos del proyecto cuyos imports llegan a este (o que lo usan sin import).
  for (const file of input.files || []) {
    const path = normalizePath(file.path);
    if (path === activePath) {
      continue;
    }
    const fileFamily = dependencyFamily(file.language || '', path);
    if (fileFamily === 'none') {
      continue;
    }
    const refs = new Set(file.typeRefs || []);
    const options: ResolveOptions = { uses: (name) => refs.has(name), hints: false };
    let line = -1;
    // A lo sumo 300 imports por archivo: 90 archivos con miles de #include tardaban segundos.
    for (const imp of (file.imports || []).slice(0, MAX_IMPORTS_PER_INDEXED_FILE)) {
      if (resolveImport(imp, path, fileFamily, project, options).some((item) => item.type === 'local' && item.path === activePath)) {
        line = imp.line;
        break;
      }
    }
    if (line < 0 && fileFamily === family
      && usesImplicitly(implicitUserOf(file, path, fileFamily), activePath, activePackage)) {
      line = 0;
    }
    if (line >= 0) {
      result.dependents.push({ label: basenameOf(path), line, path, ...(line === 0 ? { implicit: true } : {}) });
    }
  }

  const byLine = (left: FileDependencyItem, right: FileDependencyItem) => (left.line || Number.MAX_SAFE_INTEGER) - (right.line || Number.MAX_SAFE_INTEGER);
  result.local = result.local.sort(byLine).slice(0, MAX_ITEMS_PER_GROUP);
  result.libraries = result.libraries.sort(byLine).slice(0, MAX_ITEMS_PER_GROUP);
  result.missing = result.missing.sort(byLine).slice(0, MAX_ITEMS_PER_GROUP);
  result.dependents = result.dependents
    .sort((left, right) => (left.path || '').localeCompare(right.path || ''))
    .slice(0, MAX_ITEMS_PER_GROUP);
  result.probes = [...probes].slice(0, MAX_PROBES);
  result.expectedPaths = [...expected].slice(0, MAX_PROBES * 2);
  return result;
}

/**
 * Una linea para el resumen del tutor: lo que usa del proyecto, las bibliotecas y quien lo usa.
 * Lo no encontrado no va: el indice no tiene todos los archivos y el tutor podria decirle al
 * estudiante que falta un archivo que si existe (la vista lo confirma buscando en el disco).
 */
export function formatDependenciesForPrompt(deps: FileDependencies | null, maxChars = 600) {
  if (!deps) {
    return '';
  }
  const parts: string[] = [];
  if (deps.local.length) {
    // Un paquete o un espacio de nombres va por su nombre, no por el primer archivo que tiene.
    parts.push(`usa del proyecto ${deps.local.slice(0, 8).map((item) => `${item.description || !item.path ? item.label : item.path}${item.symbols?.length ? ` (${item.symbols.join(', ')})` : ''}`).join(', ')}`);
  }
  if (deps.libraries.length) {
    parts.push(`bibliotecas ${deps.libraries.slice(0, 10).map((item) => item.label).join(', ')}`);
  }
  if (deps.dependents.length) {
    parts.push(`lo usan ${deps.dependents.slice(0, 8).map((item) => item.path || item.label).join(', ')}`);
  }
  if (!parts.length) {
    return '';
  }
  const text = `Dependencias del archivo: ${parts.join('; ')}.`;
  return text.length > maxChars ? `${text.slice(0, maxChars - 2)}….` : text;
}

// ---------------------------------------------------------------------------------------------
// Grafo del proyecto (0.0.38, «Ver diagrama»)

export type ProjectDependencyGraph = {
  /** Archivos de codigo del proyecto (rutas relativas), en el orden del indice. */
  files: string[];
  /** De un archivo a otro del proyecto que incluye o importa. */
  edges: Array<{ from: string; to: string }>;
  /** Lo que un archivo incluye y no esta en el proyecto (ni es una biblioteca conocida). */
  missing: Array<{ from: string; label: string; line: number; hint: string }>;
  /** Bibliotecas, con cuantos archivos las usan. */
  libraries: Array<{ label: string; description: string; count: number }>;
};

