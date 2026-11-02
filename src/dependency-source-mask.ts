// ADACEEN (VS Code): texto del archivo sin comentarios ni cadenas (maskSource) y lo que se lee de el: identificadores, tipos y paquetes.
// Movido sin cambios desde src/file-dependencies.ts (solo se agrego "export" y los imports).
import type { DependencyFamily } from './file-dependencies';

// ---------------------------------------------------------------------------------------------
// Texto sin comentarios (y, si se pide, sin el contenido de las cadenas)

/**
 * Antes de un `/` que abre una expresion regular de JS (no una division). Sin `)`, `]` ni `}`:
 * despues de ellos suele ser una division (`(a + b) / 2`, `${x}/${y}` en una plantilla). Sin `<`:
 * en JSX `</p>` cierra una etiqueta, no abre una expresion regular (se comia el resto de la linea).
 */
const JS_REGEX_PREVIOUS = /[(,=:[!&|?{;+\-*%>~^]/;
const JS_REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await', 'throw', 'delete', 'new', 'instanceof']);
const C_RAW_PREFIXES = new Set(['R', 'u8R', 'uR', 'UR', 'LR']);

/**
 * El texto con los comentarios en blanco (mismo largo, mismos saltos de linea: los numeros de
 * linea no cambian). Con `maskStrings`, tambien el contenido de las cadenas. Siempre se borran
 * las cadenas de triple comilla de Python (un docstring no declara imports), las cadenas crudas
 * de C++ (`R"(...)"`) y el contenido de las expresiones regulares de JS (una comilla o un `//`
 * adentro confundian lo que seguia). En las plantillas de JS el codigo de `${ ... }` sigue
 * siendo codigo, tambien con plantillas anidadas (revisiones independientes del 25/10/2026).
 */
export function maskSource(text: string, family: DependencyFamily, maskStrings: boolean) {
  const source = String(text || '');
  if (family === 'none') {
    return source;
  }
  const out: string[] = [];
  const blank = (ch: string) => (ch === '\n' ? '\n' : ' ');
  const n = source.length;
  const hashComments = family === 'python' || family === 'ruby';
  let i = 0;
  let lineStart = true;
  // JS: el ultimo caracter con algo y la ultima palabra (sin pegar palabras de lineas distintas),
  // para distinguir /regex/ de una division.
  let previous = '';
  let previousWord = '';
  let spaceSincePrevious = false;
  // JS: plantillas abiertas y, dentro de ellas, expresiones ${ } con su profundidad de llaves.
  const templates: Array<{ kind: 'template' } | { kind: 'expression'; depth: number }> = [];
  const top = () => templates[templates.length - 1];
  // Ruby: cuerpos de heredoc pendientes (<<~TEXTO ... TEXTO empieza en la linea de abajo).
  const heredocs: Array<{ line: number; start: number; end: number }> = [];
  const heredocMisses = new Map<string, number>();
  let heredocCount = 0;
  while (i < n) {
    if (heredocs.length && i === heredocs[0].start) {
      const body = heredocs.shift() as { end: number };
      for (; i < body.end; i += 1) {
        out.push(blank(source[i]));
      }
      lineStart = true;
      continue;
    }
    const ch = source[i];
    const next = source[i + 1];
    const context = family === 'js' ? top() : undefined;
    if (context?.kind === 'template') {
      // Texto de una plantilla: hasta la comilla invertida o el proximo ${.
      if (ch === '\\' && i + 1 < n) {
        out.push(maskStrings ? blank(ch) : ch, maskStrings ? blank(source[i + 1]) : source[i + 1]);
        i += 2;
        continue;
      }
      if (ch === '`') {
        out.push(ch);
        templates.pop();
        previous = '`';
        previousWord = '';
        spaceSincePrevious = false;
        i += 1;
        continue;
      }
      if (ch === '$' && next === '{') {
        out.push('$', '{');
        templates.push({ kind: 'expression', depth: 0 });
        previous = '{';
        previousWord = '';
        spaceSincePrevious = false;
        i += 2;
        continue;
      }
      out.push(maskStrings ? blank(ch) : ch);
      i += 1;
      continue;
    }
    if (family === 'ruby' && lineStart && source.startsWith('=begin', i)) {
      const end = source.indexOf('\n=end', i);
      const stop = end < 0 ? n : end + 5;
      for (; i < stop; i += 1) {
        out.push(blank(source[i]));
      }
      continue;
    }
    if (hashComments ? ch === '#' : ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') {
        out.push(' ');
        i += 1;
        // En C, una \ al final del comentario lo sigue en la linea de abajo.
        if (family === 'c' && source[i] === '\n' && (source[i - 1] === '\\' || (source[i - 1] === '\r' && source[i - 2] === '\\'))) {
          out.push('\n');
          i += 1;
        }
      }
      continue;
    }
    if (!hashComments && ch === '/' && next === '*') {
      out.push(' ', ' ');
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out.push(blank(source[i]));
        i += 1;
      }
      if (i < n) {
        out.push(' ', ' ');
        i += 2;
      }
      continue;
    }
    if (family === 'python' && (source.startsWith('"""', i) || source.startsWith("'''", i))) {
      const quote = source.slice(i, i + 3);
      const end = source.indexOf(quote, i + 3);
      const stop = end < 0 ? n : end + 3;
      for (; i < stop; i += 1) {
        out.push(blank(source[i]));
      }
      continue;
    }
    if (family === 'c' && ch === '"' && i > 0 && source[i - 1] === 'R') {
      // Cadena cruda de C++: R"delim( ... )delim" (puede tener saltos de linea y comillas).
      let wordStart = i - 1;
      while (wordStart > 0 && /\w/.test(source[wordStart - 1])) {
        wordStart -= 1;
      }
      // El delimitador tiene a lo sumo 16 caracteres: no se busca el ( en todo lo que sigue.
      const openAt = source.slice(i + 1, i + 18).indexOf('(');
      const open = openAt < 0 ? -1 : i + 1 + openAt;
      const delimiter = open > i ? source.slice(i + 1, open) : '';
      if (C_RAW_PREFIXES.has(source.slice(wordStart, i)) && open > i && open - i <= 17 && !/[\s\\)"]/.test(delimiter)) {
        const end = source.indexOf(`)${delimiter}"`, open + 1);
        const stop = end < 0 ? n : end + delimiter.length + 2;
        out.push('"');
        for (i += 1; i < stop - 1; i += 1) {
          out.push(blank(source[i]));
        }
        if (i < n) {
          out.push('"');
          i += 1;
        }
        lineStart = false;
        continue;
      }
    }
    if (family === 'c' && ch === "'" && i > 0 && /[0-9]/.test(source[i - 1]) && /[0-9A-Fa-f]/.test(next || '')) {
      out.push(ch); // separador de digitos de C++14 (1'000'000), no un caracter
      i += 1;
      continue;
    }
    if (family === 'js') {
      if (ch === '`') {
        out.push(ch);
        templates.push({ kind: 'template' });
        i += 1;
        lineStart = false;
        continue;
      }
      if (context?.kind === 'expression') {
        if (ch === '{') {
          context.depth += 1;
        } else if (ch === '}') {
          if (context.depth === 0) {
            out.push(ch); // fin del ${ }: vuelve el texto de la plantilla
            templates.pop();
            i += 1;
            continue;
          }
          context.depth -= 1;
        }
      }
      if (ch === '/' && (previous === '' || JS_REGEX_PREVIOUS.test(previous) || JS_REGEX_KEYWORDS.has(previousWord))) {
        // Expresion regular: su contenido se borra (una comilla o un // adentro no son codigo).
        out.push('/');
        i += 1;
        let inClass = false;
        while (i < n && source[i] !== '\n') {
          const current = source[i];
          if (current === '\\' && i + 1 < n && source[i + 1] !== '\n') {
            out.push(' ', ' ');
            i += 2;
            continue;
          }
          if (current === '/' && !inClass) {
            break;
          }
          if (current === '[') {
            inClass = true;
          } else if (current === ']') {
            inClass = false;
          }
          out.push(' ');
          i += 1;
        }
        if (i < n && source[i] === '/') {
          out.push('/');
          i += 1;
        }
        previous = 'a';
        previousWord = '';
        spaceSincePrevious = false;
        lineStart = false;
        continue;
      }
    }
    if ((family === 'java' || family === 'csharp') && ch === '"' && next === '"' && source[i + 2] === '"') {
      // Bloque de texto de Java (""""") o cadena cruda de C# (tres o mas comillas): puede tener
      // varias lineas con cualquier cosa adentro (un "import x;" de ejemplo no es un import).
      let run = 3;
      while (source[i + run] === '"') {
        run += 1;
      }
      const end = source.indexOf('"'.repeat(run), i + run);
      const stop = end < 0 ? n : end + run;
      for (; i < stop; i += 1) {
        out.push(blank(source[i]));
      }
      previous = '"';
      previousWord = '';
      spaceSincePrevious = false;
      lineStart = false;
      continue;
    }
    if (family === 'csharp' && (ch === '@' || ch === '$') && (next === '"' || ((next === '@' || next === '$') && next !== ch && source[i + 2] === '"'))
      && (ch === '@' || next === '@')) {
      // @"..." o $@"..." de C#: pueden tener varias lineas, y "" es una comilla adentro.
      let k = (next === '"' ? i + 1 : i + 2) + 1;
      while (k < n && !(source[k] === '"' && source[k + 1] !== '"')) {
        k += source[k] === '"' ? 2 : 1;
      }
      const stop = Math.min(n, k + 1);
      for (; i < stop; i += 1) {
        out.push(blank(source[i]));
      }
      previous = '"';
      previousWord = '';
      spaceSincePrevious = false;
      lineStart = false;
      continue;
    }
    if (family === 'ruby' && ch === '<' && next === '<' && heredocCount < 200) {
      const heredoc = /^<<(?:([~-])(['"`]?)([A-Za-z_]\w*)\2|(['"`])([A-Za-z_]\w*)\4|([A-Z_][A-Z0-9_]*)\b)/.exec(source.slice(i, i + 80));
      const lineEnd = heredoc ? source.indexOf('\n', i) : -1;
      if (heredoc && lineEnd >= 0) {
        heredocCount += 1;
        const id = heredoc[3] || heredoc[5] || heredoc[6];
        const last = heredocs[heredocs.length - 1];
        const start = last && last.line === lineEnd ? last.end : lineEnd + 1;
        // Una busqueda que ya fallo desde antes no se repite (miles de <<FIN sin cierre).
        const missedFrom = heredocMisses.get(id);
        if (missedFrom === undefined || start < missedFrom) {
          const terminator = new RegExp(`^[ \\t]*${id}[ \\t]*$`, 'm');
          const found = terminator.exec(source.slice(start));
          if (found) {
            const end = start + found.index + found[0].length;
            heredocs.push({ line: lineEnd, start, end });
          } else {
            heredocMisses.set(id, start);
          }
        }
      }
    }
    if (ch === '"' || ch === "'") {
      out.push(ch);
      i += 1;
      while (i < n && source[i] !== ch) {
        if (source[i] === '\n') {
          break; // cadena sin cerrar: termina en el salto de linea
        }
        if (source[i] === '\\' && i + 1 < n && source[i + 1] !== '\n') {
          out.push(maskStrings ? ' ' : source[i], maskStrings ? ' ' : source[i + 1]);
          i += 2;
          continue;
        }
        out.push(maskStrings ? blank(source[i]) : source[i]);
        i += 1;
      }
      if (i < n && source[i] === ch) {
        out.push(ch);
        i += 1;
      }
      previous = ch;
      previousWord = '';
      spaceSincePrevious = false;
      lineStart = false;
      continue;
    }
    out.push(ch);
    lineStart = ch === '\n';
    if (/\s/.test(ch)) {
      spaceSincePrevious = true;
    } else {
      const wordChar = /[\w$]/.test(ch);
      previousWord = wordChar ? (/[\w$]/.test(previous) && !spaceSincePrevious ? previousWord + ch : ch) : '';
      previous = ch;
      spaceSincePrevious = false;
    }
    i += 1;
  }
  return out.join('');
}

/** Lo que se lee de un archivo largo: los imports van arriba. */
const MAX_PARSE_CHARS = 200_000;

const MAX_TYPE_REFS = 500;

/**
 * El texto que se lee, con saltos de linea \n: un archivo guardado en Windows (\r\n) no mostraba
 * ningun import de Python y `#if 0\r` no se reconocia (revision independiente del 25/10/2026).
 */
export function sourceText(text: string, maxChars = MAX_PARSE_CHARS) {
  return String(text || '').slice(0, maxChars).replace(/\r\n?/g, '\n');
}

/** Lineas que declaran imports, paquete o espacio de nombres: nombrar algo ahi no es usarlo. */
const DECLARATION_LINES: Partial<Record<DependencyFamily, RegExp>> = {
  java: /^[ \t]*(?:import|package)\b[^\n]*/gm,
  csharp: /^[ \t]*(?:(?:global[ \t]+)?using\b[^;\n(]*;|namespace\b[^\n{;]*)/gm,
  python: /^[ \t]*(?:import|from)\b[^\n]*/gm,
  ruby: /^[ \t]*(?:require|require_relative|load)\b[^\n]*/gm,
  c: /^[ \t]*#[ \t]*include\b[^\n]*/gm,
};

/** El codigo sin comentarios, sin el contenido de las cadenas y sin las lineas de import. */
export function codeOnly(text: string, family: DependencyFamily) {
  const masked = maskSource(sourceText(text), family, true);
  const declarations = DECLARATION_LINES[family];
  return declarations ? masked.replace(declarations, (line) => ' '.repeat(line.length)) : masked;
}

/** Identificadores del codigo (sin comentarios ni cadenas), para ver que clases y funciones usa. */
export function collectIdentifiers(text: string, family: DependencyFamily) {
  return new Set(codeOnly(text, family).match(/[\p{L}_$][\p{L}\p{N}_$]*/gu) || []);
}

/** Nombres con mayuscula (Java y C#): las clases que usa un archivo sin importarlas. */
export function collectTypeReferences(text: string, family: DependencyFamily) {
  if (family !== 'java' && family !== 'csharp') {
    return [];
  }
  const code = codeOnly(text, family);
  const names = new Set<string>();
  for (const match of code.matchAll(/(?:^|[^\p{L}\p{N}_$])(\p{Lu}[\p{L}\p{N}_]*)/gu)) {
    names.add(match[1]);
    if (names.size >= MAX_TYPE_REFS) {
      break;
    }
  }
  return [...names];
}

/**
 * C#: los espacios de nombres que declara el archivo, tambien los anidados
 * (`namespace A { namespace B {` declara A y A.B) y los de archivo (`namespace X;`).
 */
export function collectNamespaces(text: string, family: DependencyFamily) {
  if (family !== 'csharp') {
    return [];
  }
  const code = maskSource(sourceText(text), family, true);
  const names = new Set<string>();
  const stack: Array<{ name: string; depth: number }> = [];
  let depth = 0;
  for (const match of code.matchAll(/\bnamespace\s+([\p{L}_][\p{L}\p{N}_.]*)\s*([{;])|[{}]/gu)) {
    if (match[1]) {
      names.add([...stack.map((item) => item.name), match[1]].join('.'));
      if (match[2] === '{') {
        depth += 1;
        stack.push({ name: match[1], depth });
      } else {
        stack.push({ name: match[1], depth: -1 }); // de archivo: vale hasta el final
      }
    } else if (match[0] === '{') {
      depth += 1;
    } else {
      while (stack.length && stack[stack.length - 1].depth === depth) {
        stack.pop();
      }
      depth = Math.max(0, depth - 1);
    }
    if (names.size >= 20) {
      break;
    }
  }
  return [...names];
}

/** Java: el paquete del archivo (`package com.uni.modelo;`), o '' en el paquete por defecto. */
export function collectJavaPackage(text: string, family: DependencyFamily) {
  if (family !== 'java') {
    return '';
  }
  const match = /^[ \t]*package\s+([\p{L}_$][\p{L}\p{N}_$.]*)\s*;/mu.exec(maskSource(sourceText(text, 20_000), family, true));
  return match ? match[1] : '';
}
