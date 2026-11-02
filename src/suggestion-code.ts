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
// Sin importar vscode: se prueba con node:test. El «...» del modelo, las marcas de recorte y
// las llaves sin cerrar se revisan en suggestion-code-precision.ts.
import { CODE_APPLICATION_REASON_CODES, policyTruncation } from './code-application';
import type { CodeCutPolicy, CodeCutSummary } from './code-application';
import { stripLineGutters } from './code-reindent';
import { bracketBalance, expandElisions, isBalanced, isElisionLine, isSignificantCodeLine, stripPolicyCutLines } from './suggestion-code-precision';
import type { GuideCause, GuideReason, SuggestionGuide } from './suggestion-guide';
import type { ActiveSuggestionModel, SuggestionApplyMode } from './types';

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


// --- Codigo de guia (0.0.38) ---------------------------------------------------------------
// Lo que no se puede aplicar tal cual queda como guia (suggestion-guide.ts) con su causa. El
// recorte del docente llega en code_application (code-application.ts): truncation decide, cut es
// solo para las notas.

export type PreparedSuggestionCode = {
  code: string;
  /** Avisos para la ventana (se juntan con proposalWarning). */
  notes: string[];
  /** null: se puede aplicar con un clic. Si no, por que queda solo como guia (el codigo igual se ve). */
  guideOnly: GuideReason | null;
};

export const ELISION_EXPANDED_NOTE = 'El tutor resumió con «...» líneas que no cambian: se completaron con las de tu bloque. Revísalo con «Ver cambios».';
export const ELISION_GUIDE_REASON = 'El tutor resumió parte de tu bloque con «...»: aplicarlo así borraría líneas. Úsalo como guía o pide la versión completa con «Proponer una mejora».';
export const ELISION_INSERT_NOTE = 'El código propuesto deja partes sin escribir («...»): complétalas tú antes de compilar.';
export const UNBALANCED_REASON = 'La versión propuesta deja llaves o paréntesis sin cerrar y rompería tu bloque: úsala como guía o pide «Otra sugerencia».';
export const UNBALANCED_INSERT_NOTE = 'Ojo: el código para insertar no cierra todas sus llaves o paréntesis; revisa dónde termina.';
export const POLICY_CUT_REASON = 'Tu docente limita cuántas líneas escribe el tutor: esto es solo el comienzo. Úsalo como guía y completa tú el resto.';
export const POLICY_CUT_NOTE = 'Tu docente limita cuántas líneas escribe el tutor: el código quedó corto, revisa que haga todo lo que necesitas.';
export const INCOMPLETE_REPLY_REASON = 'La respuesta del tutor llegó cortada: úsala como guía o pide «Otra sugerencia».';

/** El motivo de una guia recortada, con cuanto se muestra si el backend lo dice (code_application.cut). */
export function policyCutReason(cut: CodeCutSummary | null | undefined) {
  if (cut?.kind === 'prefix' && cut.linesTotal > cut.linesShown) {
    return `El tutor muestra ${cut.linesShown} de ${cut.linesTotal} líneas: tu docente limita cuántas escribe. Úsalo como guía y completa tú el resto.`;
  }
  if (cut?.kind === 'partial' && cut.changesTotal > cut.changesShown) {
    return `El tutor propone ${cut.changesShown} de ${cut.changesTotal} cambios para tu bloque: tu docente limita cuántos hace. Úsalo como guía y completa tú el resto.`;
  }
  return POLICY_CUT_REASON;
}

/**
 * El aviso de un codigo recortado que si se puede aplicar (truncation applicable), segun cut.kind:
 * prefix, las primeras lineas del bloque; partial, un reemplazo con solo algunos de los cambios.
 */
export function codeCutNote(cut: CodeCutSummary | null | undefined) {
  if (cut?.kind === 'prefix' && cut.linesTotal > cut.linesShown) {
    return `El tutor muestra ${cut.linesShown} de ${cut.linesTotal} líneas: revisa qué falta y complétalo tú.`;
  }
  if (cut?.kind === 'partial' && cut.changesTotal > cut.changesShown) {
    return `Se aplican ${cut.changesShown} de ${cut.changesTotal} cambios; el resto de tus líneas queda igual.`;
  }
  return POLICY_CUT_NOTE;
}

/**
 * El codigo del tutor listo para la ventana y para aplicar (0.0.35): sin margen numerado, con
 * los resumenes "..." completados con el bloque original (en un reemplazo) y revisado el
 * balance de llaves y parentesis.
 *
 * 0.0.38: lo que no se puede aplicar tal cual no se descarta, queda como guia (guideOnly) con su
 * causa. El recorte del docente se sabe por `truncation` (code_application del backend): guide,
 * solo guia; applicable, se aplica con un aviso. Con un backend anterior (truncation vacio) se mira
 * la marca vieja dentro del codigo: una version del bloque cortada nunca se aplica (borraria el
 * final del bloque) y un codigo para insertar solo si cierra sus llaves.
 */
export function prepareSuggestionCode(
  code: string,
  options: {
    selection?: string;
    mode?: SuggestionApplyMode | '';
    language?: string;
    /**
     * Lo que dice code_application del recorte (truncation, reasonCode y cut). null o sin el
     * campo: el backend no lo dijo (anterior al 30/10/2026): se mira la marca vieja en el codigo.
     */
    policy?: CodeCutPolicy | null;
  },
): PreparedSuggestionCode {
  const notes: string[] = [];
  const legacy = stripPolicyCutLines(stripLineGutters(code));
  let text = legacy.code.replace(/\s+$/, '');
  if (!text.trim() || isPlaceholderCode(text)) {
    return { code: '', notes, guideOnly: null };
  }
  const selection = String(options.selection || '');
  const language = String(options.language || '');
  const guideOnly = (cause: GuideCause, reason: string): PreparedSuggestionCode => ({ code: text, notes, guideOnly: { cause, reason } });
  const truncation = policyTruncation(options.policy);
  const cut = options.policy?.cut ?? null;
  if (truncation === 'guide') {
    // La respuesta del modelo llego cortada (no es un limite del docente) o el tope de lineas.
    return options.policy?.reasonCode === CODE_APPLICATION_REASON_CODES.incompleteReply
      ? guideOnly('incomplete_reply', INCOMPLETE_REPLY_REASON)
      : guideOnly('policy_cut', policyCutReason(cut));
  }
  if (truncation === 'applicable') {
    notes.push(codeCutNote(cut));
  } else if (truncation === null && legacy.cut) {
    // COMPATIBILIDAD (quitar en la 0.0.40): backend sin truncation (o su cache), con la marca vieja.
    const balance = bracketBalance(text, language);
    if (options.mode === 'replace' || (balance.reliable && !isBalanced(balance))) {
      return guideOnly('policy_cut', POLICY_CUT_REASON);
    }
    notes.push(POLICY_CUT_NOTE);
  }
  const hasElision = text.split('\n').some(isElisionLine);
  if (hasElision) {
    if (options.mode === 'replace' && selection.trim()) {
      const expanded = expandElisions(text, selection);
      if (expanded === null) {
        return guideOnly('elision', ELISION_GUIDE_REASON);
      }
      text = expanded.replace(/\s+$/, '');
      notes.push(ELISION_EXPANDED_NOTE);
    } else if (options.mode === 'replace') {
      return guideOnly('elision', ELISION_GUIDE_REASON);
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
        return guideOnly('unbalanced', UNBALANCED_REASON);
      }
      if (!sameShape) {
        notes.push(UNBALANCED_INSERT_NOTE);
      }
    } else if (options.mode === 'insert') {
      notes.push(UNBALANCED_INSERT_NOTE);
    }
  }
  return { code: text, notes, guideOnly: null };
}

/**
 * Del codigo preparado a los campos de la sugerencia (0.0.38). Un codigo que no se puede aplicar
 * ya no se borra: va en `guide` (solo lectura, con el motivo y la causa) y la accion queda sin
 * codigo, asi nada lo aplica por error. Antes completionText quedaba vacio y la ventana solo decia
 * «El tutor resumió...» sin mostrar el codigo (piloto del 30/10/2026).
 */
export function toSuggestionCodeFields(
  prepared: PreparedSuggestionCode,
  completionMode: SuggestionApplyMode | '',
): { completionMode: SuggestionApplyMode | ''; completionText: string; guide: SuggestionGuide | null } {
  if (prepared.guideOnly) {
    return { completionMode: '', completionText: '', guide: { code: prepared.code, ...prepared.guideOnly } };
  }
  return { completionMode: prepared.code ? completionMode : '', completionText: prepared.code, guide: null };
}

/** Nota bajo el codigo pedido cuando no es para la accion que se pidio (o no hay codigo). */
export const codeRequestNoteFor = (next: ActiveSuggestionModel, mode: EditorCodeAction) => {
  // Sin modelo la ventana ya explica que el tutor no esta disponible. Con codigo de guia
  // (0.0.38: resumen «...», llaves sin cerrar o recortado) la ventana lo muestra con su motivo.
  if (suggestionReadyForMode(next, mode) || next.tutorUnavailable || next.guide) {
    return '';
  }
  const produced = producedMode(next);
  if (mode === 'replace' && produced === 'insert') {
    return 'El tutor propuso código para continuar en vez de una versión del bloque. Puedes insertarlo o pedir «Otra sugerencia».';
  }
  if (mode === 'insert' && produced === 'replace') {
    return 'El tutor propuso una versión del bloque en vez de código para continuar (insertarla lo duplicaría). Revísala con «Ver cambios».';
  }
  return 'El tutor respondió sin código para esto. Prueba «Otra sugerencia» o escríbelo con la pista.';
};
