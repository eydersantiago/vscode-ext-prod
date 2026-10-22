// ADACEEN (VS Code): sangria y margen del codigo que propone el tutor (0.0.35).
//
// Revision de precision del 21/10/2026. Antes la sangria solo se tocaba si la primera linea
// del codigo venia sin sangria: un bloque con 4 espacios en un archivo con 2 (o con
// tabuladores) quedaba descuadrado al aplicarlo. Ahora:
//   - reemplazar: se quita la sangria comun del bloque, se convierten los niveles a la unidad
//     del archivo y se pone la sangria del bloque que se reemplaza (reindentCode);
//   - insertar (placeInsertedCode): si el modelo escribio el codigo sin sangria, va a la del
//     lugar (un nivel mas si la linea de arriba abre un bloque); si trae su propia sangria, en
//     Python se respeta (la sangria decide el bloque: "return" despues de un "for" no puede
//     quedar dentro del ciclo) y solo se cambia la unidad; en los lenguajes con llaves manda el
//     lugar donde se inserta.
// Sin importar vscode: se prueba con node:test.

const TAB_WIDTH = 4;

/** Margen numerado que ve el modelo en el contexto ("  16>| codigo", "  15 | codigo"). */
const GUTTER = /^[ \t]*\d+[ \t]*[>]?[ \t]*[|│] ?/;

/**
 * Quita el margen numerado si el modelo lo copio en el bloque: solo si TODAS las lineas con
 * texto lo traen (un "1|" suelto puede ser codigo).
 */
export function stripLineGutters(code: string) {
  const lines = String(code || '').replace(/\r\n?/g, '\n').split('\n');
  const withText = lines.filter((line) => line.trim());
  if (!withText.length || !withText.every((line) => GUTTER.test(line))) {
    return lines.join('\n');
  }
  return lines.map((line) => (line.trim() ? line.replace(GUTTER, '') : '')).join('\n');
}

function leadingWhitespace(line: string) {
  return line.match(/^[ \t]*/)?.[0] || '';
}

function columns(whitespace: string) {
  let width = 0;
  for (const char of whitespace) {
    width = char === '\t' ? width + TAB_WIDTH - (width % TAB_WIDTH) : width + 1;
  }
  return width;
}

function gcd(left: number, right: number): number {
  return right === 0 ? left : gcd(right, left % right);
}

/** Unidad de sangria del editor (editor.options): un tabulador o N espacios. */
export function indentUnitFromOptions(insertSpaces: unknown, tabSize: unknown) {
  const size = Math.min(8, Math.max(1, Math.floor(Number(tabSize) || TAB_WIDTH)));
  return insertSpaces === false ? '\t' : ' '.repeat(size);
}

/**
 * Re-indenta `code` para que su primera sangria sea `targetIndent` y cada nivel use `unit`,
 * conservando la estructura relativa (los niveles del bloque y la alineacion sobrante).
 */
export function reindentCode(code: string, targetIndent: string, unit: string) {
  const lines = String(code || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
  const widths = lines.filter((line) => line.trim()).map((line) => columns(leadingWhitespace(line)));
  if (!widths.length) {
    return '';
  }
  const base = Math.min(...widths);
  const relative = widths.map((width) => width - base).filter((width) => width > 0);
  // Unidad del bloque: el maximo comun divisor de las sangrias relativas (2 o 4 casi siempre).
  // Si da 1 por una linea de continuacion alineada a mano, esa linea no define la unidad.
  let blockUnit = relative.reduce((acc, width) => gcd(acc, width), 0);
  if (blockUnit === 1) {
    const even = relative.filter((width) => width % 2 === 0);
    const evenUnit = even.reduce((acc, width) => gcd(acc, width), 0);
    if (evenUnit >= 2 && even.length >= relative.length - 1) {
      blockUnit = evenUnit;
    }
  }
  // Una "unidad" de 5, 7 o mas de 8 columnas es alineacion a mano, no niveles: se conserva.
  if (blockUnit > 8 || blockUnit === 5 || blockUnit === 7) {
    blockUnit = 0;
  }
  return lines
    .map((line) => {
      if (!line.trim()) {
        return '';
      }
      const offset = columns(leadingWhitespace(line)) - base;
      const levels = blockUnit ? Math.floor(offset / blockUnit) : 0;
      const remainder = blockUnit ? offset - levels * blockUnit : offset;
      return `${targetIndent}${unit.repeat(levels)}${' '.repeat(remainder)}${line.trimStart()}`;
    })
    .join('\n');
}

/** La linea abre un bloque ("{", "(", "[" o ":" al final): el codigo de abajo lleva un nivel mas. */
export function opensBlock(line: string) {
  const code = String(line || '')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/\/\/.*$/, '')
    .replace(/(^|\s)#(?!\s*(?:include|define|undef|if|ifdef|ifndef|elif|else|endif|pragma)\b).*$/, '$1')
    .trimEnd();
  return /[{([:]$/.test(code) && !/::$/.test(code);
}

/**
 * Sangria para codigo que se inserta despues de `anchorLine` (la ultima linea con texto antes
 * del punto de insercion): la de esa linea, un nivel mas si abre un bloque ("{", ":" de Python,
 * "public:" de una clase). Si el codigo empieza cerrando ("}" o "else"), sin el nivel extra.
 */
export function insertTargetIndent(anchorLine: string, unit: string, code: string) {
  const indent = leadingWhitespace(anchorLine);
  const firstCode = String(code || '').split(/\r?\n/).find((line) => line.trim())?.trim() || '';
  const startsClosing = /^[}\])]/.test(firstCode) || /^(?:else|elif|except|finally|catch)\b/.test(firstCode);
  return opensBlock(anchorLine) && !startsClosing ? `${indent}${unit}` : indent;
}

/** Unidad de sangria (columnas) que usa un bloque: el MCD de sus sangrias (2 o 4 casi siempre). */
function blockIndentWidth(widths: number[]) {
  const nonZero = widths.filter((width) => width > 0);
  const unit = nonZero.reduce((acc, width) => gcd(acc, width), 0);
  return unit >= 2 && unit <= 8 ? unit : unit === 1 ? 1 : TAB_WIDTH;
}

/**
 * Cambia el estilo de la sangria (tabuladores o N espacios) conservando los niveles absolutos:
 * un bloque con 4 espacios por nivel en un archivo con 2 queda con 2 por nivel.
 */
export function convertIndentStyle(code: string, unit: string) {
  const lines = String(code || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
  const widths = lines.filter((line) => line.trim()).map((line) => columns(leadingWhitespace(line)));
  if (!widths.length) {
    return '';
  }
  const unitWidth = columns(unit);
  const usesTabs = lines.some((line) => leadingWhitespace(line).includes('\t'));
  const fileUsesTabs = unit === '\t';
  // Mismo estilo y niveles que caben en la unidad del archivo: se deja tal cual.
  if (usesTabs === fileUsesTabs && (fileUsesTabs || widths.every((width) => width % unitWidth === 0))) {
    return lines.map((line) => (line.trim() ? line.replace(/\s+$/, '') : '')).join('\n');
  }
  const blockWidth = usesTabs ? TAB_WIDTH : blockIndentWidth(widths);
  return lines
    .map((line) => {
      if (!line.trim()) {
        return '';
      }
      const width = columns(leadingWhitespace(line));
      const levels = Math.floor(width / blockWidth);
      const remainder = width - levels * blockWidth;
      return `${unit.repeat(levels)}${' '.repeat(remainder)}${line.trimStart().replace(/\s+$/, '')}`;
    })
    .join('\n');
}

/**
 * Codigo para insertar (0.0.35, revision independiente del 21/10/2026).
 *   - Sin sangria propia: va a `targetIndent` (la del lugar; un nivel mas si la linea de arriba
 *     abre un bloque, ver insertTargetIndent).
 *   - Con sangria propia en Python (`semantic`): se respeta si es un nivel valido en ese punto
 *     (no mas adentro que `maxIndent`, el nivel mas profundo que admite la linea de arriba); solo
 *     cambia la unidad. Asi un "return" escrito al nivel de la funcion no queda dentro del ciclo
 *     de arriba, y codigo de nivel superior no se mete en la funcion.
 *   - Con sangria propia en un lenguaje con llaves: manda el lugar, como sin sangria.
 */
export function placeInsertedCode(
  code: string,
  options: { unit: string; targetIndent: string; maxIndent: string; semantic: boolean },
) {
  const clean = String(code || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (!clean.trim()) {
    return '';
  }
  const lines = clean.split('\n');
  const base = Math.min(...lines.filter((line) => line.trim()).map((line) => columns(leadingWhitespace(line))));
  if (base > 0 && options.semantic) {
    const converted = convertIndentStyle(clean, options.unit);
    const convertedBase = Math.min(...converted.split('\n').filter((line) => line.trim()).map((line) => columns(leadingWhitespace(line))));
    if (convertedBase <= columns(options.maxIndent)) {
      return converted;
    }
  }
  return reindentCode(clean, options.targetIndent, options.unit);
}

/** Sangria de una linea (sus espacios y tabuladores iniciales). */
export function indentOf(line: string) {
  return leadingWhitespace(line);
}

/** La sangria con un nivel mas si la linea abre un bloque: el nivel mas profundo valido debajo. */
export function deepestIndentBelow(line: string, unit: string) {
  return opensBlock(line) ? `${leadingWhitespace(line)}${unit}` : leadingWhitespace(line);
}

/** Columnas de la sangria de una linea (un tabulador cuenta hasta la siguiente columna de 4). */
export function indentColumns(line: string) {
  return columns(leadingWhitespace(line));
}

/**
 * Columnas por nivel de un conjunto de lineas: el MCD de sus sangrias relativas a la menor (0 si
 * todas tienen la misma).
 */
export function relativeIndentUnit(lines: string[]) {
  const widths = lines.filter((line) => line.trim()).map(indentColumns);
  if (!widths.length) {
    return 0;
  }
  const base = Math.min(...widths);
  return widths.map((width) => width - base).filter((width) => width > 0).reduce((acc, width) => gcd(acc, width), 0);
}
