// ADACEEN (VS Code): el codigo que acompana cada pedido al tutor (0.0.35).
//
// Revision de precision del 21/10/2026. Antes se mandaban los primeros 7200 caracteres del
// archivo (aunque el cursor estuviera en la linea 300), el texto visible repetido y un mapa de
// 24 archivos con vista previa. Ahora, como el visor de archivos de SWE-agent (una ventana de
// unas 100 lineas numeradas rindio mas que 30 lineas o el archivo entero) y el mapa del
// repositorio de Aider (firmas en vez de cuerpos):
//   - lineas numeradas alrededor del foco, con ">" en las del foco (el modelo puede nombrar la
//     linea correcta y no tiene que adivinar donde esta el cursor);
//   - la estructura del resto del archivo (clases y funciones con su numero de linea);
//   - las declaraciones de los archivos relacionados (el .h del .cpp, lo que incluye o importa,
//     las clases que usa);
//   - la lista corta de los demas archivos.
// Sin importar vscode: se prueba con node:test.

export type NumberedWindow = { text: string; startLine: number; endLine: number; totalLines: number };

const MAX_LINE_CHARS = 220;
/** Tope de lineas aunque sobre espacio: mas codigo no ayuda a un modelo pequeno (SWE-agent). */
const MAX_WINDOW_LINES = 160;

/** Lineas del texto; la ultima vacia tambien cuenta (VS Code la numera). */
function splitLines(content: string) {
  return String(content || '').replace(/\r\n?/g, '\n').split('\n');
}

function clip(line: string, max = MAX_LINE_CHARS) {
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Recorte del texto de a lo sumo `maxChars` caracteres alrededor de `focusLine` (1-based), con
 * el numero de su primera linea. Respeta el tope de adaceen.suggestions.maxCodeChars sin dejar
 * fuera el foco (antes se tomaba el comienzo del archivo y, en un archivo largo, el foco podia
 * quedar fuera).
 */
export function sliceAroundLine(text: string, focusLine: number, maxChars: number) {
  const clean = String(text || '');
  const limit = Math.max(1, Math.floor(maxChars));
  if (clean.length <= limit) {
    return { text: clean, firstLine: 1 };
  }
  const lines = clean.replace(/\r\n?/g, '\n').split('\n');
  const focus = Math.min(Math.max(1, Math.floor(Number(focusLine) || 1)), lines.length);
  let start = focus;
  let end = focus;
  let size = lines[focus - 1].length + 1;
  let grew = true;
  while (grew) {
    grew = false;
    if (start > 1 && size + lines[start - 2].length + 1 <= limit) {
      start -= 1;
      size += lines[start - 1].length + 1;
      grew = true;
    }
    if (end < lines.length && size + lines[end].length + 1 <= limit) {
      end += 1;
      size += lines[end - 1].length + 1;
      grew = true;
    }
  }
  return { text: lines.slice(start - 1, end).join('\n'), firstLine: start };
}

/**
 * Lineas numeradas del texto (`firstLine`: numero de su primera linea en el archivo):
 * alrededor de [focusStart, focusEnd] (numeros del archivo) o, sin foco, desde el comienzo.
 * Primero hasta `maxBefore` lineas antes y `maxAfter` despues; un texto corto que cabe va
 * entero. Si el foco no esta en el texto, no se marca ninguna linea.
 */
export function buildNumberedWindow(
  content: string,
  options: { firstLine?: number; focusStart?: number; focusEnd?: number; maxChars: number; maxBefore?: number; maxAfter?: number },
): NumberedWindow {
  const lines = splitLines(content);
  const total = lines.length;
  if (!lines.some((line) => line.trim())) {
    return { text: '', startLine: 0, endLine: 0, totalLines: 0 };
  }
  const offset = Math.max(1, Math.floor(Number(options.firstLine) || 1)) - 1;
  const width = String(offset + total).length;
  const focusStartAbs = Math.floor(Number(options.focusStart) || 0);
  const focusEndAbs = Math.max(focusStartAbs, Math.floor(Number(options.focusEnd) || focusStartAbs));
  const hasFocus = focusStartAbs >= 1 && focusStartAbs - offset >= 1 && focusStartAbs - offset <= total;
  const first = hasFocus ? focusStartAbs - offset : 1;
  const last = hasFocus ? Math.min(focusEndAbs - offset, total) : 1;
  const isFocus = (line: number) => hasFocus && line >= first && line <= last;
  const render = (line: number) => `${String(offset + line).padStart(width)}${isFocus(line) ? '>' : ' '}| ${clip(lines[line - 1])}`.trimEnd();
  const cost = (line: number) => render(line).length + 1;
  const maxChars = Math.max(200, Math.floor(options.maxChars));

  let start = first;
  let end = first;
  let size = cost(first);
  // El foco completo, salvo que no quepa.
  while (end < last && size + cost(end + 1) <= maxChars) {
    end += 1;
    size += cost(end);
  }
  const grow = (maxBefore: number, maxAfter: number) => {
    let grew = true;
    while (grew && end - start + 1 < MAX_WINDOW_LINES) {
      grew = false;
      if (hasFocus && start > 1 && first - start < maxBefore && size + cost(start - 1) <= maxChars) {
        start -= 1;
        size += cost(start);
        grew = true;
      }
      if (end < total && end - last < maxAfter && size + cost(end + 1) <= maxChars) {
        end += 1;
        size += cost(end);
        grew = true;
      }
    }
  };
  const maxBefore = Math.max(0, Math.floor(options.maxBefore ?? 60));
  const maxAfter = Math.max(0, Math.floor(options.maxAfter ?? 40));
  // Un texto corto que cabe completo va completo.
  const wholeSize = lines.reduce((sum, _line, index) => sum + cost(index + 1), 0);
  if (total <= MAX_WINDOW_LINES && wholeSize <= maxChars) {
    start = 1;
    end = total;
  } else if (hasFocus) {
    // Unas 100 lineas alrededor del foco (60 antes y 40 despues); lo que no se usa de un lado
    // (foco cerca del comienzo o del final) pasa al otro.
    grow(maxBefore, maxAfter);
    const used = (first - start) + (end - last);
    const spare = Math.max(0, maxBefore + maxAfter - used);
    if (spare > 0) {
      grow(first - start + spare, end - last + spare);
    }
  } else {
    grow(0, Number.MAX_SAFE_INTEGER);
  }

  const out: string[] = [];
  for (let line = start; line <= end; line += 1) {
    out.push(render(line));
  }
  return { text: out.join('\n'), startLine: offset + start, endLine: offset + end, totalLines: offset + total };
}

const CONTROL_WORDS = /^(?:if|else|for|while|do|switch|case|return|catch|sizeof|delete|new|throw|co_return|co_await|goto|using|typedef|default|try)\b/;

/** Indice del parentesis que cierra al de `open` (-1 si no cierra en la linea). */
function matchingParen(text: string, open: number) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') {
      depth += 1;
    } else if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** Firma de clase o funcion en lenguajes con llaves (C, C++, Java, C#, JS, TS). */
function isCLikeDeclaration(line: string) {
  const text = line.trim();
  if (!text || /^(?:\/\/|\/\*|\*)/.test(text)) {
    return false;
  }
  if (/^#\s*include\b/.test(text) || /^(?:public|private|protected)\s*:\s*$/.test(text)) {
    return true;
  }
  if (/^(?:template\s*<[^>]*>\s*)?(?:(?:public|private|protected|export|default|abstract|final|static|sealed)\s+)*(?:class|struct|enum|interface|namespace|union)\s+[A-Za-z_]/.test(text)) {
    return !/^[^{]*;\s*$/.test(text); // "class Figura;" es una declaracion adelantada
  }
  const open = text.indexOf('(');
  if (open <= 0 || CONTROL_WORDS.test(text) || /^[}\])]/.test(text)) {
    return false;
  }
  // Llamadas, asignaciones, lambdas y flujos no son firmas: "x = f(", "obj.f(", "cout << f(", "[](".
  const head = text.slice(0, open).replace(/operator\s*\S+\s*$/, 'operator');
  if (/[=.[\]{}]|->|<<|>>/.test(head)) {
    return false;
  }
  const words = head.trim().split(/\s+/);
  const close = matchingParen(text, open);
  const params = close > open ? text.slice(open + 1, close).trim() : '';
  const tail = close > open ? text.slice(close + 1).trim() : '';
  if (close < 0) {
    // La lista de parametros sigue en la linea de abajo: firma si tiene tipo y nombre.
    return words.length >= 2 && !/;\s*$/.test(text);
  }
  const qualifiers = '(?:(?:const|override|noexcept|final|volatile|throws\\s+[\\w.,\\s]+)\\s*)*(?:->\\s*[\\w:<>]+\\s*)?';
  // Definicion: abre el cuerpo ("{"), trae la lista de inicializacion (": base(b) {") o la
  // llave va en la linea de abajo.
  if (new RegExp(`^${qualifiers}(?::.*)?(?:\\{.*)?$`).test(tail) && !/^[^{]*;\s*$/.test(tail)) {
    return /\{/.test(tail) || words.length >= 2 || /::/.test(words[0]);
  }
  // Declaracion con ";": necesita tipo y parametros con tipo (o vacios); "Figura f(3, 4);" no.
  if (new RegExp(`^${qualifiers}(?:=\\s*(?:0|default|delete)\\s*)?;$`).test(tail)) {
    const typedParams = params === '' || params === 'void' || /\b[A-Za-z_][\w:<>]*(?:\s*[*&]+\s*|\s+)[*&]?[A-Za-z_]\w*/.test(params);
    return (words.length >= 2 || /^~/.test(words[0])) && typedParams;
  }
  return false;
}

function isPythonDeclaration(line: string) {
  return /^\s*(?:class|def|async\s+def)\s+\w+|^\s*(?:from\s+\S+\s+)?import\s+\w/.test(line);
}

function isRubyDeclaration(line: string) {
  return /^\s*(?:class|module|def)\s+\S|^\s*attr_(?:reader|writer|accessor)\b|^\s*require(?:_relative)?\s/.test(line);
}

/** Variable miembro en el cuerpo de una clase de C++/Java ("double base;", "private int edad;"). */
function isMemberDeclaration(line: string) {
  const text = line.trim();
  return /^(?:(?:public|private|protected|static|const|final|mutable)\s+)*[A-Za-z_][\w:<>,]*(?:\s*[*&])?\s+[*&]?[A-Za-z_]\w*(?:\s*\[[^\]]*\])?(?:\s*,\s*[*&]?[A-Za-z_]\w*)*\s*(?:=[^;]*)?;\s*(?:\/\/.*)?$/.test(text)
    && !CONTROL_WORDS.test(text);
}

function familyOf(language: string) {
  const clean = String(language || '').toLowerCase();
  if (/^(?:python|py)$/.test(clean)) {return 'python';}
  if (/^(?:ruby|rb)$/.test(clean)) {return 'ruby';}
  return 'clike';
}

/**
 * Estructura de un archivo: clases, funciones y metodos (y en un encabezado, sus atributos) con
 * su numero de linea, sin las lineas de `exclude` (las que ya van en la ventana numerada).
 */
export function buildCodeOutline(
  content: string,
  language: string,
  options: { exclude?: [number, number]; maxChars?: number; members?: boolean; firstLine?: number } = {},
) {
  const lines = splitLines(content);
  const offset = Math.max(1, Math.floor(Number(options.firstLine) || 1)) - 1;
  const family = familyOf(language);
  const maxChars = Math.max(80, Math.floor(options.maxChars ?? 1200));
  const [skipFrom, skipTo] = options.exclude || [0, -1];
  // Prioridad: 0 clases, 1 funciones y metodos, 2 includes e imports, 3 atributos y "public:".
  const candidates: Array<{ lineNumber: number; entry: string; priority: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = offset + index + 1;
    if (lineNumber >= skipFrom && lineNumber <= skipTo) {
      continue;
    }
    const line = lines[index];
    const text = line.trim();
    let priority = -1;
    if (family === 'python') {
      priority = /^(?:class)\s/.test(text) ? 0 : /^(?:async\s+)?def\s/.test(text) ? 1 : isPythonDeclaration(line) ? 2 : -1;
    } else if (family === 'ruby') {
      priority = /^(?:class|module)\s/.test(text) ? 0 : /^def\s/.test(text) ? 1 : isRubyDeclaration(line) ? (/^attr_/.test(text) ? 3 : 2) : -1;
    } else if (isCLikeDeclaration(line)) {
      priority = /^#\s*include\b/.test(text) ? 2
        : /^(?:public|private|protected)\s*:/.test(text) ? (options.members ? 3 : -1)
          : /\b(?:class|struct|enum|interface|namespace|union)\s+[A-Za-z_]/.test(text) && !text.includes('(') ? 0 : 1;
    } else if (options.members && isMemberDeclaration(line)) {
      priority = 3;
    }
    if (priority >= 0) {
      candidates.push({ lineNumber, entry: `${lineNumber}: ${clip(line.replace(/\s+$/, ''), 160)}`, priority });
    }
  }
  // Si no cabe todo: primero lo mas importante y, a igual prioridad, lo mas cerca de la ventana.
  const distance = (lineNumber: number) => (skipTo >= skipFrom
    ? (lineNumber < skipFrom ? skipFrom - lineNumber : lineNumber - skipTo)
    : lineNumber);
  const picked: typeof candidates = [];
  let size = 0;
  for (const candidate of [...candidates].sort((left, right) => left.priority - right.priority || distance(left.lineNumber) - distance(right.lineNumber))) {
    if (size + candidate.entry.length + 1 > maxChars) {
      continue;
    }
    picked.push(candidate);
    size += candidate.entry.length + 1;
  }
  const entries = picked.sort((left, right) => left.lineNumber - right.lineNumber).map((item) => item.entry);
  const omitted = candidates.length - picked.length;
  if (omitted) {
    entries.push(`(${omitted} declaracion(es) mas)`);
  }
  return entries.join('\n');
}

export type RelatedFileCandidate = { path: string; language: string; lines: number; outline?: string };

function baseName(filePath: string) {
  const name = filePath.replace(/\\/g, '/').split('/').pop() || '';
  return name.replace(/\.[^.]+$/, '').toLowerCase();
}

/**
 * Archivos relacionados con el activo, en este orden: el mismo nombre con otra extension (el .h
 * de un .cpp), los que incluye o importa, y los que se llaman como una clase que usa.
 */
export function selectRelatedFiles<T extends RelatedFileCandidate>(activePath: string, activeContent: string, files: T[], max = 3): T[] {
  const activeLower = activePath.replace(/\\/g, '/').toLowerCase();
  const activeBase = baseName(activePath);
  const others = files.filter((file) => file.path.replace(/\\/g, '/').toLowerCase() !== activeLower);
  const included = new Set<string>();
  const includedNames = new Set<string>();
  // Primero las formas con ruta entre comillas (import x from './y', require('./y')): si no, el
  // "import x" de Python se quedaba con el nombre x en vez de la ruta.
  for (const match of String(activeContent || '').matchAll(/^\s*#\s*include\s*"([^"]+)"|^\s*import\s+(?:[^'"\n]+\s+from\s+)?['"]([^'"]+)['"]|^\s*(?:const|let|var)\s+[^=\n]+=\s*require\(\s*['"]([^'"]+)['"]|^\s*require(?:_relative)?\s*\(?\s*['"]([^'"]+)['"]|^\s*from\s+([\w.]+)\s+import\b|^\s*import\s+([\w.]+)\s*(?:$|,|\bas\b)/gm)) {
    const target = match[1] || match[2] || match[3] || match[4] || match[5] || match[6] || '';
    const last = target.replace(/\\/g, '/').split(/[/.]/).filter(Boolean).pop() || '';
    const hasExtension = /\.(?:h|hh|hpp|hxx|py|rb|js|ts|jsx|tsx)$/i.test(target);
    const stem = target.includes('/') || hasExtension ? baseName(target) : last.toLowerCase();
    if (stem) {
      included.add(stem);
    }
    if (hasExtension) {
      includedNames.add((target.replace(/\\/g, '/').split('/').pop() || '').toLowerCase());
    }
  }
  const usedTypes = new Set(
    [...String(activeContent || '').slice(0, 20000).matchAll(/\b([A-Z][A-Za-z0-9_]{2,})\b/g)].map((match) => match[1].toLowerCase()),
  );
  const score = (file: T) => {
    const base = baseName(file.path);
    const name = (file.path.replace(/\\/g, '/').split('/').pop() || '').toLowerCase();
    if (base === activeBase) {return 4;}
    if (includedNames.has(name)) {return 3;}
    if (included.has(base)) {return 2;}
    if (usedTypes.has(base)) {return 1;}
    return 0;
  };
  return others
    .map((file) => ({ file, score: score(file) }))
    .filter((item) => item.score > 0 && (item.file.outline || '').trim())
    .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path))
    .slice(0, max)
    .map((item) => item.file);
}

/** "Declaraciones de archivos relacionados": el resumen de firmas de cada uno, con tope. */
export function formatRelatedDeclarations(files: RelatedFileCandidate[], maxChars = 1500) {
  if (!files.length) {
    return '';
  }
  const parts: string[] = [];
  let size = 0;
  for (const file of files) {
    const outline = String(file.outline || '').trim();
    if (!outline) {
      continue;
    }
    const block = `${file.path}:\n${outline.split('\n').map((line) => `  ${line}`).join('\n')}`;
    if (size + block.length > maxChars) {
      const room = maxChars - size - file.path.length - 4;
      if (room > 120) {
        parts.push(`${file.path}:\n${outline.slice(0, room).split('\n').slice(0, -1).map((line) => `  ${line}`).join('\n')}`);
      }
      break;
    }
    parts.push(block);
    size += block.length + 1;
  }
  return parts.length ? ['Declaraciones de archivos relacionados (numero de linea: firma):', ...parts].join('\n') : '';
}

/** "Otros archivos del proyecto: a.cpp (cpp, 40 lineas), ...": lista corta sin vista previa. */
export function formatOtherFilesLine(files: RelatedFileCandidate[], activePath: string, max = 8) {
  const activeLower = activePath.replace(/\\/g, '/').toLowerCase();
  const others = files.filter((file) => file.path.replace(/\\/g, '/').toLowerCase() !== activeLower);
  const listed = others
    .slice(0, max)
    .map((file) => `${file.path} (${file.language}, ${file.lines} lineas)`);
  if (!listed.length) {
    return '';
  }
  const more = others.length - listed.length;
  return `Otros archivos del proyecto: ${listed.join(', ')}${more > 0 ? ` y ${more} mas` : ''}.`;
}
