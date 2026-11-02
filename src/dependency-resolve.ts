// ADACEEN (VS Code): resolucion de los import de Java, JS/TS, Ruby y C#, y resolveImport, que elige el resolutor por lenguaje.
// Movido sin cambios desde src/file-dependencies.ts (solo se agrego "export" y los imports).
import { JAVA_CLASSES, JAVA_PACKAGES, JAVA_STD_PREFIX, JAVA_THIRD_PARTY_PREFIX, NODE_BUILTINS, NPM_KNOWN, RUBY_STD, CS_NAMESPACES } from './dependency-libraries';
import { ProjectFiles, dirnameOf, stemOf, local, joinPath, basenameOf, ancestorsOf } from './dependency-project-files';
import type { ResolveOptions, Resolved, Found } from './dependency-project-files';
import { resolveC } from './dependency-resolve-c';
import { resolvePython } from './dependency-resolve-python';
import type { ParsedImport, DependencyFamily } from './file-dependencies';

function javaLibraryDescription(spec: string) {
  if (JAVA_CLASSES[spec]) {
    return JAVA_CLASSES[spec];
  }
  const parts = spec.split('.');
  for (let length = parts.length; length > 0; length -= 1) {
    const prefix = parts.slice(0, length).join('.');
    if (JAVA_PACKAGES[prefix]) {
      return JAVA_PACKAGES[prefix];
    }
  }
  return JAVA_STD_PREFIX.test(spec) ? 'biblioteca estándar de Java' : 'biblioteca externa';
}

function resolveJava(imp: ParsedImport, fromPath: string, project: ProjectFiles, options: ResolveOptions): Resolved[] {
  const spec = imp.specifier;
  const fromDir = dirnameOf(fromPath);
  if (imp.kind === 'wildcard') {
    const classes = [...new Set([...(project.javaPackages.get(spec) || []), ...project.javaFilesUnder(spec.replace(/\./g, '/'))])];
    if (classes.length) {
      const used = classes.filter((path) => options.uses(stemOf(path)));
      return used.length
        ? used.map((path) => local(`${spec}.${stemOf(path)}`, { path, caseMismatch: false }))
        : [{ label: `${spec}.*`, type: 'local', path: project.nearest(classes, fromDir), description: `${classes.length} clase(s) de tu proyecto` }];
    }
    if (JAVA_STD_PREFIX.test(`${spec}.`) || JAVA_THIRD_PARTY_PREFIX.test(spec) || project.javaBuildRoot(fromDir) !== null) {
      return [{ label: `${spec}.*`, type: 'library', description: javaLibraryDescription(spec) }];
    }
    return [{ label: `${spec}.*`, type: 'missing', description: 'No hay una carpeta con ese paquete en tu proyecto.' }];
  }
  const className = spec.slice(spec.lastIndexOf('.') + 1);
  const packageName = spec.includes('.') ? spec.slice(0, spec.lastIndexOf('.')) : '';
  // Por su linea package (cualquier carpeta de fuentes: src/main/java, src/test/java) o por la ruta.
  const byPackage = (project.javaPackages.get(packageName) || []).filter((path) => stemOf(path) === className);
  const found = byPackage.length
    ? { path: project.nearest(byPackage, fromDir), caseMismatch: false }
    : project.findSuffix(`${spec.replace(/\./g, '/')}.java`, fromDir);
  if (found) {
    return [local(spec, found)];
  }
  // import modelo.Carta.Palo; (un enum o una clase dentro de Carta): el archivo es Carta.java.
  const parts = spec.split('.');
  for (let length = parts.length - 1; length >= 1; length -= 1) {
    const outer = parts[length - 1];
    if (!/^\p{Lu}/u.test(outer)) {
      break; // los paquetes van en minusculas
    }
    const outerPackage = parts.slice(0, length - 1).join('.');
    const byOuter = (project.javaPackages.get(outerPackage) || []).filter((path) => stemOf(path) === outer);
    const nested = byOuter.length
      ? { path: project.nearest(byOuter, fromDir), caseMismatch: false }
      : project.findSuffix(`${parts.slice(0, length).join('/')}.java`, fromDir);
    if (nested) {
      return [local(spec, nested)];
    }
  }
  if (JAVA_STD_PREFIX.test(spec) || JAVA_THIRD_PARTY_PREFIX.test(spec)) {
    return [{ label: spec, type: 'library', description: javaLibraryDescription(spec) }];
  }
  const elsewhere = project.findSuffix(`${className}.java`, fromDir);
  if (elsewhere) {
    return [{
      label: spec,
      type: 'missing',
      description: 'El paquete no coincide con la carpeta de la clase.',
      hint: `Está en «${elsewhere.path}»: revisa su línea package o el import.`,
    }];
  }
  const buildRoot = project.javaBuildRoot(fromDir);
  if (buildRoot !== null) {
    // En un proyecto Maven o Gradle grande una clase tuya puede no estar en el indice (90
    // archivos): si su paquete empieza como el del archivo, se busca en el disco antes.
    const likelyOwn = !!options.ownPackage && options.ownPackage.split('.')[0] === parts[0];
    return [{
      label: spec,
      type: 'library',
      description: 'dependencia del proyecto (Maven o Gradle)',
      ...(likelyOwn
        ? { probe: `${className}.java`, expected: [joinPath(buildRoot, `src/main/java/${parts.join('/')}.java`) || `${parts.join('/')}.java`] }
        : {}),
    }];
  }
  return [{
    label: spec,
    type: 'missing',
    description: 'Revisa el nombre y el paquete.',
    hint: options.hints ? project.suggest(`${className}.java`, /\.java$/i, fromPath) : '',
    probe: `${className}.java`,
  }];
}

/** Sin extension escrita, solo modulos de codigo (`./util` no es util.css). */
const JS_SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
const JS_FILES = /\.(?:[cm]?[jt]sx?|json|vue|svelte|css|scss|sass|less|html)$/i;
const JS_SCRIPT_FILES = /\.(?:[cm]?[jt]sx?|json)$/i;

function findJsFile(base: string, project: ProjectFiles): Found | null {
  const hasExtension = /\.[^/.]+$/.test(base);
  const direct = project.find(base);
  if (direct && hasExtension) {
    return direct;
  }
  // TypeScript con ESM escribe './modulo.js' aunque el archivo sea modulo.ts.
  if (/\.(?:[cm]?js|jsx)$/i.test(base)) {
    const swapped = project.findFirst(['.ts', '.tsx', '.mts', '.cts'].map((extension) => base.replace(/\.(?:[cm]?js|jsx)$/i, extension)));
    if (swapped) {
      return swapped;
    }
  }
  return project.findFirst([
    ...JS_SCRIPT_EXTENSIONS.map((extension) => `${base}${extension}`),
    `${base}.d.ts`,
    ...JS_SCRIPT_EXTENSIONS.slice(0, 8).map((extension) => `${base}/index${extension}`),
  ]) || direct;
}

/** Archivos que se importan por su nombre completo en JS (imagenes, fuentes, textos). */
const JS_ASSET_FILES = /\.(?:png|jpe?g|gif|svg|webp|ico|bmp|avif|mp3|wav|ogg|mp4|webm|woff2?|ttf|otf|eot|txt|md|csv|xml|ya?ml|wasm|glsl)$/i;

/**
 * ¿La ruta trae extension? `./usuario.routes` o `./auth.service` no: el archivo es
 * usuario.routes.ts (antes se buscaba en el disco un archivo llamado «usuario.routes»).
 */
function hasJsExtension(path: string) {
  return JS_FILES.test(path) || JS_ASSET_FILES.test(path);
}

/** './App' con App.vue: webpack (Vue CLI) lo encuentra; Vite pide la extension. */
function findComponentFile(base: string, project: ProjectFiles): Found | null {
  return hasJsExtension(base) ? null : project.findFirst([`${base}.vue`, `${base}.svelte`]);
}

/** Paquetes de npm que se importan por partes ('firebase/app'): nunca son un archivo del proyecto. */
const NPM_SUBPATH_PACKAGES = new Set(['firebase', 'rxjs', 'date-fns', 'three', 'bootstrap', 'swiper', 'react-icons', 'chart.js', 'primereact', 'antd', 'dayjs', 'i18next', 'yup', 'zod', 'sweetalert2', 'leaflet', 'd3', 'echarts', 'next', 'nuxt', 'vue-router', 'pinia', 'vuex', 'redux', 'react-router-dom', 'socket.io-client', 'highlight.js', 'katex', 'codemirror', 'monaco-editor']);

/**
 * Organizaciones de npm conocidas: '@vue/test-utils' es un paquete aunque el proyecto tenga una
 * carpeta vue/ (un alias como '@components/Boton' no esta en esta lista).
 */
const NPM_SCOPES = new Set(['@types', '@angular', '@vue', '@babel', '@mui', '@testing-library', '@reduxjs', '@tanstack', '@nestjs', '@prisma', '@firebase', '@supabase', '@aws-sdk', '@google-cloud', '@emotion', '@fortawesome', '@radix-ui', '@sveltejs', '@vitejs', '@playwright', '@jest', '@storybook', '@react-navigation', '@expo', '@ionic', '@capacitor', '@apollo', '@headlessui', '@heroicons', '@typescript-eslint', '@eslint']);

/**
 * Un alias de tsconfig o de Vite ('@components/Boton' -> src/components/Boton.tsx): un archivo
 * del proyecto cuya ruta termina igual (con las mayusculas iguales: una coincidencia floja no basta).
 */
function findJsAliasFile(rest: string, nearDir: string, project: ProjectFiles): Found | null {
  const hasExtension = /\.[^/.]+$/.test(basenameOf(rest));
  const candidates = hasExtension
    ? [rest]
    : [
      ...JS_SCRIPT_EXTENSIONS.map((extension) => `${rest}${extension}`),
      `${rest}.d.ts`,
      `${rest}.vue`,
      `${rest}.svelte`,
      ...JS_SCRIPT_EXTENSIONS.slice(0, 8).map((extension) => `${rest}/index${extension}`),
    ];
  for (const candidate of candidates) {
    const found = project.findSuffix(candidate, nearDir);
    if (found && !found.caseMismatch) {
      return found;
    }
  }
  return null;
}

function resolveJs(imp: ParsedImport, fromPath: string, project: ProjectFiles, options: ResolveOptions): Resolved[] {
  const written = imp.specifier;
  // './util\\formato' (barras de Windows) funciona en Windows y no en Linux.
  const windowsPath = /^\.{1,2}\\/.test(written);
  const spec = windowsPath ? written.replace(/\\\\/g, '/').replace(/\\/g, '/') : written;
  const backslashWarning = windowsPath ? `En Linux usa / en la ruta: '${spec}'.` : undefined;
  const fromDir = dirnameOf(fromPath);
  const names = imp.names;
  const isRelative = /^(?:\.{1,2}(?:\/|$)|\/)/.test(spec);
  const appAlias = spec.startsWith('@/') || spec.startsWith('~/') ? spec.slice(0, 2) : '';
  if (isRelative || appAlias) {
    // @/ y ~/ son la carpeta de la aplicacion: la src/ (o app/) de arriba mas cercana (la app puede
    // no estar en la raiz), o la carpeta de la app misma (Nuxt).
    const rest = spec.slice(2);
    const exists = (dir: string) => {
      const candidate = joinPath(dir, rest) || '';
      return !!(findJsFile(candidate, project) || findComponentFile(candidate, project));
    };
    const aliasRoot = appAlias
      ? [
        ...ancestorsOf(fromDir).flatMap((dir) => [joinPath(dir, 'src') || 'src', joinPath(dir, 'app') || 'app']),
        ...ancestorsOf(fromDir).reverse(),
      ].find(exists) ?? 'src'
      : '';
    const base = appAlias
      ? joinPath(aliasRoot, rest)
      : spec.startsWith('/') ? joinPath('', spec.slice(1)) : joinPath(fromDir, spec);
    if (base === null) {
      return [{ label: spec, type: 'missing', description: 'La ruta sale de la carpeta abierta en VS Code.' }];
    }
    const found = findJsFile(base, project);
    if (found) {
      return [{ ...local(spec, found, backslashWarning), names }];
    }
    const component = findComponentFile(base, project);
    if (component) {
      return [{ ...local(spec, component, `Con Vite escribe la extensión: '${spec}${component.path.slice(component.path.lastIndexOf('.'))}'.`), names }];
    }
    const name = basenameOf(base);
    const hasExtension = hasJsExtension(name);
    return [{
      label: spec,
      type: 'missing',
      description: appAlias ? `El alias ${appAlias} suele apuntar a src/ y ahí no está.` : 'Revisa el nombre y la carpeta.',
      // Sin extension escrita es un modulo de codigo: no se sugiere util.css para './util'.
      hint: options.hints
        ? project.suggest(hasExtension ? name : `${name}.js`, hasExtension ? (JS_FILES.test(name) ? JS_FILES : JS_ASSET_FILES) : JS_SCRIPT_FILES, fromPath)
        : '',
      probe: name && !/[*?[\]{}]/.test(name) ? (hasExtension ? name : `${name}.*`) : undefined,
      expected: hasExtension ? [base] : ['.ts', '.js', '.tsx', '.jsx'].map((extension) => `${base}${extension}`),
    }];
  }
  const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
  const pkg = bare.startsWith('@') ? bare.split('/').slice(0, 2).join('/') : bare.split('/')[0];
  if (spec.startsWith('node:') || NODE_BUILTINS[bare] || NODE_BUILTINS[pkg]) {
    return [{ label: spec, type: 'library', description: `${NODE_BUILTINS[bare] || NODE_BUILTINS[pkg] || 'módulo'} (Node.js)` }];
  }
  // '@components/Boton' con un archivo components/Boton.tsx en el proyecto: un alias, no npm.
  if (/^@[\w.-]+\/./.test(spec) && !NPM_KNOWN[pkg] && !NPM_SCOPES.has(pkg.split('/')[0])) {
    const aliased = findJsAliasFile(spec.slice(1), fromDir, project);
    if (aliased) {
      return [{ ...local(spec, aliased), names }];
    }
  }
  // 'components/Boton' con baseUrl en tsconfig o jsconfig: un archivo del proyecto que termina igual.
  if (!spec.startsWith('@') && spec.includes('/') && !NPM_KNOWN[pkg] && !NPM_SUBPATH_PACKAGES.has(pkg)) {
    const aliased = findJsAliasFile(spec, fromDir, project);
    if (aliased) {
      return [{ ...local(spec, aliased), names }];
    }
  }
  return [{ label: spec, type: 'library', description: NPM_KNOWN[pkg] || 'paquete de npm' }];
}

/**
 * Ruby: require_relative busca junto al archivo. `require 'x'` busca en las gemas y en el
 * $LOAD_PATH (lib/ con -Ilib o con bundler), no en la carpeta del archivo.
 */
function resolveRuby(imp: ParsedImport, fromPath: string, project: ProjectFiles, options: ResolveOptions): Resolved[] {
  const spec = imp.specifier;
  const fromDir = dirnameOf(fromPath);
  const withExtension = /\.rb$/i.test(spec) ? spec : `${spec}.rb`;
  if (imp.kind === 'relative') {
    const base = joinPath(fromDir, withExtension);
    if (base === null) {
      return [{ label: spec, type: 'missing', description: 'La ruta sale de la carpeta abierta en VS Code.' }];
    }
    const found = project.find(base);
    if (found) {
      return [local(spec, found)];
    }
    return [{
      label: spec,
      type: 'missing',
      description: 'Revisa el nombre y la carpeta.',
      hint: options.hints ? project.suggest(withExtension, /\.rb$/i) : '',
      probe: basenameOf(withExtension),
      expected: [base],
    }];
  }
  // $LOAD_PATH: lib/ (con -Ilib o bundler) y spec/ o test/ (RSpec y Minitest los agregan).
  const ancestors = ancestorsOf(fromDir);
  const inLoadPath = project.findFirst([
    ...ancestors.flatMap((dir) => ['lib', 'spec', 'test'].map((folder) => joinPath(dir, `${folder}/${withExtension}`))),
    ...ancestors.filter((dir) => /(?:^|\/)(?:lib|spec|test)$/.test(dir)).map((dir) => joinPath(dir, withExtension)),
  ]);
  if (inLoadPath) {
    return [local(spec, inLoadPath)];
  }
  const sibling = project.find(joinPath(fromDir, withExtension));
  if (sibling) {
    return [local(spec, sibling, `require no busca en esta carpeta: usa require_relative '${spec}'.`)];
  }
  return [{ label: spec, type: 'library', description: RUBY_STD[spec] || 'gema de Ruby' }];
}

function resolveCSharp(imp: ParsedImport, fromPath: string, project: ProjectFiles): Resolved[] {
  const spec = imp.specifier;
  if (/^(?:System|Microsoft)(?:\.|$)/.test(spec)) {
    return [{ label: spec, type: 'library', description: CS_NAMESPACES[spec] || 'biblioteca de .NET' }];
  }
  // Un espacio de nombres declarado en el proyecto.
  const declaring = (project.namespaces.get(spec) || []).filter((path) => path !== fromPath);
  if (declaring.length) {
    return [{ label: spec, type: 'local', path: project.nearest(declaring, dirnameOf(fromPath)), description: 'espacio de nombres de tu proyecto' }];
  }
  return [{ label: spec, type: 'library', description: 'paquete NuGet o biblioteca externa' }];
}

export function resolveImport(imp: ParsedImport, fromPath: string, family: DependencyFamily, project: ProjectFiles, options: ResolveOptions): Resolved[] {
  switch (family) {
    case 'c':
      return resolveC(imp, fromPath, project, options);
    case 'python':
      return resolvePython(imp, fromPath, project, options);
    case 'java':
      return resolveJava(imp, fromPath, project, options);
    case 'js':
      return resolveJs(imp, fromPath, project, options);
    case 'ruby':
      return resolveRuby(imp, fromPath, project, options);
    case 'csharp':
      return resolveCSharp(imp, fromPath, project);
    default:
      return [];
  }
}
