// ADACEEN (VS Code): las clases que ya escribio el estudiante (0.0.38), sin importar vscode.
//
// Para «Ver diagrama»: que clases del diagrama del taller ya existen en el codigo, con que
// atributos y metodos, y de quien heredan. Lee el texto sin comentarios ni cadenas (maskSource
// de file-dependencies.ts) y no compila nada: C/C++ (tambien los `Clase::metodo` del .cpp),
// Java, C#, Python y JavaScript/TypeScript. Se prueba con node:test.
import { dependencyFamily, maskSource } from './file-dependencies';
import type { DependencyFamily } from './file-dependencies';

export type SourceClass = {
  name: string;
  /** Ruta relativa del archivo donde se declara. */
  path: string;
  /** Linea (1-based) de la declaracion. */
  line: number;
  /** Clases de las que hereda o interfaces que implementa (sin plantillas ni espacios de nombres). */
  bases: string[];
  /** Nombres de atributos y metodos (constructor con el nombre de la clase, destructor con ~). */
  members: string[];
  /** Tipos que nombra en sus atributos (para las asociaciones y composiciones). */
  fieldTypes: string[];
  /** Tipos que nombra en todo su cuerpo (para las dependencias). */
  usedTypes: string[];
  /** El archivo solo define metodos de la clase (`Cuenta::retirar` en un .cpp), no la declara. */
  definitionsOnly?: boolean;
};

const MAX_TEXT_CHARS = 300_000;
const MAX_CLASSES_PER_FILE = 40;
const MAX_MEMBERS = 120;
const IDENT = /[\p{L}_$][\p{L}\p{N}_$]*/gu;
const KEYWORDS = new Set([
  'public', 'private', 'protected', 'internal', 'static', 'final', 'abstract', 'virtual', 'override', 'const', 'constexpr',
  'inline', 'explicit', 'friend', 'mutable', 'volatile', 'unsigned', 'signed', 'long', 'short', 'int', 'double', 'float',
  'char', 'bool', 'boolean', 'void', 'auto', 'string', 'String', 'std', 'readonly', 'async', 'sealed', 'partial', 'new',
  'synchronized', 'transient', 'native', 'default', 'extern', 'register', 'typename', 'template', 'struct', 'class',
  'enum', 'noexcept', 'operator', 'this', 'return', 'get', 'set', 'let', 'var', 'declare', 'export', 'implements', 'extends',
]);

function identifiersOf(text: string) {
  return text.match(IDENT) || [];
}

function lineAt(text: string, index: number) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

/** "std::vector<Cuenta*>" -> ["vector", "Cuenta"]: nombres de tipo (empiezan con letra) sin palabras reservadas. */
export function typeNamesIn(text: string) {
  const out: string[] = [];
  for (const name of identifiersOf(text)) {
    if (!KEYWORDS.has(name) && !out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}

/** "public Cuenta, private std::Base<int>" -> ["Cuenta", "Base"]. */
function baseNames(list: string) {
  return list
    .split(',')
    .map((part) => part.replace(/<[\s\S]*$/, '').replace(/\b(?:public|private|protected|virtual)\b/g, '').trim())
    .map((part) => {
      const pieces = part.split(/::|\./).map((piece) => piece.trim()).filter(Boolean);
      return pieces[pieces.length - 1] || '';
    })
    .filter((name) => /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name));
}

/** Posicion de la llave que cierra la que abre en `open` (o el largo del texto). */
function matchingBrace(text: string, open: number) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return text.length;
}

type Statement = { text: string; hasBody: boolean; body: string };

/**
 * Las sentencias del primer nivel de un cuerpo de clase: lo que termina en `;` o lo que abre un
 * bloque `{ ... }` (un metodo con cuerpo, una clase anidada, un enum). Los `{}` de un
 * inicializador (`int v{0};`) no cuentan como cuerpo si van despues de un `=` o sin parentesis.
 */
function topLevelStatements(body: string): Statement[] {
  const out: Statement[] = [];
  let start = 0;
  let paren = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '(') {
      paren += 1;
    } else if (ch === ')') {
      paren = Math.max(0, paren - 1);
    } else if (ch === ';' && paren === 0) {
      out.push({ text: body.slice(start, i), hasBody: false, body: '' });
      start = i + 1;
    } else if (ch === '{' && paren === 0) {
      const end = matchingBrace(body, i);
      const head = body.slice(start, i);
      const inner = body.slice(i + 1, end);
      // `int v{0};` y `= { 1, 2 }`: inicializador, la sentencia sigue hasta el `;`.
      const initializer = /=\s*$/.test(head) || (!/\)/.test(head) && /\w\s*$/.test(head) && /^[^;]*$/.test(inner) && body[end + 1] === ';' && !/\b(?:class|struct|enum|union|namespace|interface|record)\b/.test(head));
      if (initializer) {
        i = end;
        continue;
      }
      out.push({ text: head, hasBody: true, body: inner });
      start = end + 1;
      // `};` despues de una clase anidada o un enum.
      if (body[start] === ';') {
        start += 1;
      }
      i = end;
    }
  }
  const tail = body.slice(start);
  if (tail.trim()) {
    out.push({ text: tail, hasBody: false, body: '' });
  }
  return out;
}

/** Nombre de un metodo en su cabecera ("bool Cuenta::retirarDinero(long c) const" -> "retirarDinero"). */
function methodName(head: string) {
  const paren = head.indexOf('(');
  if (paren < 0) {
    return '';
  }
  const before = head.slice(0, paren).replace(/<[^<>()]*>\s*$/, '').trimEnd();
  if (/\boperator\b/.test(before)) {
    return '';
  }
  const destructor = /~\s*([\p{L}_$][\p{L}\p{N}_$]*)$/u.exec(before);
  if (destructor) {
    return `~${destructor[1]}`;
  }
  const words = identifiersOf(before.split(/::/).pop() || before);
  return words[words.length - 1] || '';
}

/** Nombres que declara una sentencia de atributo ("int a = 0, b[3]" -> ["a", "b"]). */
function attributeNames(text: string) {
  const out: string[] = [];
  let depth = 0;
  let part = '';
  const parts: string[] = [];
  for (const ch of text) {
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1);
    }
    if (ch === ',' && depth === 0) {
      parts.push(part);
      part = '';
    } else {
      part += ch;
    }
  }
  parts.push(part);
  for (const raw of parts) {
    const declared = raw.replace(/=[\s\S]*$/, '').replace(/\[[^\]]*\]/g, '').replace(/:\s*\d+\s*$/, '').trim();
    // TypeScript y Python: "saldo: number" / "saldo: int" -> el nombre va antes de los dos puntos.
    const colon = /^([\p{L}_$][\p{L}\p{N}_$]*)\s*[?!]?\s*:(?!:)/u.exec(declared.replace(/^(?:(?:public|private|protected|readonly|static|declare)\s+)*/, ''));
    if (colon) {
      out.push(colon[1]);
      continue;
    }
    const words = identifiersOf(declared);
    const name = words[words.length - 1];
    if (name && !KEYWORDS.has(name)) {
      out.push(name);
    }
  }
  return out;
}

const SKIP_STATEMENT = /^\s*(?:using|typedef|static_assert|friend|template\s*<[^>]*>\s*friend|#|@interface|import|package)\b/;
const ACCESS_LABEL = /^\s*(?:(?:public|private|protected|signals|slots|Q_SLOTS|Q_SIGNALS)\s*(?:slots\s*)?:\s*)+/;
const ANNOTATION = /@[\p{L}_][\p{L}\p{N}_.]*(?:\s*\([^()]*\))?/gu;

function addMember(target: SourceClass, name: string) {
  if (name && !target.members.includes(name) && target.members.length < MAX_MEMBERS) {
    target.members.push(name);
  }
}

function addTypes(list: string[], text: string, own: string) {
  for (const name of typeNamesIn(text)) {
    if (name !== own && !list.includes(name) && list.length < 200) {
      list.push(name);
    }
  }
}

/** Miembros de un cuerpo con llaves (C/C++, Java, C#, JS/TS). */
function readBraceBody(target: SourceClass, body: string, family: DependencyFamily) {
  for (const statement of topLevelStatements(body)) {
    let text = statement.text.replace(ANNOTATION, ' ').replace(ACCESS_LABEL, '').trim();
    if (!text || SKIP_STATEMENT.test(text)) {
      continue;
    }
    if (/\b(?:class|struct|union|interface|enum|record)\s+[\p{L}_]/u.test(text) && statement.hasBody) {
      continue; // tipo anidado: no es un miembro
    }
    text = text.replace(/^template\s*<[^>]*>\s*/, '');
    const paren = text.indexOf('(');
    const eq = text.indexOf('=');
    // JS: "retirar = (c) => {...}" es un metodo; "saldo = calcular(x)" es un atributo.
    const arrow = family === 'js' && /=\s*(?:async\s*)?(?:\([^)]*\)|[\p{L}_$][\p{L}\p{N}_$]*)\s*=>/u.test(text);
    if (paren >= 0 && (eq < 0 || paren < eq) && !arrow) {
      const name = methodName(text);
      addMember(target, name);
      addTypes(target.usedTypes, text, target.name);
      if (statement.hasBody) {
        addTypes(target.usedTypes, statement.body, target.name);
        if (family === 'js') {
          // Atributos de JS: this.saldo = ... en el constructor (o en cualquier metodo).
          for (const match of statement.body.matchAll(/\bthis\.([\p{L}_$#][\p{L}\p{N}_$]*)\s*=(?!=)/gu)) {
            addMember(target, match[1].replace(/^#/, ''));
          }
        }
      }
      continue;
    }
    if (arrow) {
      const name = /^(?:(?:static|readonly|public|private|protected|async)\s+)*#?([\p{L}_$][\p{L}\p{N}_$]*)/u.exec(text)?.[1] || '';
      addMember(target, name);
      continue;
    }
    if (statement.hasBody && family === 'csharp') {
      // Propiedad de C#: "public long Saldo { get; set; }"
      const words = identifiersOf(text);
      addMember(target, words[words.length - 1] || '');
      addTypes(target.fieldTypes, text, target.name);
      continue;
    }
    for (const name of attributeNames(text.replace(/^#/, ''))) {
      addMember(target, name.replace(/^#/, ''));
    }
    addTypes(target.fieldTypes, text.replace(/=[\s\S]*$/, ''), target.name);
    addTypes(target.usedTypes, text, target.name);
  }
}

const BRACE_CLASS = /\b(class|struct|interface|enum(?:\s+class|\s+struct)?|record)\s+(?:alignas\s*\([^)]*\)\s*)?(?:\[\[[^\]]*\]\]\s*)?([\p{L}_$][\p{L}\p{N}_$]*)(\s*<[^{};]*?>)?\s*(final\b)?\s*([^{;]*)\{/gu;

function braceClasses(text: string, masked: string, path: string, family: DependencyFamily): SourceClass[] {
  const out: SourceClass[] = [];
  const pattern = new RegExp(BRACE_CLASS.source, BRACE_CLASS.flags);
  let match: RegExpExecArray | null;
  while (out.length < MAX_CLASSES_PER_FILE && (match = pattern.exec(masked))) {
    const index = match.index;
    const keyword = match[1];
    const name = match[2];
    const header = match[5] || '';
    // "class" de una plantilla (template <class T>) o de un parametro: no es una declaracion. Se
    // sigue buscando justo despues de la palabra (la clase de verdad viene en la misma linea).
    if (/[<,(]\s*$/.test(masked.slice(Math.max(0, index - 20), index)) || /=\s*$/.test(header)) {
      pattern.lastIndex = index + keyword.length;
      continue;
    }
    const open = index + match[0].length - 1;
    const close = matchingBrace(masked, open);
    let bases: string[] = [];
    if (family === 'c') {
      const colon = /^\s*:\s*([\s\S]+)$/.exec(header);
      bases = colon ? baseNames(colon[1]) : [];
    } else if (family === 'csharp') {
      const colon = /^\s*:\s*([\s\S]+)$/.exec(header.replace(/\bwhere\b[\s\S]*$/, ''));
      bases = colon ? baseNames(colon[1]) : [];
    } else {
      const ext = /\bextends\s+([\s\S]+?)(?=\bimplements\b|$)/.exec(header);
      const impl = /\bimplements\s+([\s\S]+)$/.exec(header);
      bases = [...baseNames(ext?.[1] || ''), ...baseNames(impl?.[1] || '')];
    }
    const entry: SourceClass = { name, path, line: lineAt(text, index), bases, members: [], fieldTypes: [], usedTypes: [] };
    const body = masked.slice(open + 1, close);
    if (/^enum/.test(keyword)) {
      for (const value of body.split(',')) {
        const word = identifiersOf(value.replace(/=[\s\S]*$/, ''))[0];
        if (word) {
          addMember(entry, word);
        }
      }
    } else {
      readBraceBody(entry, body, family);
    }
    out.push(entry);
    // Las clases anidadas se leen despues, como clases propias.
    pattern.lastIndex = open + 1;
  }
  return out;
}

/**
 * Para cada posicion, si esta fuera de toda funcion y de toda clase (solo dentro de `namespace`
 * o `extern "C"`): ahi empiezan las definiciones `Clase::metodo(...) {` de un .cpp. Dentro de un
 * cuerpo, `if (Util::valida(x)) {` es una llamada, no una definicion.
 */
function topLevelPositions(masked: string) {
  const top = new Uint8Array(masked.length + 1);
  const stack: boolean[] = [];
  let codeDepth = 0;
  let statementStart = 0;
  for (let i = 0; i < masked.length; i += 1) {
    top[i] = codeDepth === 0 ? 1 : 0;
    const ch = masked[i];
    if (ch === '{') {
      const head = masked.slice(statementStart, i);
      const scope = /\b(?:namespace\b[^;{}]*|extern\s*"C"\s*)$/.test(head);
      stack.push(!scope);
      if (!scope) {
        codeDepth += 1;
      }
      statementStart = i + 1;
    } else if (ch === '}') {
      if (stack.pop()) {
        codeDepth = Math.max(0, codeDepth - 1);
      }
      statementStart = i + 1;
    } else if (ch === ';') {
      statementStart = i + 1;
    }
  }
  top[masked.length] = codeDepth === 0 ? 1 : 0;
  return top;
}

/** C++: `bool Cuenta::retirarDinero(...) {` en un .cpp agrega el metodo a Cuenta. */
function cppOutOfClassDefinitions(text: string, masked: string, path: string): SourceClass[] {
  const byName = new Map<string, SourceClass>();
  const top = topLevelPositions(masked);
  const pattern = /([\p{L}_][\p{L}\p{N}_]*)(?:\s*<[^<>;{}()]*>)?\s*::\s*(~?\s*[\p{L}_][\p{L}\p{N}_]*)\s*\(([^;{}]*)\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?::[^{;]*)?\{/gu;
  for (const match of masked.matchAll(pattern)) {
    const owner = match[1];
    if (owner === 'std' || owner === 'boost' || !top[match.index || 0]) {
      continue;
    }
    let entry = byName.get(owner);
    if (!entry) {
      entry = { name: owner, path, line: lineAt(text, match.index || 0), bases: [], members: [], fieldTypes: [], usedTypes: [], definitionsOnly: true };
      byName.set(owner, entry);
    }
    addMember(entry, match[2].replace(/\s+/g, ''));
    addTypes(entry.usedTypes, match[3], owner);
  }
  return [...byName.values()];
}

/** Python: `class Nombre(Base):` y su bloque por sangria. */
function pythonClasses(text: string, masked: string, path: string): SourceClass[] {
  const out: SourceClass[] = [];
  const lines = masked.split('\n');
  const indentOf = (line: string) => (line.match(/^[ \t]*/)?.[0] || '').replace(/\t/g, '    ').length;
  for (let index = 0; index < lines.length && out.length < MAX_CLASSES_PER_FILE; index += 1) {
    const header = /^([ \t]*)class\s+([\p{L}_][\p{L}\p{N}_]*)\s*(?:\(([^)]*)\))?\s*:/u.exec(lines[index]);
    if (!header) {
      continue;
    }
    const base = indentOf(lines[index]);
    const entry: SourceClass = {
      name: header[2],
      path,
      line: index + 1,
      bases: baseNames((header[3] || '').replace(/\bmetaclass\s*=\s*\w+/g, '')).filter((name) => name !== 'object'),
      members: [],
      fieldTypes: [],
      usedTypes: [],
    };
    let memberIndent = -1;
    for (let j = index + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (!line.trim()) {
        continue;
      }
      const indent = indentOf(line);
      if (indent <= base) {
        break;
      }
      if (memberIndent < 0) {
        memberIndent = indent;
      }
      const trimmed = line.trim();
      if (indent === memberIndent) {
        const def = /^(?:async\s+)?def\s+([\p{L}_][\p{L}\p{N}_]*)\s*\(([^)]*)/u.exec(trimmed);
        if (def) {
          addMember(entry, def[1]);
          addTypes(entry.usedTypes, def[2].replace(/\bself\b/g, ''), entry.name);
          continue;
        }
        const attribute = /^([\p{L}_][\p{L}\p{N}_]*)\s*(?::\s*([^=]+))?=?/u.exec(trimmed);
        if (attribute && !/^(?:class|if|for|while|with|try|return|pass|import|from|@)/.test(trimmed) && /[:=]/.test(trimmed)) {
          addMember(entry, attribute[1]);
          if (attribute[2]) {
            addTypes(entry.fieldTypes, attribute[2], entry.name);
          }
        }
        continue;
      }
      for (const match of trimmed.matchAll(/\bself\.([\p{L}_][\p{L}\p{N}_]*)\s*(?::\s*([^=]+))?=(?!=)/gu)) {
        addMember(entry, match[1]);
        if (match[2]) {
          addTypes(entry.fieldTypes, match[2], entry.name);
        }
      }
      // self.cuentas: list[Cuenta] = [] o self.titular = Cliente(...): la clase que guarda.
      for (const match of trimmed.matchAll(/\bself\.[\p{L}_][\p{L}\p{N}_]*\s*=\s*([\p{Lu}][\p{L}\p{N}_]*)\s*\(/gu)) {
        addTypes(entry.fieldTypes, match[1], entry.name);
      }
      addTypes(entry.usedTypes, trimmed, entry.name);
    }
    out.push(entry);
  }
  return out;
}

/**
 * Las clases que declara un archivo. En C++ tambien las que solo define (`Cuenta::retirar` en el
 * .cpp: definitionsOnly). Nunca lanza.
 */
export function extractSourceClasses(text: string, path: string, language = ''): SourceClass[] {
  const family = dependencyFamily(language, path);
  if (family === 'none' || family === 'ruby') {
    return [];
  }
  const source = String(text || '').slice(0, MAX_TEXT_CHARS).replace(/\r\n?/g, '\n');
  try {
    const masked = maskSource(source, family, true);
    if (family === 'python') {
      return pythonClasses(source, masked, path);
    }
    const declared = braceClasses(source, masked, path, family);
    return family === 'c' ? [...declared, ...cppOutOfClassDefinitions(source, masked, path)] : declared;
  } catch {
    return [];
  }
}

/**
 * Junta las clases de todos los archivos por nombre: la declaracion (el .h) manda para la ruta y
 * la linea; los metodos definidos en el .cpp se suman.
 */
export function mergeSourceClasses(classes: SourceClass[]): Map<string, SourceClass> {
  const merged = new Map<string, SourceClass>();
  const ordered = [...classes].sort((left, right) => Number(!!left.definitionsOnly) - Number(!!right.definitionsOnly));
  for (const item of ordered) {
    const current = merged.get(item.name);
    if (!current) {
      merged.set(item.name, { ...item, bases: [...item.bases], members: [...item.members], fieldTypes: [...item.fieldTypes], usedTypes: [...item.usedTypes] });
      continue;
    }
    for (const name of item.bases) {
      if (!current.bases.includes(name)) {
        current.bases.push(name);
      }
    }
    for (const name of item.members) {
      addMember(current, name);
    }
    addTypes(current.fieldTypes, item.fieldTypes.join(' '), current.name);
    addTypes(current.usedTypes, item.usedTypes.join(' '), current.name);
    if (current.definitionsOnly && !item.definitionsOnly) {
      current.definitionsOnly = false;
      current.path = item.path;
      current.line = item.line;
    }
  }
  return merged;
}
