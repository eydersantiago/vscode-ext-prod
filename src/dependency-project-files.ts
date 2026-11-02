// ADACEEN (VS Code): rutas del proyecto (ProjectFiles), nombres parecidos y lo que comparte cada resolutor de imports.
// Movido sin cambios desde src/file-dependencies.ts (solo se agrego "export" y los imports).
import type { DependencyIndexFile } from './file-dependencies';

export const MAX_ITEMS_PER_GROUP = 40;

// ---------------------------------------------------------------------------------------------
// Rutas

export function normalizePath(path: string) {
  return String(path || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

export function dirnameOf(path: string) {
  const clean = normalizePath(path);
  const index = clean.lastIndexOf('/');
  return index >= 0 ? clean.slice(0, index) : '';
}

export function basenameOf(path: string) {
  const clean = normalizePath(path);
  return clean.slice(clean.lastIndexOf('/') + 1);
}

export function stemOf(path: string) {
  return basenameOf(path).replace(/\.[^.]+$/, '');
}

/** dir + rel con "." y ".."; null si sale de la carpeta abierta. */
export function joinPath(dir: string, rel: string): string | null {
  const parts = normalizePath(dir).split('/').filter(Boolean);
  for (const segment of String(rel || '').replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (!parts.length) {
        return null;
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

function sharedPrefix(left: string, right: string) {
  const a = left.split('/').filter(Boolean);
  const b = right.split('/').filter(Boolean);
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) {
    count += 1;
  }
  return count;
}

/**
 * Distancia de edicion con trasposiciones («turtel» esta a 1 de «turtle», «reqeusts» a 1 de
 * «requests») y con tope: mas alla de `max` devuelve max + 1.
 */
export function editDistance(left: string, right: string, max: number) {
  if (Math.abs(left.length - right.length) > max) {
    return max + 1;
  }
  let before: number[] = [];
  let previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        value = Math.min(value, before[j - 2] + 1);
      }
      current[j] = value;
      best = Math.min(best, value);
    }
    if (best > max) {
      return max + 1;
    }
    before = previous;
    previous = current;
  }
  return previous[right.length];
}

export type Found = { path: string; caseMismatch: boolean };

/** Carpetas de paquetes instalados: lo que hay ahi nunca es «de tu proyecto». */
export const THIRD_PARTY_SEGMENT = /(?:^|\/)(?:site-packages|dist-packages|node_modules|__pycache__|\.git|\.venv|venv|_deps)\//;

/** ¿La ruta es de un paquete instalado (un .py de .venv abierto con F12)? Se trata como de afuera. */
export function isThirdPartyPath(path: string) {
  return THIRD_PARTY_SEGMENT.test(normalizePath(path));
}

/** Ruta de `fromDir` a `target` ("../include/figura.h"). */
export function relativeFrom(fromDir: string, target: string) {
  const from = normalizePath(fromDir).split('/').filter(Boolean);
  const to = normalizePath(target).split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) {
    common += 1;
  }
  return [...Array.from({ length: from.length - common }, () => '..'), ...to.slice(common)].join('/');
}

/** Las carpetas de `dir` hacia arriba: "a/b" -> ["a/b", "a", ""]. */
export function ancestorsOf(dir: string) {
  const parts = normalizePath(dir).split('/').filter(Boolean);
  const out: string[] = [];
  for (let length = parts.length; length >= 0; length -= 1) {
    out.push(parts.slice(0, length).join('/'));
  }
  return out;
}

/** Un nombre con las tildes compuestas (NFC): «lógica» escrita en el editor y la creada por macOS. */
function composed(text: string) {
  return /[^\x00-\x7f]/.test(text) ? text.normalize('NFC') : text;
}

/** Para comparar sin mirar mayusculas ni la forma de las tildes. */
function foldPath(text: string) {
  return composed(text).toLowerCase();
}

/** Los archivos del proyecto (indice mas lo que encontro la busqueda en el disco). */
export class ProjectFiles {
  private readonly exact = new Set<string>();
  private readonly lower = new Map<string, string>();
  private readonly byBase = new Map<string, string[]>();
  /** Nombre compuesto (NFC) -> ruta, para los nombres descompuestos que crea macOS (lo\u0301gica.h). */
  private readonly composedPaths = new Map<string, string>();
  readonly entries = new Map<string, DependencyIndexFile>();
  readonly paths: string[] = [];
  /** Carpetas con pom.xml, build.gradle o settings.gradle (cada proyecto Maven o Gradle). */
  private readonly javaProjectDirs = new Set<string>();
  private readonly suggestions = new Map<string, string>();
  /** Cuantos «¿Quisiste decir...?» se calculan por vuelta (el cuadro muestra a lo sumo 40). */
  private suggestBudget = MAX_ITEMS_PER_GROUP * 2;
  /** C#: espacio de nombres -> archivos que lo declaran. */
  readonly namespaces = new Map<string, string[]>();
  /** Java: paquete -> archivos. */
  readonly javaPackages = new Map<string, string[]>();
  /** Carpetas con un archivo de compilacion de C/C++ (CMakeLists.txt, Makefile...). */
  readonly cProjectDirs = new Set<string>();

  constructor(files: DependencyIndexFile[], extraPaths: string[], buildFiles: string[] = []) {
    const add = (raw: string) => {
      const path = normalizePath(raw);
      if (!path || this.exact.has(path) || THIRD_PARTY_SEGMENT.test(path)) {
        return false;
      }
      this.exact.add(path);
      this.paths.push(path);
      const folded = foldPath(path);
      if (!this.lower.has(folded)) {
        this.lower.set(folded, path);
      }
      if (composed(path) !== path && !this.composedPaths.has(composed(path))) {
        this.composedPaths.set(composed(path), path);
      }
      const base = foldPath(basenameOf(path));
      const list = this.byBase.get(base) || [];
      list.push(path);
      this.byBase.set(base, list);
      return true;
    };
    for (const file of files) {
      const path = normalizePath(file.path);
      if (add(file.path) && !this.entries.has(path)) {
        this.entries.set(path, file);
      }
    }
    extraPaths.forEach(add);
    const known = [...this.paths, ...buildFiles.map(normalizePath)];
    for (const path of known) {
      if (/(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/i.test(path)) {
        this.javaProjectDirs.add(dirnameOf(path));
      }
      if (/(?:^|\/)(?:CMakeLists\.txt|[Mm]akefile|GNUmakefile|meson\.build|build\.ninja|compile_commands\.json|[^/]+\.vcxproj)$/.test(path)) {
        this.cProjectDirs.add(dirnameOf(path));
      }
    }
    for (const [path, file] of this.entries) {
      // Del indice (0.0.36) o, si no viene, de la estructura ("3: namespace Taller.Modelo {").
      const declared = file.namespaces
        || [...String(file.outline || '').matchAll(/^\d+:\s*namespace\s+([\p{L}_][\p{L}\p{N}_.]*)/gmu)].map((match) => match[1]);
      for (const name of declared) {
        const list = this.namespaces.get(name) || [];
        list.push(path);
        this.namespaces.set(name, list);
      }
      if (file.javaPackage) {
        const list = this.javaPackages.get(file.javaPackage) || [];
        list.push(path);
        this.javaPackages.set(file.javaPackage, list);
      }
    }
  }

  find(path: string | null): Found | null {
    if (!path) {
      return null;
    }
    if (this.exact.has(path)) {
      return { path, caseMismatch: false };
    }
    const same = this.composedPaths.get(composed(path));
    if (same) {
      return { path: same, caseMismatch: false };
    }
    const loose = this.lower.get(foldPath(path));
    return loose ? { path: loose, caseMismatch: composed(loose) !== composed(path) } : null;
  }

  /** El primero que exista de una lista de rutas (primero igual, despues sin mirar mayusculas). */
  findFirst(paths: Array<string | null>): Found | null {
    const clean = paths.filter((path): path is string => !!path);
    for (const path of clean) {
      if (this.exact.has(path)) {
        return { path, caseMismatch: false };
      }
    }
    for (const path of clean) {
      const found = this.find(path);
      if (found) {
        return found;
      }
    }
    return null;
  }

  /** Un archivo cuya ruta termina en `suffix` ("modelo/Figura.java"), el mas cercano a `nearDir`. */
  findSuffix(suffix: string, nearDir: string): Found | null {
    const clean = normalizePath(suffix);
    if (!clean) {
      return null;
    }
    const candidates = this.byBase.get(foldPath(basenameOf(clean))) || [];
    const target = composed(clean);
    const exact = candidates.filter((path) => composed(path) === target || composed(path).endsWith(`/${target}`));
    if (exact.length) {
      return { path: this.nearest(exact, nearDir), caseMismatch: false };
    }
    const lowerSuffix = foldPath(clean);
    const loose = candidates.filter((path) => foldPath(path) === lowerSuffix || foldPath(path).endsWith(`/${lowerSuffix}`));
    return loose.length ? { path: this.nearest(loose, nearDir), caseMismatch: true } : null;
  }

  /** De varias rutas, la mas cercana a `nearDir` (mas carpetas en comun, despues la mas corta). */
  nearest(list: string[], nearDir: string) {
    // A igual distancia, la de una carpeta de codigo (src/, include/, headers/...) antes que una
    // copia en old/ o respaldo/ (antes ganaba la primera por orden alfabetico).
    const conventional = (path: string) => (PREFERRED_DIR.test(path) ? 0 : 1);
    return [...list].sort((left, right) =>
      sharedPrefix(dirnameOf(right), nearDir) - sharedPrefix(dirnameOf(left), nearDir)
      || conventional(left) - conventional(right)
      || left.split('/').length - right.split('/').length
      || left.localeCompare(right))[0];
  }

  /** Archivos de una carpeta (sin subcarpetas) con una extension. */
  filesInDir(dir: string, extension: string) {
    const clean = normalizePath(dir);
    return this.paths.filter((path) => dirnameOf(path) === clean && path.toLowerCase().endsWith(extension));
  }

  /** Los .py dentro de una carpeta (un paquete sin __init__.py tambien es un paquete). */
  pythonFilesUnder(dir: string | null) {
    if (dir === null) {
      return [];
    }
    const prefix = dir ? `${normalizePath(dir)}/` : '';
    return prefix ? this.paths.filter((path) => path.startsWith(prefix) && path.endsWith('.py')) : [];
  }

  /** Carpetas que terminan en `dirSuffix` ("modelo" o "com/uni/modelo") con archivos .java. */
  javaFilesUnder(dirSuffix: string) {
    const clean = normalizePath(dirSuffix);
    return this.paths.filter((path) => {
      const dir = dirnameOf(path);
      return path.endsWith('.java') && (dir === clean || dir.endsWith(`/${clean}`));
    });
  }

  /** Otro archivo con ese nombre en cualquier carpeta (para «Está en ...»). */
  elsewhere(name: string, nearDir: string, except: string[] = []) {
    const list = (this.byBase.get(foldPath(basenameOf(name))) || []).filter((path) => !except.includes(path));
    return list.length ? this.nearest(list, nearDir) : '';
  }

  /** Archivos dentro de `root` (o de todo el proyecto si root es '') cuya ruta termina en `suffix`. */
  under(root: string, suffix: string, nearDir: string): Found | null {
    const clean = composed(normalizePath(suffix));
    const prefix = root ? `${normalizePath(root)}/` : '';
    const list = (this.byBase.get(foldPath(basenameOf(clean))) || [])
      .filter((path) => (!prefix || path.startsWith(prefix)) && (composed(path) === clean || composed(path).endsWith(`/${clean}`)));
    return list.length ? { path: this.nearest(list, nearDir), caseMismatch: false } : null;
  }

  /** La carpeta de arriba mas cercana con un archivo de compilacion de C/C++ ('' si es la raiz; null si no hay). */
  cProjectRoot(fromDir: string) {
    return ancestorsOf(fromDir).find((dir) => this.cProjectDirs.has(dir)) ?? null;
  }

  /**
   * La carpeta de arriba mas cercana con un proyecto Maven o Gradle (null si no hay). Antes un
   * pom.xml en cualquier parte volvia «biblioteca» lo no encontrado de una carpeta de javac.
   */
  javaBuildRoot(fromDir: string) {
    return ancestorsOf(fromDir).find((dir) => this.javaProjectDirs.has(dir)) ?? null;
  }

  /**
   * «¿Quisiste decir ...?»: el archivo de nombre mas parecido (misma extension o mismo nombre),
   * sin `except` (el archivo activo: en Lista.h, un Lista.tpp que falta no es «src/Lista.h»).
   */
  suggest(name: string, extensions: RegExp, except = ''): string {
    const key = `${name}\n${extensions.source}\n${except}`;
    const cached = this.suggestions.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (this.suggestBudget <= 0) {
      return '';
    }
    this.suggestBudget -= 1;
    const result = this.closest(name, extensions, except);
    this.suggestions.set(key, result);
    return result;
  }

  private closest(name: string, extensions: RegExp, except: string): string {
    const target = foldPath(basenameOf(name));
    if (!target) {
      return '';
    }
    const targetStem = target.replace(/\.[^.]+$/, '');
    let best = '';
    let bestScore = Number.MAX_SAFE_INTEGER;
    const max = target.length >= 6 ? 2 : 1;
    for (const path of this.paths) {
      if (!extensions.test(path) || path === except) {
        continue;
      }
      const base = foldPath(basenameOf(path));
      const stem = base.replace(/\.[^.]+$/, '');
      const score = stem === targetStem && base !== target ? 0.5 : editDistance(base, target, max);
      if (score <= max && score < bestScore) {
        best = path;
        bestScore = score;
      }
    }
    return best ? `¿Quisiste decir «${best}»?` : '';
  }
}

/** Carpetas de codigo: a igual distancia se prefieren a una copia en otra carpeta. */
const PREFERRED_DIR = /(?:^|\/)(?:include|inc|headers|src|source|lib|app)\//i;

/**
 * Aviso de mayusculas: con la parte que se escribio distinta («Modelo/figura.h» con la carpeta
 * modelo/ dice «Se escribe «modelo/figura.h»», no el nombre del archivo, que estaba bien).
 */
function caseWarning(label: string, path: string) {
  if (basenameOf(path) === '__init__.py') {
    return `La carpeta se llama «${basenameOf(dirnameOf(path))}»: en Linux las mayúsculas cuentan.`;
  }
  const dotted = !label.includes('/') && label.includes('.') && /\.(?:py|java)$/i.test(path);
  const typed = (dotted ? label.replace(/^\.+/, '').split('.') : label.replace(/\\/g, '/').split('/'))
    .filter((part) => part && part !== '.' && part !== '..');
  const actual = path.split('/');
  if (typed.length > 1 && typed.length <= actual.length) {
    const tail = actual.slice(actual.length - typed.length);
    // Solo si lo distinto es una carpeta: si es el archivo, basta su nombre.
    if (typed.slice(0, -1).some((part, index) => part !== tail[index])) {
      return `Se escribe «${tail.join('/')}»: en Linux las mayúsculas cuentan.`;
    }
  }
  return `Se llama «${basenameOf(path)}»: en Linux las mayúsculas cuentan.`;
}

export type Resolved = {
  label: string;
  type: 'local' | 'library' | 'missing';
  path?: string;
  description?: string;
  warning?: string;
  hint?: string;
  /** Nombre de archivo para buscar en el disco si el indice no lo tiene. */
  probe?: string;
  /** Rutas exactas donde deberia estar (se comprueban en el disco antes de buscar por nombre). */
  expected?: string[];
  /** Biblioteca supuesta (un modulo de Python que no se encontro): fuera del proyecto no se muestra. */
  guessed?: boolean;
  names?: string[];
};

export type ResolveOptions = {
  /** ¿El archivo usa este nombre? (para expandir import a.b.*;). */
  uses: (name: string) => boolean;
  /** Calcular «¿Quisiste decir...?» (no hace falta para «La usan»). */
  hints: boolean;
  /** Java: el paquete del archivo que importa (una clase de un paquete parecido puede ser suya). */
  ownPackage?: string;
};

export function local(label: string, found: Found, warning?: string): Resolved {
  return { label, type: 'local', path: found.path, warning: found.caseMismatch ? caseWarning(label, found.path) : warning };
}
