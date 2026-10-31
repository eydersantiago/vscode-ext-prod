// ADACEEN (VS Code): el codigo que trae una sugerencia y para que accion sirve (0.0.34).
//
// Reunion del 20/10/2026: cuando ADACEEN sugeria codigo, lo unico que hacia era
// agregar un comentario «TODO: ...» (la extension lo inventaba si el modelo no
// traia un bloque) y «Modificar seleccion» cambiaba el bloque elegido por un
// fragmento escrito para insertar. Ahora:
//   - el codigo sale solo del bloque del modelo, y un bloque que es solo
//     comentarios (un TODO) no cuenta como codigo;
//   - cada sugerencia sabe para que accion se escribio su codigo
//     (completionMode). Las demas acciones piden su propio codigo al tutor
//     antes de aplicar nada (extension.ts, requestCodeForMode).
// Sin importar vscode: se prueba con node:test.
import { indentColumns, relativeIndentUnit, stripLineGutters } from './code-reindent';
import type { SuggestionApplyMode } from './types';

export type EditorCodeAction = 'insert' | 'replace';

/** Directivas del preprocesador de C/C++ y otras que empiezan con # pero son codigo. */
const HASH_CODE = /^#\s*(include|define|undef|if|ifdef|ifndef|elif|else|endif|pragma|import|error|line)\b/i;

function isCommentOrPlaceholderLine(line: string) {
  if (HASH_CODE.test(line)) {
    return false;
  }
  return /^(\/\/|#|\/\*|\*\/|\*(?!\*?\w+\s*=)|<!--|-->|--\s|;;|rem\s)/i.test(line)
    || /^(pass|\.\.\.|…|todo\b.*|fixme\b.*)$/i.test(line);
}

/** Un bloque vacio o hecho solo de comentarios y marcadores (`// TODO: ...`, `pass`, `...`). */
export function isPlaceholderCode(code: string) {
  const lines = String(code || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 0 || lines.every(isCommentOrPlaceholderLine);
}

/** Contenido del primer bloque ``` de una respuesta, sin la valla. */
export function extractFirstCodeFence(value: string) {
  const match = String(value || '').match(/```(?:[A-Za-z0-9_+#-]+)?[^\S\r\n]*\r?\n([\s\S]*?)```/);
  return match?.[1]?.trimEnd() || '';
}

/** El codigo de la respuesta del tutor, o '' si no trae codigo de verdad. */
export function extractSuggestionCode(output: string) {
  // 0.0.35: sin el margen numerado antes de decidir la accion o si es un marcador (revision
  // independiente: con el margen, un «// TODO» pasaba por codigo y un bloque completo, por
  // un fragmento para insertar).
  const code = stripLineGutters(extractFirstCodeFence(output));
  return isPlaceholderCode(code) ? '' : code;
}

export function normalizeActionProbe(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // "insert_after_line" -> "insert after line": sin esto \b no separa
    // "insert" de "_after" y la accion se aplicaba como reemplazo.
    .replace(/[_-]+/g, ' ');
}

/** Solo la linea explicita "Aplicar: insert|replace|delete" (o accion/modo). */
export function explicitActionMode(value: string): SuggestionApplyMode | '' {
  const probe = normalizeActionProbe(value);
  const explicit = probe.match(/\b(?:accion|aplicar|modo|action|apply)\s*:\s*`?(insert|insertar|add|replace|reemplazar|modificar|update|delete|eliminar|borrar|remove)\b/);
  const token = explicit?.[1] || '';
  if (/^(delete|eliminar|borrar|remove)$/.test(token)) {
    return 'delete';
  }
  if (/^(replace|reemplazar|modificar|update)$/.test(token)) {
    return 'replace';
  }
  if (/^(insert|insertar|add)$/.test(token)) {
    return 'insert';
  }
  return '';
}

/** La linea explicita o, sin ella, los verbos del texto (elimina, corrige, agrega...). */
export function actionModeFromText(value: string): SuggestionApplyMode | '' {
  const explicit = explicitActionMode(value);
  if (explicit) {
    return explicit;
  }
  const probe = normalizeActionProbe(value);
  if (/\b(elimina|eliminar|borra|borrar|quita|quitar|remueve|remover|retira|retirar|delete|remove)\b/.test(probe)) {
    return 'delete';
  }
  if (/\b(modifica|modificar|reemplaza|reemplazar|cambia|cambiar|actualiza|actualizar|corrige|corregir|refactoriza|refactorizar|replace|update|fix)\b/.test(probe)) {
    return 'replace';
  }
  if (/\b(agrega|agregar|anade|anadir|inserta|insertar|crea|crear|implementa|implementar|add|insert|append)\b/.test(probe)) {
    return 'insert';
  }
  return '';
}

/**
 * Accion recomendada y accion para la que sirve el codigo: la linea "Aplicar:"
 * del foco, el pedido del estudiante o, sin ninguno, los verbos. Eliminar no
 * usa codigo.
 *
 * El contenido corrige al modelo cuando se equivoca (revision del 20/10/2026):
 *   - si la linea "Aplicar:" contradice el pedido del estudiante, decide si el
 *     codigo conserva la mitad o mas del bloque (una version del bloque:
 *     replace) o no (un fragmento: insert). Antes mandaba el pedido y un
 *     fragmento de una linea podia quedar como «version mejorada» de tres;
 *   - un codigo «para insertar» que ya trae la mitad o mas del bloque
 *     seleccionado (2 lineas o mas) es una version del bloque: insertarlo lo
 *     duplicaria.
 * El backend usa la misma regla al revisar el limite de lineas
 * (suggestion-policy.ts, replaceWithinLimit).
 */
export function resolveSuggestionModes(options: {
  focusText: string;
  code: string;
  requestedAction?: EditorCodeAction | '';
  fallbackText?: string;
  /** El bloque que vio el tutor ('' sin seleccion). */
  selection?: string;
}): { applyMode: SuggestionApplyMode; completionMode: SuggestionApplyMode | ''; completionText: string } {
  const explicit = explicitActionMode(options.focusText);
  const requested = options.requestedAction || '';
  let applyMode: SuggestionApplyMode = explicit
    || requested
    || actionModeFromText(options.fallbackText ?? options.focusText)
    || 'insert';
  const code = options.code.trim() ? options.code : '';
  if (code) {
    const kept = keptSelectionLines(options.selection || '', code);
    const keepsBlock = kept.total > 0 && kept.kept / kept.total >= 0.5;
    if (explicit && requested && explicit !== requested) {
      // Tambien «Aplicar: delete» con codigo cuando se pidio mejorar o continuar.
      applyMode = keepsBlock ? 'replace' : 'insert';
    } else if (applyMode === 'insert' && keepsBlock && kept.kept >= 2) {
      applyMode = 'replace';
    }
  }
  if (applyMode === 'delete' || !code) {
    return { applyMode, completionMode: '', completionText: '' };
  }
  return { applyMode, completionMode: applyMode, completionText: code };
}

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

/** Lineas significativas del bloque que aparecen en el codigo (contando repeticiones). */
function keptSelectionLines(selection: string, code: string) {
  const original = nonBlankTrimmedLines(selection).filter(isSignificantCodeLine);
  const pool = new Map<string, number>();
  for (const line of nonBlankTrimmedLines(code)) {
    pool.set(line, (pool.get(line) || 0) + 1);
  }
  let kept = 0;
  for (const line of original) {
    const available = pool.get(line) || 0;
    if (available > 0) {
      pool.set(line, available - 1);
      kept += 1;
    }
  }
  return { kept, total: original.length };
}

/**
 * Parte de las lineas significativas del bloque (sin sangria, contando
 * repeticiones) que aparece en el codigo. Una version mejorada copia las que no
 * cambian; un fragmento para insertar casi no repite ninguna. 0 sin bloque.
 */
export function retainedSelectionFraction(selection: string, code: string) {
  const { kept, total } = keptSelectionLines(selection, code);
  return total ? kept / total : 0;
}

/**
 * El bloque que analizo el tutor sigue igual en el documento: cada linea del
 * texto analizado esta en la misma linea del bloque (la primera puede empezar a
 * mitad de linea). `blockLines` son las lineas completas del documento desde la
 * primera del bloque.
 */
export function analyzedBlockMatches(blockLines: string[], analyzedText: string) {
  const analyzed = String(analyzedText || '').replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  if (!analyzed.join('').trim() || analyzed.length > blockLines.length) {
    return false;
  }
  return analyzed.every((line, index) => String(blockLines[index] ?? '').includes(line.trim()));
}

export type CodeReadiness = {
  completionText?: string;
  completionMode?: SuggestionApplyMode | '';
  applyMode?: SuggestionApplyMode;
};

/** Para que accion sirve el codigo de la sugerencia ('' si no trae). */
export function producedMode(model: CodeReadiness): SuggestionApplyMode | '' {
  if (!String(model.completionText || '').trim()) {
    return '';
  }
  if (model.completionMode !== undefined) {
    return model.completionMode;
  }
  // Modelos de antes de la 0.0.34 (historial): el codigo era el de la accion recomendada.
  return model.applyMode && model.applyMode !== 'delete' ? model.applyMode : '';
}

/** Se puede aplicar `mode` ya, sin pedir codigo al tutor. */
export function suggestionReadyForMode(model: CodeReadiness, mode: SuggestionApplyMode) {
  return mode === 'delete' || producedMode(model) === mode;
}

function nonBlankTrimmedLines(text: string) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Una «version mejorada» que se lleva mas de la mitad del bloque seleccionado
 * (2 lineas o mas): puede ser un fragmento suelto y no el bloque completo. No
 * se bloquea, pero la ventana pide revisarla con «Ver cambios» antes de aplicar.
 */
export function replacementDropsMostOfSelection(selection: string, code: string) {
  const original = nonBlankTrimmedLines(selection);
  if (original.length < 2) {
    return false;
  }
  const pool = new Map<string, number>();
  for (const line of original) {
    pool.set(line, (pool.get(line) || 0) + 1);
  }
  for (const line of nonBlankTrimmedLines(code)) {
    const available = pool.get(line) || 0;
    if (available > 0) {
      pool.set(line, available - 1);
    }
  }
  let removed = 0;
  for (const count of pool.values()) {
    removed += count;
  }
  return removed / original.length > 0.5;
}

export const DROPS_MOST_WARNING = 'Ojo: esta versión cambia o quita buena parte de tu bloque. Revísala con «Ver cambios» antes de aplicarla.';


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
 * Marca con la que el backend corta un bloque largo (0.0.38): «// ... recortado por la politica
 * del docente: completa el resto tu» (limitCodeBlocks en intervention-templates.ts). No es un
 * resumen del modelo: las lineas que faltan no estan en el bloque del estudiante, asi que no se
 * pueden completar con las suyas. Con o sin tildes, y con cualquier comentario o "..." delante.
 */
const POLICY_CUT_PREFIX = /^(?:\/\/+|#+|\/\*+|<!--|--|;;|'|\.{3,}|…)/;
const POLICY_CUT_PHRASE = /\brecortad[oa]s?\b[^\n]*\b(?:pol[ií]tica|docente|l[ií]mite)\b/i;

export function isPolicyCutLine(line: string) {
  const text = line.trim();
  return !!text && POLICY_CUT_PREFIX.test(text) && POLICY_CUT_PHRASE.test(text);
}

/** El codigo sin las marcas de recorte del backend, y si traia alguna. */
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

function isBalanced(balance: BracketBalance) {
  return balance.paren === 0 && balance.bracket === 0 && balance.brace === 0;
}

export type PreparedSuggestionCode = {
  code: string;
  /** Avisos para la ventana (se juntan con proposalWarning). */
  notes: string[];
  /**
   * No se ofrece aplicar este codigo con un clic (se explica en unusableReason). Desde la 0.0.38
   * el codigo igual se muestra, como guia (suggestionCodeFields).
   */
  unusable: boolean;
  unusableReason: string;
  /** El backend lo corto por el limite de lineas del docente (se quito su marca, isPolicyCutLine). */
  policyCut: boolean;
};

export const ELISION_EXPANDED_NOTE = 'El tutor resumió con «...» líneas que no cambian: se completaron con las de tu bloque. Revísalo con «Ver cambios».';
export const ELISION_UNUSABLE_REASON = 'El tutor resumió parte de tu bloque con «...»: aplicarlo así borraría líneas. Úsalo como guía o pide la versión completa con «Proponer una mejora».';
export const ELISION_INSERT_NOTE = 'El código propuesto deja partes sin escribir («...»): complétalas tú antes de compilar.';
export const UNBALANCED_REASON = 'La versión propuesta deja llaves o paréntesis sin cerrar y rompería tu bloque: úsala como guía o pide «Otra sugerencia».';
export const UNBALANCED_INSERT_NOTE = 'Ojo: el código para insertar no cierra todas sus llaves o paréntesis; revisa dónde termina.';
export const POLICY_CUT_REASON = 'Tu docente limita cuántas líneas escribe el tutor: esto es solo el comienzo. Úsalo como guía y completa tú el resto.';
export const POLICY_CUT_NOTE = 'Tu docente limita cuántas líneas escribe el tutor: el código quedó corto, revisa que haga todo lo que necesitas.';

/**
 * El codigo del tutor listo para la ventana y para aplicar (0.0.35): sin margen numerado, con
 * los resumenes "..." completados con el bloque original (en un reemplazo) y revisado el
 * balance de llaves y parentesis.
 *
 * 0.0.38: sin la marca de recorte del backend (antes contaba como un «...» del modelo, el
 * reemplazo no se podia completar y la ventana no mostraba ningun codigo). Despues de quitarla:
 * un codigo para insertar se puede aplicar si cierra sus llaves; una version del bloque cortada
 * nunca (borraria el final del bloque), y queda como guia.
 */
export function prepareSuggestionCode(
  code: string,
  options: { selection?: string; mode?: SuggestionApplyMode | ''; language?: string },
): PreparedSuggestionCode {
  const notes: string[] = [];
  const stripped = stripPolicyCutLines(stripLineGutters(code));
  const policyCut = stripped.cut;
  let text = stripped.code.replace(/\s+$/, '');
  if (!text.trim() || isPlaceholderCode(text)) {
    return { code: '', notes, unusable: false, unusableReason: '', policyCut };
  }
  const selection = String(options.selection || '');
  const language = String(options.language || '');
  const unusable = (reason: string): PreparedSuggestionCode => ({ code: text, notes, unusable: true, unusableReason: reason, policyCut });
  if (policyCut) {
    if (options.mode === 'replace') {
      return unusable(POLICY_CUT_REASON);
    }
    const balance = bracketBalance(text, language);
    if (balance.reliable && !isBalanced(balance)) {
      return unusable(POLICY_CUT_REASON);
    }
    notes.push(POLICY_CUT_NOTE);
  }
  const hasElision = text.split('\n').some(isElisionLine);
  if (hasElision) {
    if (options.mode === 'replace' && selection.trim()) {
      const expanded = expandElisions(text, selection);
      if (expanded === null) {
        return unusable(ELISION_UNUSABLE_REASON);
      }
      text = expanded.replace(/\s+$/, '');
      notes.push(ELISION_EXPANDED_NOTE);
    } else if (options.mode === 'replace') {
      return unusable(ELISION_UNUSABLE_REASON);
    } else {
      notes.push(ELISION_INSERT_NOTE);
    }
  }
  const balance = bracketBalance(text, language);
  if (balance.reliable && !isBalanced(balance)) {
    if (options.mode === 'replace' && selection.trim()) {
      // Solo si el bloque original estaba completo: si no, su version tampoco tiene por que estarlo.
      const originalBalance = bracketBalance(selection, language);
      const sameShape = originalBalance.paren === balance.paren
        && originalBalance.bracket === balance.bracket
        && originalBalance.brace === balance.brace;
      if (isBalanced(originalBalance)) {
        return unusable(UNBALANCED_REASON);
      }
      if (!sameShape) {
        notes.push(UNBALANCED_INSERT_NOTE);
      }
    } else if (options.mode === 'insert') {
      notes.push(UNBALANCED_INSERT_NOTE);
    }
  }
  return { code: text, notes, unusable: false, unusableReason: '', policyCut };
}

/**
 * Los campos del modelo de la sugerencia que salen del codigo preparado (0.0.38). Un codigo que
 * no se puede aplicar ya no se borra: va en guideCode (solo lectura, con el motivo) y la accion
 * queda sin codigo, asi nada lo aplica por error. Antes completionText quedaba vacio y la
 * ventana solo decia «El tutor resumió...» sin mostrar el codigo (piloto del 30/10/2026).
 */
export function suggestionCodeFields(
  prepared: PreparedSuggestionCode,
  modes: { completionMode: SuggestionApplyMode | ''; completionText: string },
): { completionMode: SuggestionApplyMode | ''; completionText: string; guideCode: string; guideReason: string } {
  if (prepared.unusable) {
    return { completionMode: '', completionText: '', guideCode: prepared.code, guideReason: prepared.unusableReason };
  }
  return {
    completionMode: prepared.code ? modes.completionMode : '',
    completionText: prepared.code,
    guideCode: '',
    guideReason: '',
  };
}
