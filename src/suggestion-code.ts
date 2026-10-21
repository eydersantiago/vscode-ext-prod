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
  const code = extractFirstCodeFence(output);
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

