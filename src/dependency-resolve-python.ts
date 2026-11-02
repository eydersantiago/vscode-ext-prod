// ADACEEN (VS Code): resolucion de los import de Python: modulos y paquetes del proyecto, biblioteca estandar y nombres mal escritos.
// Movido sin cambios desde src/file-dependencies.ts (solo se agrego "export" y los imports).
import { PY_STDLIB, PY_DESCRIPTIONS, PY_WARNINGS, PY_THIRD_PARTY, PY_ALWAYS_BUILTIN, PY_LINUX_BUILTIN } from './dependency-libraries';
import { editDistance, ProjectFiles, basenameOf, dirnameOf, joinPath, local, ancestorsOf, stemOf } from './dependency-project-files';
import type { Resolved, Found, ResolveOptions } from './dependency-project-files';
import type { ParsedImport } from './file-dependencies';

export function pythonLibrary(spec: string): Resolved | null {
  const top = spec.split('.')[0];
  if (PY_STDLIB.has(top)) {
    return { label: spec, type: 'library', description: PY_DESCRIPTIONS[spec] || PY_DESCRIPTIONS[top] || 'biblioteca estándar de Python', warning: PY_WARNINGS[top] };
  }
  // Con las mayusculas exactas: `import Numpy` falla en todos los equipos («¿Quisiste decir...?»).
  const third = PY_THIRD_PARTY[top];
  return third ? { label: spec, type: 'library', description: third } : null;
}

/**
 * Un modulo de Python o un paquete conocido a una letra (o a dos letras cambiadas de lugar) del
 * nombre: casi siempre un error de tipeo (`import maths`, `Tkinter`, `reqeusts`). Antes no se
 * comparaba con los paquetes de pip, y `reqeusts` salia como «instálalo con pip» (un paquete con
 * ese nombre puede ser malicioso).
 */
const PY_TYPO_CACHE = new Map<string, string>();

function pythonTypo(name: string) {
  if (name.length < 4) {
    return '';
  }
  const cached = PY_TYPO_CACHE.get(name);
  if (cached !== undefined) {
    return cached;
  }
  if (PY_TYPO_CACHE.size > 5000) {
    PY_TYPO_CACHE.clear();
  }
  const best = closestPythonModule(name);
  PY_TYPO_CACHE.set(name, best);
  return best;
}

function closestPythonModule(name: string) {
  const lower = name.toLowerCase();
  const max = name.length >= 9 ? 2 : 1;
  let best = '';
  let bestScore = max + 1;
  for (const candidate of [...PY_STDLIB, ...Object.keys(PY_THIRD_PARTY)]) {
    if (candidate === name || candidate.startsWith('_')) {
      continue;
    }
    const score = editDistance(candidate.toLowerCase(), lower, max);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore <= max ? best : '';
}

/**
 * `from paquete import a, b` con paquete/__init__.py: a y b pueden ser modulos (paquete/a.py).
 * Antes se mostraba solo el __init__.py (casi siempre vacio) y «La usan» de a.py no veia el import.
 */
function packageSubmodules(found: Found, names: string[], label: string, project: ProjectFiles): Resolved[] | null {
  if (basenameOf(found.path) !== '__init__.py' || !names.length) {
    return null;
  }
  const dir = dirnameOf(found.path);
  const modules = names
    .map((name) => ({ name, found: project.findFirst([joinPath(dir, `${name}.py`), joinPath(dir, `${name}/__init__.py`)]) }))
    .filter((item): item is { name: string; found: Found } => !!item.found);
  if (!modules.length) {
    return null;
  }
  const others = names.filter((name) => !modules.some((item) => item.name === name));
  return [
    ...modules.map((item) => local(`${label}${label.endsWith('.') ? '' : '.'}${item.name}`, item.found)),
    ...(others.length ? [{ ...local(label, found), names: others }] : []),
  ];
}

/**
 * Python busca un `import x` junto al archivo que se ejecuta, en la carpeta desde donde se
 * ejecuta (la raiz del proyecto con `python -m`) y en `src/`. Lo que esta en otra carpeta no
 * se importa (ModuleNotFoundError): el cuadro lo marca como no encontrado y dice donde esta.
 */
export function resolvePython(imp: ParsedImport, fromPath: string, project: ProjectFiles, options: ResolveOptions): Resolved[] {
  const spec = imp.specifier;
  const fromDir = dirnameOf(fromPath);
  // from x import a, b: a y b son lo que usa de x (salvo que sean modulos: entonces son archivos).
  const names = imp.names.filter((name) => name !== '*');
  const findModule = (base: string | null) => (base === null
    ? null
    : project.findFirst([`${base}.py`, joinPath(base, '__init__.py')]));
  if (imp.kind === 'relative') {
    const dots = (/^\.+/.exec(spec) || ['.'])[0].length;
    const rest = spec.slice(dots);
    const base = joinPath(fromDir, Array.from({ length: dots - 1 }, () => '..').join('/'));
    if (base === null) {
      return [{ label: spec, type: 'missing', description: 'La ruta sale de la carpeta abierta en VS Code.' }];
    }
    const modulePath = rest ? joinPath(base, rest.replace(/\./g, '/')) : base;
    if (rest) {
      const found = findModule(modulePath);
      if (found) {
        return packageSubmodules(found, names, spec, project) || [{ ...local(spec, found), names }];
      }
    }
    // from . import a, b  /  from .paquete import modulo: cada nombre puede ser un modulo.
    const modules = names
      .map((name) => ({ name, found: findModule(joinPath(modulePath || '', name)) }))
      .filter((item): item is { name: string; found: Found } => !!item.found);
    if (modules.length) {
      return modules.map((item) => local(`${spec}${rest ? '.' : ''}${item.name}`, item.found));
    }
    const init = !rest ? project.find(joinPath(base, '__init__.py')) : null;
    if (init) {
      return [{ ...local(spec, init), names }];
    }
    const folder = rest ? project.pythonFilesUnder(modulePath) : [];
    if (folder.length) {
      return [{ label: spec, type: 'local', path: project.nearest(folder, fromDir), description: 'paquete de tu proyecto (carpeta)', names }];
    }
    const missingName = rest.split('.').pop() || names[0] || '';
    return [{
      label: spec,
      type: 'missing',
      description: 'Revisa el nombre y la carpeta.',
      hint: options.hints && missingName ? project.suggest(`${missingName}.py`, /\.py$/i, fromPath) : '',
      probe: missingName ? `${missingName}.py` : undefined,
      expected: modulePath && rest ? [`${modulePath}.py`] : undefined,
    }];
  }
  const asPath = spec.replace(/\./g, '/');
  // Junto al archivo y en cada carpeta de arriba (python -m desde la carpeta del proyecto, pytest,
  // Django en backend/), tambien en su src/. Lo de una carpeta hermana no se importa.
  const roots = [...new Set(ancestorsOf(fromDir).flatMap((dir) => [dir, joinPath(dir, 'src') || 'src']))];
  const found = project.findFirst(roots.flatMap((root) => [joinPath(root, `${asPath}.py`), joinPath(root, `${asPath}/__init__.py`)]));
  if (found) {
    const top = spec.split('.')[0];
    const ownName = stemOf(found.path) === '__init__' ? basenameOf(dirnameOf(found.path)) : stemOf(found.path);
    if (ownName === top && (PY_ALWAYS_BUILTIN.has(top) || PY_LINUX_BUILTIN.has(top))) {
      // time.py no tapa a time: Python usa el suyo (y en Linux tambien el de math, zlib...).
      const file = basenameOf(found.path) === '__init__.py' ? `${ownName}/` : basenameOf(found.path);
      return [{
        ...(pythonLibrary(spec) || { label: spec, type: 'library' as const, description: 'biblioteca estándar de Python' }),
        warning: PY_ALWAYS_BUILTIN.has(top)
          ? `Python usa su módulo «${top}», no tu ${file}: cámbiale el nombre a tu archivo.`
          : `Tu ${file} se llama como el módulo «${top}» de Python: en Linux se usa el de Python y en otros equipos el tuyo. Cámbiale el nombre.`,
      }];
    }
    const submodules = packageSubmodules(found, names, spec, project);
    if (submodules) {
      return submodules;
    }
    // random.py o turtle.py del estudiante tapan el modulo de Python del mismo nombre.
    const shadowed = ownName === top && pythonLibrary(top)
      ? `Tapa el módulo «${top}» de Python: si querías ese, cámbiale el nombre.`
      : undefined;
    return [{ ...local(spec, found, shadowed), names }];
  }
  // from paquete import modulo
  const submodules = names
    .map((name) => ({ name, found: project.findFirst(roots.map((root) => joinPath(root, `${asPath}/${name}.py`))) }))
    .filter((item): item is { name: string; found: Found } => !!item.found);
  if (submodules.length) {
    return submodules.map((item) => local(`${spec}.${item.name}`, item.found));
  }
  // Paquete sin __init__.py (una carpeta con modulos).
  const folder = roots.map((root) => project.pythonFilesUnder(joinPath(root, asPath))).find((list) => list.length) || [];
  if (folder.length) {
    return [{ label: spec, type: 'local', path: project.nearest(folder, fromDir), description: 'paquete de tu proyecto (carpeta)', names }];
  }
  const library = pythonLibrary(spec);
  if (library) {
    return [library];
  }
  const top = spec.split('.')[0];
  const lastName = `${asPath.split('/').pop()}.py`;
  const other = project.elsewhere(lastName, fromDir);
  if (other) {
    return [{
      label: spec,
      type: 'missing',
      description: 'Está en otra carpeta.',
      hint: `Está en «${other}»: Python solo lo encuentra junto al archivo que ejecutas.`,
      probe: lastName,
      expected: [joinPath(fromDir, `${asPath}.py`) || `${asPath}.py`],
    }];
  }
  if (options.hints) {
    // Un nombre casi igual a un modulo tuyo, de Python o de un paquete conocido es casi siempre
    // un error de tipeo.
    const own = project.suggest(`${top}.py`, /\.py$/i, fromPath);
    const std = own ? '' : pythonTypo(top);
    if (own || std) {
      return [{
        label: spec,
        type: 'missing',
        description: 'No está en tu proyecto ni es un módulo de Python.',
        hint: own || `¿Quisiste decir «${std}»?`,
        probe: `${top}.py`,
        expected: [joinPath(fromDir, `${asPath}.py`) || `${asPath}.py`],
      }];
    }
  }
  return [{
    label: spec,
    type: 'library',
    description: 'paquete externo: si Python no lo encuentra, instálalo con pip',
    probe: `${top}.py`,
    expected: [joinPath(fromDir, `${asPath}.py`) || `${asPath}.py`],
    guessed: true,
  }];
}
