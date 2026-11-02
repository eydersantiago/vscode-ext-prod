// ADACEEN (VS Code): familia del lenguaje de un archivo y lectura de sus #include, import, require y using (parseImports).
// Movido sin cambios desde src/file-dependencies.ts (solo se agrego "export" y los imports).
import { sourceText, maskSource } from './dependency-source-mask';
import type { ParsedImport, ImportKind, DependencyFamily } from './file-dependencies';

export function lineStartsOf(text: string) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

/** Linea (1-based) de una posicion del texto. */
export function lineOfIndex(starts: number[], index: number) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low + 1;
}

// ---------------------------------------------------------------------------------------------
// Lectura de los imports

/** Un nombre de Python, Java o JS (con tildes: geometría, Canción). */
const IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

/** Macros de plataforma: lo que va dentro de `#ifdef _WIN32 ... #else ... #endif` es a proposito. */
const C_PLATFORM_MACRO = /\b(?:_WIN32|_WIN64|WIN32|_MSC_VER|__MINGW32__|__MINGW64__|__CYGWIN__|__linux__|__unix__|__APPLE__|__MACH__|_POSIX_VERSION)\b/;

/** #include (sin los de un bloque #if 0 ... #endif). */
function parseC(lines: string[]): ParsedImport[] {
  const out: ParsedImport[] = [];
  // Por cada #if abierto: ¿esa rama esta apagada (#if 0 / #if false)? ¿pregunta por la plataforma?
  // Con contadores: recorrer la pila en cada linea era lento con muchos #if anidados.
  const stack: Array<{ disabled: boolean; platform: boolean }> = [];
  let disabledDepth = 0;
  let platformDepth = 0;
  lines.forEach((line, index) => {
    const directive = /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)$/.exec(line);
    if (directive) {
      const kind = directive[1];
      if (kind === 'if' || kind === 'ifdef' || kind === 'ifndef') {
        const entry = {
          disabled: kind === 'if' && /^\s*(?:0|false)\s*$/.test(directive[2]),
          platform: C_PLATFORM_MACRO.test(directive[2]),
        };
        stack.push(entry);
        disabledDepth += entry.disabled ? 1 : 0;
        platformDepth += entry.platform ? 1 : 0;
      } else if (kind === 'endif') {
        const entry = stack.pop();
        if (entry) {
          disabledDepth -= entry.disabled ? 1 : 0;
          platformDepth -= entry.platform ? 1 : 0;
        }
      } else if (stack.length) {
        const entry = stack[stack.length - 1];
        if (entry.disabled) {
          entry.disabled = false; // #else / #elif de un #if 0: esa rama si cuenta
          disabledDepth -= 1;
        }
        if (!entry.platform && kind === 'elif' && C_PLATFORM_MACRO.test(directive[2])) {
          entry.platform = true; // #elif defined(__linux__)
          platformDepth += 1;
        }
      }
      return;
    }
    if (disabledDepth > 0) {
      return;
    }
    const match = /^\s*#\s*include\s*(?:"([^"\n]+)"|<([^>\n]+)>)/.exec(line);
    if (match) {
      const quoted = match[1] !== undefined;
      out.push({
        specifier: (quoted ? match[1] : match[2]).trim(),
        line: index + 1,
        kind: quoted ? 'quoted' : 'angle',
        names: [],
        ...(platformDepth > 0 ? { platformGuarded: true } : {}),
      });
    }
  });
  return out;
}

/** Python, sobre el texto sin cadenas: `print("paso 1; import os")` no es un import. */
function parsePython(lines: string[]): ParsedImport[] {
  const out: ParsedImport[] = [];
  const joinContinued = (start: number, first: string, untilParen: boolean) => {
    let text = first;
    let index = start;
    while (index + 1 < lines.length && index - start < 50) {
      if (untilParen ? !text.includes(')') : /\\\s*$/.test(text)) {
        text = `${text.replace(/\\\s*$/, ' ')} ${lines[index + 1]}`;
        index += 1;
      } else {
        break;
      }
    }
    return text;
  };
  for (let index = 0; index < lines.length; index += 1) {
    for (const statement of lines[index].split(';')) {
      const plain = /^\s*import\s+(.+)$/.exec(statement);
      if (plain) {
        const rest = joinContinued(index, plain[1], false);
        for (const part of rest.split(',')) {
          const name = /^\s*([\p{L}_][\p{L}\p{N}_.]*)(?:\s+as\s+[\p{L}_][\p{L}\p{N}_]*)?\s*$/u.exec(part);
          if (name) {
            out.push({ specifier: name[1].replace(/\.+$/, ''), line: index + 1, kind: 'module', names: [] });
          }
        }
        continue;
      }
      // Despues de los puntos, un nombre que empieza con letra: con `\.+[\w.]*` una linea de
      // miles de puntos tardaba segundos (revision independiente del 25/10/2026).
      const from = /^\s*from\s+(\.+(?:[\p{L}_][\p{L}\p{N}_.]*)?|[\p{L}_][\p{L}\p{N}_.]*)\s+import\s+(.*)$/u.exec(statement);
      if (from) {
        const rest = joinContinued(index, from[2], from[2].trim().startsWith('('));
        const names = rest
          .replace(/[()\\]/g, ' ')
          .split(',')
          .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
          .filter((name) => name === '*' || IDENTIFIER.test(name));
        out.push({ specifier: from[1], line: index + 1, kind: from[1].startsWith('.') ? 'relative' : 'module', names });
      }
    }
  }
  return out;
}

// Java y C#: todos los de la linea (`import a.B; import c.D;`), sobre el texto sin cadenas. El ;
// del final se mira sin consumirlo (lo usa el siguiente) y sin lookbehind: un Safari anterior a
// 16.4 no carga una expresion regular con lookbehind y se caia toda la extension web.
const JAVA_IMPORT = /(?:^|;)[ \t]*import\s+(static\s+)?([\p{L}_$][\p{L}\p{N}_$.]*?)(\.\*)?(?=\s*;)/gmdu;
const CSHARP_USING = /(?:^|;)[ \t]*(?:global\s+)?using\s+(?:static\s+)?(?:[\p{L}_][\p{L}\p{N}_]*\s*=\s*)?([\p{L}_][\p{L}\p{N}_.]*)(?=\s*;)/gmdu;

function parseJava(code: string): ParsedImport[] {
  const starts = lineStartsOf(code);
  const out: ParsedImport[] = [];
  for (const match of code.matchAll(JAVA_IMPORT)) {
    let specifier = match[2];
    const wildcard = !!match[3];
    const line = lineOfIndex(starts, match.indices?.[2]?.[0] ?? match.index ?? 0);
    const names: string[] = [];
    if (match[1]) {
      // import static a.b.Clase.metodo; -> la clase a.b.Clase (con .* tambien es la clase).
      if (!wildcard && specifier.includes('.')) {
        names.push(specifier.slice(specifier.lastIndexOf('.') + 1));
        specifier = specifier.slice(0, specifier.lastIndexOf('.'));
      }
      out.push({ specifier, line, kind: 'module', names });
      continue;
    }
    out.push({ specifier, line, kind: wildcard ? 'wildcard' : 'module', names });
  }
  return out;
}

function parseCSharp(code: string): ParsedImport[] {
  const starts = lineStartsOf(code);
  return [...code.matchAll(CSHARP_USING)].map((match) => ({
    specifier: match[1],
    line: lineOfIndex(starts, match.indices?.[1]?.[0] ?? match.index ?? 0),
    kind: 'module' as const,
    names: [],
  }));
}

function parseRuby(lines: string[]): ParsedImport[] {
  const out: ParsedImport[] = [];
  lines.forEach((line, index) => {
    const match = /^\s*(require_relative|require|load)\s*\(?\s*(['"])([^'"\n]+)\2/.exec(line);
    if (match) {
      out.push({ specifier: match[3], line: index + 1, kind: match[1] === 'require' ? 'module' : 'relative', names: [] });
    }
  });
  return out;
}

/** Comienzo de una sentencia import o export (al inicio, o despues de ; } o un salto de linea). */
const JS_STATEMENT_START = /(?:^|[;\n}])[ \t]*(import|export)\b/g;
// El caracter de antes (no parte de un nombre: `x.require(` o `miimport(` no cuentan) va en el
// grupo 1, sin lookbehind (Safari < 16.4).
const JS_REQUIRE = /(^|[^\w$.])require\s*\(\s*(['"])([^'"\n]*)\2\s*\)/gd;
const JS_DYNAMIC = /(^|[^\w$.])import\s*\(\s*(['"])([^'"\n]*)\2\s*\)/gd;
/** `const { a, b } = ` o `const x = ` justo antes de un require (se mira un trozo corto). */
const JS_REQUIRE_TARGET = /(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*$/;

function jsClauseNames(clause: string) {
  const text = clause.trim().replace(/^type\s+/, '');
  const names: string[] = [];
  const first = /^([\w$]+)/.exec(text);
  if (first) {
    names.push(first[1]); // import Figura from './figura'
  }
  const named = /\{([^}]*)\}/.exec(text);
  if (named) {
    for (const part of named[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (IDENTIFIER.test(name) && name !== 'default') {
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * JS/TS: las sentencias se leen en el texto sin cadenas ni plantillas (un `require('x')` dentro
 * de un texto no cuenta) y la ruta se toma del original en la misma posicion. Las llaves de un
 * import se saltan con el indice de la proxima `}` (lineal: antes, miles de `import {` sin
 * cerrar tardaban segundos, y un tope de largo perdia listas largas de export).
 */
function parseJs(masked: string, original: string): ParsedImport[] {
  const starts = lineStartsOf(masked);
  const found: Array<ParsedImport & { index: number }> = [];
  const add = (from: number, to: number, names: string[]) => {
    const specifier = original.slice(from, to).trim();
    if (!specifier) {
      return;
    }
    const kind: ImportKind = /^(?:\.{1,2}(?:[/\\]|$)|\/)/.test(specifier) ? 'relative' : 'module';
    found.push({ specifier, line: lineOfIndex(starts, from), kind, names, index: from });
  };
  const nextClose = new Int32Array(masked.length + 1).fill(-1);
  for (let index = masked.length - 1, close = -1; index >= 0; index -= 1) {
    if (masked[index] === '}') {
      close = index;
    }
    nextClose[index] = close;
  }
  const isSpace = (ch: string | undefined) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
  const quotedAt = (at: number) => {
    const quote = masked[at];
    if (quote !== '"' && quote !== "'") {
      return null;
    }
    const end = masked.indexOf(quote, at + 1);
    return end > at && !masked.slice(at + 1, end).includes('\n') ? { from: at + 1, to: end } : null;
  };
  for (const match of masked.matchAll(JS_STATEMENT_START)) {
    let k = (match.index || 0) + match[0].length;
    const skip = () => {
      while (k < masked.length && isSpace(masked[k])) {
        k += 1;
      }
    };
    const word = () => {
      const found = /^[\w$]+/.exec(masked.slice(k, k + 200));
      return found ? found[0] : '';
    };
    skip();
    if (match[1] === 'import') {
      const bare = quotedAt(k); // import './estilos.css'
      if (bare) {
        add(bare.from, bare.to, []);
        continue;
      }
    }
    const clauseStart = k;
    if (word() === 'type' && isSpace(masked[k + 4])) {
      k += 4;
      skip();
    }
    const first = word();
    if (first && first !== 'from') {
      k += first.length;
      skip();
      if (masked[k] === ',') {
        k += 1;
        skip();
      }
    }
    if (masked[k] === '*') {
      k += 1;
      skip();
      if (word() === 'as') {
        k += 2;
        skip();
        k += word().length;
        skip();
      }
    } else if (masked[k] === '{') {
      const close = nextClose[k];
      if (close < 0) {
        continue;
      }
      k = close + 1;
      skip();
    }
    const clauseEnd = k;
    if (word() !== 'from') {
      continue;
    }
    k += 4;
    skip();
    const target = quotedAt(k);
    if (target) {
      add(target.from, target.to, jsClauseNames(masked.slice(clauseStart, clauseEnd)));
    }
  }
  for (const match of masked.matchAll(JS_REQUIRE)) {
    const range = match.indices?.[3];
    if (!range) {
      continue;
    }
    const start = (match.index || 0) + match[1].length;
    const declaration = JS_REQUIRE_TARGET.exec(masked.slice(Math.max(0, start - 300), start));
    add(range[0], range[1], declaration ? jsClauseNames(declaration[1]) : []);
  }
  for (const match of masked.matchAll(JS_DYNAMIC)) {
    const range = match.indices?.[3];
    if (range) {
      add(range[0], range[1], []);
    }
  }
  return found.sort((left, right) => left.index - right.index).map(({ index: _index, ...rest }) => rest);
}

/** Los imports del archivo, en orden, con su linea. */
export function parseImports(text: string, family: DependencyFamily): ParsedImport[] {
  if (family === 'none') {
    return [];
  }
  const original = sourceText(text);
  switch (family) {
    case 'js':
      return parseJs(maskSource(original, family, true), original);
    case 'c':
      return parseC(maskSource(original, family, false).split('\n'));
    case 'python':
      return parsePython(maskSource(original, family, true).split('\n'));
    case 'java':
      return parseJava(maskSource(original, family, true));
    case 'csharp':
      return parseCSharp(maskSource(original, family, true));
    case 'ruby':
      return parseRuby(maskSource(original, family, false).split('\n'));
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Lenguaje

const C_EXTENSIONS = /\.(?:c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|inl|ipp|tpp|txx|ino)$/i;

/** Familia del archivo por el lenguaje de VS Code o, si no se sabe, por la extension. */
export function dependencyFamily(language: string, filePath = ''): DependencyFamily {
  const clean = String(language || '').toLowerCase();
  const path = String(filePath || '').toLowerCase();
  if (/^(?:c|cpp|cuda-cpp|objective-c|objective-cpp|arduino)$/.test(clean) || (!clean && C_EXTENSIONS.test(path))) {
    return 'c';
  }
  if (clean === 'python' || clean === 'py' || /\.pyw?$/.test(path)) {
    return 'python';
  }
  if (clean === 'java' || /\.java$/.test(path)) {
    return 'java';
  }
  if (/^(?:javascript|typescript|javascriptreact|typescriptreact|js|ts|jsx|tsx|vue|svelte)$/.test(clean) || /\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(path)) {
    return 'js';
  }
  if (clean === 'ruby' || clean === 'rb' || /\.rb$/.test(path)) {
    return 'ruby';
  }
  if (clean === 'csharp' || clean === 'cs' || /\.cs$/.test(path)) {
    return 'csharp';
  }
  if (C_EXTENSIONS.test(path)) {
    return 'c';
  }
  return 'none';
}
