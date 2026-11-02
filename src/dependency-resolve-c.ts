// ADACEEN (VS Code): resolucion de los #include de C/C++: archivos del proyecto y del ejercicio, la -I que haria falta y la biblioteca estandar.
// Movido sin cambios desde src/file-dependencies.ts (solo se agrego "export" y los imports).
import { C_HEADERS, C_HEADER_WARNINGS, cLibraryDescription } from './dependency-libraries';
import { ProjectFiles, joinPath, ancestorsOf, normalizePath, dirnameOf, relativeFrom, local, basenameOf } from './dependency-project-files';
import type { ResolveOptions, Resolved, Found } from './dependency-project-files';
import type { ParsedImport } from './file-dependencies';

const C_HEADER_FILES = /\.(?:h|hh|hpp|hxx|h\+\+|inl|ipp|tpp|txx)$/i;
const C_SOURCE_FILES = /\.(?:c|cc|cpp|cxx|c\+\+)$/i;
const C_FAMILY_FILES = /\.(?:h|hh|hpp|hxx|inl|ipp|tpp|txx|c|cc|cpp|cxx)$/i;

/**
 * #include "x": donde lo busca el compilador. Junto al archivo; en `include/` o `inc/` de esa
 * carpeta o de una de arriba; y en una carpeta de arriba. Sin CMakeLists.txt ni Makefile, lo que
 * no esta junto al archivo solo compila con -I (el cuadro lo avisa). Lo que esta en otra carpeta
 * cualquiera no cuenta como encontrado: es el error que el cuadro tiene que mostrar.
 */
function findCInclude(spec: string, fromDir: string, project: ProjectFiles) {
  const near = project.findFirst([joinPath(fromDir, spec)]);
  if (near) {
    return { found: near, via: 'same' as const };
  }
  const ancestors = ancestorsOf(fromDir);
  const included = project.findFirst(ancestors.flatMap((dir) => [joinPath(dir, `include/${spec}`), joinPath(dir, `inc/${spec}`)]));
  if (included) {
    return { found: included, via: 'include' as const };
  }
  const above = project.findFirst(ancestors.slice(1).map((dir) => joinPath(dir, spec)));
  return above ? { found: above, via: 'above' as const } : null;
}

/** Encabezados precompilados de Visual Studio: un proyecto copiado de Windows los incluye. */
const C_VISUAL_STUDIO_HEADERS = new Set(['stdafx.h', 'pch.h']);

/** Carpetas de codigo dentro de un ejercicio: la carpeta del ejercicio es la de arriba. */
const C_CODE_DIRS = new Set(['src', 'source', 'sources', 'test', 'tests', 'app', 'lib', 'include', 'inc', 'headers']);

/**
 * La carpeta del ejercicio de `fromDir` (sin archivo de compilacion): lo de antes de su primera
 * carpeta de codigo (`ejercicio/src/modelo` -> `ejercicio`) o la carpeta misma (`semana3/taller2`).
 * Antes era la primera carpeta del proyecto, y `semana3/taller1/figura.h` contaba como del mismo
 * ejercicio que `semana3/taller2/main.cpp` (revision independiente del 25/10/2026).
 */
function cExerciseRoot(fromDir: string) {
  const parts = normalizePath(fromDir).split('/').filter(Boolean);
  const index = parts.findIndex((part) => C_CODE_DIRS.has(part.toLowerCase()));
  return (index >= 0 ? parts.slice(0, index) : parts).join('/');
}

/** La carpeta que hay que pasar con -I (relativa a la del ejercicio) para que `spec` se encuentre en `path`. */
function cIncludeFlag(path: string, spec: string, root: string) {
  const includeDir = path.slice(0, Math.max(0, path.length - spec.length)).replace(/\/$/, '');
  const flagDir = root && includeDir.startsWith(`${root}/`)
    ? includeDir.slice(root.length + 1)
    : includeDir === root ? '.' : includeDir;
  return { includeDir: includeDir || '.', flagDir: flagDir || '.' };
}

export function resolveC(imp: ParsedImport, fromPath: string, project: ProjectFiles, options: ResolveOptions): Resolved[] {
  const written = imp.specifier.trim();
  const spec = written.replace(/\\/g, '/');
  const backslashWarning = spec !== written ? `En Linux usa / en la ruta: #include "${spec}".` : undefined;
  const lower = spec.toLowerCase();
  const known = C_HEADERS[lower];
  // Dentro de `#ifdef _WIN32` (o de otra macro de plataforma), windows.h o conio.h son a proposito.
  const warning = imp.platformGuarded ? undefined : C_HEADER_WARNINGS[lower];
  const fromDir = dirnameOf(fromPath);
  const explicitRelative = /^\.{1,2}\//.test(spec);
  const relative = joinPath(fromDir, spec);
  // Con CMakeLists.txt o Makefile, sus -I encuentran lo del proyecto; sin ellos, el ejercicio.
  const projectRoot = project.cProjectRoot(fromDir);
  const exerciseRoot = projectRoot ?? cExerciseRoot(fromDir);
  // <Vector> o <String> pasan en Windows y macOS, no en Linux.
  const caseWarning = !imp.platformGuarded && known && spec !== lower && !C_HEADER_WARNINGS[lower]
    ? `En Linux se escribe en minúsculas: #include <${lower}>.`
    : undefined;
  const flagWarning = (path: string) => {
    const { includeDir, flagDir } = cIncludeFlag(path, spec, exerciseRoot);
    return `Está en «${includeDir}»: compila con -I${flagDir} o escribe #include "${relativeFrom(fromDir, path)}".`;
  };
  // Si se encontro lejos del archivo, se mira tambien junto a el en el disco: el indice puede no
  // tener la copia de al lado (tope de 90 archivos) y se abria la de otra carpeta.
  const besides = (found: Found) => (dirnameOf(found.path) !== fromDir && relative && relative !== found.path ? [relative] : undefined);
  if (imp.kind === 'angle') {
    if (known) {
      return [{ label: spec, type: 'library', description: known, warning: warning || caseWarning }];
    }
    const library = cLibraryDescription(spec);
    if (library) {
      return [{ label: spec, type: 'library', description: library }];
    }
    // <figura.h> de tu proyecto: junto al archivo, o en el proyecto con CMake o Makefile, basta
    // cambiar a comillas; sin ellos, tampoco compila sin -I.
    const own = findCInclude(spec, fromDir, project);
    const found = own?.found || project.under(exerciseRoot, spec, fromDir);
    if (found) {
      const needsFlag = projectRoot === null && own?.via !== 'same';
      return [{
        ...local(spec, found, needsFlag
          ? `Es tuyo: escribe #include "${relativeFrom(fromDir, found.path)}" o compila con -I${cIncludeFlag(found.path, spec, exerciseRoot).flagDir}.`
          : `Es tuyo: inclúyelo con comillas, #include "${spec}".`),
        expected: besides(found),
      }];
    }
    // Se mira junto al archivo en el disco: un figura.h de al lado que el indice no tiene (tope de
    // 90 archivos) no es una biblioteca.
    return [{ label: spec, type: 'library', description: 'biblioteca del sistema o externa', expected: relative ? [relative] : undefined }];
  }
  if (relative === null) {
    return [{ label: spec, type: 'missing', description: 'La ruta sale de la carpeta abierta en VS Code.' }];
  }
  const own = explicitRelative
    ? (() => {
      const found = project.find(relative);
      return found ? { found, via: 'same' as const } : null;
    })()
    : findCInclude(spec, fromDir, project);
  if (own) {
    const source = C_SOURCE_FILES.exec(own.found.path);
    const placement = projectRoot !== null || own.via === 'same'
      ? undefined
      : own.via === 'above'
        ? `Está en una carpeta de arriba: escribe #include "${relativeFrom(fromDir, own.found.path)}" o compila con -I.`
        : flagWarning(own.found.path);
    return [{
      ...local(spec, own.found, backslashWarning
        || placement
        || (source ? `Incluir un ${source[0]} suele dar «multiple definition»: incluye su .h.` : undefined)),
      expected: besides(own.found),
    }];
  }
  if (known) {
    return [{ label: spec, type: 'library', description: known, warning: warning || caseWarning }];
  }
  if (!explicitRelative) {
    // En el mismo proyecto (o ejercicio) pero en otra carpeta: con CMakeLists.txt o Makefile sus
    // -I lo encuentran; sin ellos, solo compila agregando -I. Lo de la carpeta de otro ejercicio
    // (taller1 desde taller2) sigue siendo «No encontrado».
    const inProject = project.under(exerciseRoot, spec, fromDir);
    if (inProject) {
      return [{
        ...local(spec, inProject, backslashWarning || (projectRoot !== null ? undefined : flagWarning(inProject.path))),
        expected: besides(inProject),
      }];
    }
  }
  const library = cLibraryDescription(spec);
  if (library) {
    return [{ label: spec, type: 'library', description: library }];
  }
  if (C_VISUAL_STUDIO_HEADERS.has(lower)) {
    return [{
      label: spec,
      type: 'missing',
      description: 'Es de Visual Studio (encabezado precompilado).',
      hint: 'Con g++ no hace falta: borra esta línea.',
      expected: [relative],
      probe: basenameOf(spec),
    }];
  }
  // En otra carpeta: el compilador no lo encuentra, pero el estudiante si sabe donde esta.
  const other = project.elsewhere(spec, fromDir, [fromPath]);
  if (other) {
    const sameFolder = dirnameOf(other) === fromDir; // "../figura.h" con figura.h al lado
    return [{
      label: spec,
      type: 'missing',
      description: sameFolder ? 'Está en esta misma carpeta.' : 'Está en otra carpeta.',
      hint: sameFolder ? `Escribe #include "${basenameOf(other)}".` : `Está en «${other}»: escribe #include "${relativeFrom(fromDir, other)}".`,
      expected: [relative],
      probe: basenameOf(spec),
    }];
  }
  return [{
    label: spec,
    type: 'missing',
    description: 'Revisa el nombre y la carpeta.',
    hint: options.hints ? project.suggest(spec, C_HEADER_FILES.test(spec) ? C_HEADER_FILES : C_SOURCE_FILES.test(spec) ? C_SOURCE_FILES : C_FAMILY_FILES, fromPath) : '',
    probe: basenameOf(spec),
    expected: [relative],
  }];
}
