// ADACEEN (VS Code): codigo resumido con «...», marcas de recorte del docente y llaves sin cerrar (revision de precision, 0.0.35).
// Movido sin cambios desde src/suggestion-code.ts (solo se agrego "export" y los imports).
import { indentColumns, relativeIndentUnit } from './code-reindent';

/** Palabras que solas no dicen nada del bloque (`else`, `end`...). */
const BARE_KEYWORD = /^(else|end|try|do|begin|then|fi|done|pass|break|continue|default|finally)$/i;

/**
 * Una linea que identifica al bloque: con letras o numeros y que no sea solo
 * una llave, un parentesis o una palabra suelta (`}`, `});`, `} else {`). Sin
 * esto, un fragmento nuevo que termina en `}` «conservaba» la mitad de un bloque
 * de dos lineas que terminaba igual.
 */
export function isSignificantCodeLine(line: string) {
  const words = line.match(/[\p{L}\p{N}_]+/gu) || [];
  return words.some((word) => !BARE_KEYWORD.test(word));
}

// --- Revision de precision (0.0.35) ------------------------------------------
//
// Tecnicas de otros asistentes de codigo (Aider, Continue, SWE-agent) adaptadas al editor:
//   - el modelo a veces resume con "// ..." o "// resto igual" las lineas que no cambian; al
//     reemplazar el bloque, esas lineas se perdian. Se completan con las del bloque original
//     cuando las lineas de alrededor permiten ubicarlas; si no, el codigo no se aplica tal cual;
//   - si copio el margen numerado del contexto ("16| ..."), se quita (code-reindent.ts);
//   - una version del bloque que deja llaves o parentesis sin cerrar no se aplica con un clic
//     (como el linter que SWE-agent corre antes de aceptar una edicion).

/** Linea que resume codigo omitido: "...", "// ...", "# ... resto igual", "// resto del codigo". */
const ELLIPSIS_ALONE = /^(?:\.{3,}|…)\s*(?:(?:\/\/|#|\/\*|<!--|--).*)?$/;
const COMMENTED_ELLIPSIS = /^(?:\/\/+|#+|\/\*+|<!--|--)\s*(?:\.{3,}|…)/;
const ELISION_PHRASE = /\b(?:resto|demas|demás)\b.*\b(?:codigo|código|metodo|método|clase|archivo|funcion|función|igual|bloque)\b|\b(?:sin cambios|igual que antes|se mantiene|codigo existente|código existente|existing code|rest of (?:the )?code|unchanged)\b/i;
const COMMENT_START = /^(?:\/\/+|#(?!\s*(?:include|define|undef|if|ifdef|ifndef|elif|else|endif|pragma)\b)|\/\*+|<!--|--\s)/;

/**
 * COMPATIBILIDAD (quitar en la 0.0.40): marca con la que el backend anterior al 30/10/2026 cortaba
 * un bloque largo, «// ... recortado por la politica del docente: completa el resto tu»
 * (limitCodeBlocks). El backend nuevo ya no la escribe en el codigo (la nota va fuera del bloque) y
 * avisa el recorte con code_application.truncation (policyTruncation en code-application.ts): esto solo queda para
 * un backend sin actualizar y para las respuestas que la cache de /suggest-tab guardo antes.
 * No es un resumen del modelo: las lineas que faltan no estan en el bloque del estudiante, asi que
 * no se pueden completar con las suyas. Con o sin tildes, y con cualquier comentario o "..." delante.
 */
const POLICY_CUT_PREFIX = /^(?:\/\/+|#+|\/\*+|<!--|--|;;|'|\.{3,}|…)/;
const POLICY_CUT_PHRASE = /\brecortad[oa]s?\b[^\n]*\b(?:pol[ií]tica|docente|l[ií]mite)\b/i;

export function isPolicyCutLine(line: string) {
  const text = line.trim();
  return !!text && POLICY_CUT_PREFIX.test(text) && POLICY_CUT_PHRASE.test(text);
}

/** COMPATIBILIDAD (quitar en la 0.0.40): el codigo sin la marca de recorte vieja, y si traia alguna. */
export function stripPolicyCutLines(code: string): { code: string; cut: boolean } {
  const lines = String(code || '').replace(/\r\n?/g, '\n').split('\n');
  const kept = lines.filter((line) => !isPolicyCutLine(line));
  return { code: kept.join('\n'), cut: kept.length !== lines.length };
}

/**
 * "..." solo (o con un comentario), un comentario que empieza con "..." o uno que dice "resto
 * igual", "sin cambios"... No la sintaxis con puntos: "...args", "...(lista)", "typename...".
 * Tampoco la marca de recorte del backend (isPolicyCutLine): esa no se puede completar.
 */
export function isElisionLine(line: string) {
  const text = line.trim();
  if (!text || isPolicyCutLine(text)) {
    return false;
  }
  if (ELLIPSIS_ALONE.test(text) || COMMENTED_ELLIPSIS.test(text)) {
    return true;
  }
  return COMMENT_START.test(text) && ELISION_PHRASE.test(text);
}

/** Primera posicion con texto desde `from` (o el largo si no hay). */
function nextNonBlankIndex(lines: string[], from: number) {
  let index = Math.max(0, from);
  while (index < lines.length && !lines[index]) {
    index += 1;
  }
  return index;
}

/**
 * Posicion del original donde empieza `run` (lineas sin sangria, sin vacias) terminando justo
 * antes de `endPos`; -1 si no coincide o se pasa de `minPos`.
 */
function alignRunBefore(originalTrimmed: string[], run: string[], endPos: number, minPos: number) {
  let pos = endPos;
  let pending = run.length;
  while (pending > 0) {
    pos -= 1;
    if (pos < minPos) {
      return -1;
    }
    if (!originalTrimmed[pos]) {
      continue;
    }
    if (originalTrimmed[pos] !== run[pending - 1]) {
      return -1;
    }
    pending -= 1;
  }
  return pos;
}

/**
 * Completa las lineas que el modelo resumio (isElisionLine) con las del bloque original. Solo
 * cuando no hay duda de cuales son (revision independiente del 21/10/2026):
 *   - la linea con texto justo antes del resumen tiene que estar igual en el original (si el
 *     modelo la cambio, no se sabe si el resumen incluye la linea que reemplazo);
 *   - la siguiente linea significativa despues del resumen tiene que aparecer una sola vez en
 *     lo que queda del original; los cierres sueltos ("}") se alinean con ella o con el final;
 *   - las lineas que se traen del original se pasan a la sangria del modelo (su base y su
 *     unidad), para que el re-indentado de despues las deje en su sitio.
 * null si algo de eso no se cumple: entonces el codigo no se ofrece para aplicar con un clic.
 */
export function expandElisions(code: string, original: string): string | null {
  const codeLines = String(code || '').replace(/\r\n?/g, '\n').split('\n');
  const originalLines = String(original || '').replace(/\r\n?/g, '\n').split('\n');
  const originalTrimmed = originalLines.map((line) => line.trim());
  const isAnchor = (line: string) => !!line.trim() && !isElisionLine(line);
  const modelAnchors = codeLines.filter(isAnchor);
  const originalCode = originalLines.filter((line) => line.trim());
  const modelBase = modelAnchors.length ? Math.min(...modelAnchors.map(indentColumns)) : 0;
  const originalBase = originalCode.length ? Math.min(...originalCode.map(indentColumns)) : 0;
  const modelUnit = relativeIndentUnit(modelAnchors);
  const originalUnit = relativeIndentUnit(originalCode);
  const scale = modelUnit >= 2 && originalUnit >= 2 ? modelUnit / originalUnit : 1;
  const toModelFrame = (line: string) => {
    if (!line.trim()) {
      return '';
    }
    const relative = Math.max(0, indentColumns(line) - originalBase);
    return `${' '.repeat(modelBase + Math.round(relative * scale))}${line.trimStart()}`;
  };
  const out: string[] = [];
  let cursor = 0; // primera linea del original que todavia no se uso
  let sawAnchor = false;
  let lastAnchorMatched = true;
  for (let index = 0; index < codeLines.length; index += 1) {
    const line = codeLines[index];
    if (!isElisionLine(line)) {
      const trimmed = line.trim();
      if (trimmed) {
        let matched = false;
        if (isSignificantCodeLine(trimmed)) {
          const found = originalTrimmed.indexOf(trimmed, cursor);
          if (found >= 0) {
            cursor = found + 1;
            matched = true;
          } else {
            // Linea cambiada que reemplaza 1 por 1 a la del original en `cursor`: la linea que
            // le sigue en el modelo (no un resumen) es la que sigue en el original. Asi «cambio
            // una linea de un if, cierro con "}" y resumo el resto» se completa bien.
            const nextModel = codeLines.slice(index + 1).find((item) => item.trim());
            const here = nextNonBlankIndex(originalTrimmed, cursor);
            if (nextModel && !isElisionLine(nextModel) && here < originalTrimmed.length) {
              const after = nextNonBlankIndex(originalTrimmed, here + 1);
              if (after < originalTrimmed.length && originalTrimmed[after] === nextModel.trim()) {
                cursor = here + 1;
                matched = true;
              }
            }
          }
        } else {
          // Un cierre avanza solo si es la siguiente linea con texto del original.
          let peek = cursor;
          while (peek < originalTrimmed.length && !originalTrimmed[peek]) {
            peek += 1;
          }
          if (originalTrimmed[peek] === trimmed) {
            cursor = peek + 1;
            matched = true;
          }
        }
        sawAnchor = true;
        lastAnchorMatched = matched;
      }
      out.push(line);
      continue;
    }
    if (sawAnchor && !lastAnchorMatched) {
      return null;
    }
    // Lo que viene despues del resumen: cierres hasta la siguiente linea significativa.
    const rest = codeLines.slice(index + 1);
    const significantOffset = rest.findIndex((item) => isAnchor(item) && isSignificantCodeLine(item.trim()));
    const run = (significantOffset < 0 ? rest : rest.slice(0, significantOffset))
      .filter(isAnchor)
      .map((item) => item.trim());
    let until: number;
    if (significantOffset < 0) {
      // Solo quedan cierres (o nada): se alinean con el final del bloque original.
      until = run.length ? alignRunBefore(originalTrimmed, run, originalLines.length, cursor) : originalLines.length;
    } else {
      const anchorText = rest[significantOffset].trim();
      const significantPos = originalTrimmed.indexOf(anchorText, cursor);
      if (significantPos < 0 || originalTrimmed.indexOf(anchorText, significantPos + 1) >= 0) {
        return null;
      }
      until = alignRunBefore(originalTrimmed, run, significantPos, cursor);
    }
    if (until < cursor) {
      return null;
    }
    out.push(...originalLines.slice(cursor, until).map(toModelFrame));
    cursor = until;
  }
  return out.join('\n');
}

export type BracketBalance = { paren: number; bracket: number; brace: number; reliable: boolean };

const C_LIKE = /^(?:c|cpp|c\+\+|h|hpp|cc|cxx|java|javascript|typescript|js|ts|jsx|tsx|javascriptreact|typescriptreact|csharp|cs|go|rust|kotlin|swift|php|scala|dart)$/i;
const HASH_COMMENTS = /^(?:python|py|ruby|rb|shellscript|sh|bash|r|perl|yaml)$/i;

/**
 * Cuenta ( [ { abiertos menos cerrados, sin contar los que van en cadenas ni comentarios.
 * reliable=false si el lenguaje no se conoce (sin reglas de comentarios no se bloquea nada).
 */
export function bracketBalance(code: string, language = ''): BracketBalance {
  const text = String(code || '');
  const cLike = C_LIKE.test(language);
  const hashComments = HASH_COMMENTS.test(language);
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (cLike && char === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      index = end < 0 ? text.length : end;
      continue;
    }
    if (cLike && char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (hashComments && char === '#') {
      const end = text.indexOf('\n', index);
      index = end < 0 ? text.length : end;
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') {
      // Cadena (o caracter): hasta la comilla de cierre sin escapar, sin cruzar lineas salvo `.
      let end = index + 1;
      while (end < text.length && text[end] !== char) {
        if (text[end] === '\\') {
          end += 1;
        } else if (text[end] === '\n' && char !== '`') {
          break;
        }
        end += 1;
      }
      index = end;
      continue;
    }
    if (char === '(') {paren += 1;}
    else if (char === ')') {paren -= 1;}
    else if (char === '[') {bracket += 1;}
    else if (char === ']') {bracket -= 1;}
    else if (char === '{') {brace += 1;}
    else if (char === '}') {brace -= 1;}
  }
  return { paren, bracket, brace, reliable: cLike || hashComments };
}

export function isBalanced(balance: BracketBalance) {
  return balance.paren === 0 && balance.bracket === 0 && balance.brace === 0;
}
