// ADACEEN (VS Code): de donde viene un cambio (clic explicito, arreglo rapido, clic del navegador en la cola) y el destino de un reemplazo en cola.
// Movido sin cambios desde src/code-application-guard.ts (solo se agrego "export" y los imports).
import { nonBlankLines } from './code-application-guard';
import type { CodeApplyMode } from './code-application-guard';

// ---------------------------------------------------------------------------
// Que cuenta como clic explicito del estudiante

/**
 * Origenes (el `origin` de adaceen.applySuggestionCompletion) que solo llegan
 * cuando el estudiante pulsa la accion: ventana flotante, CodeLens «Aceptar
 * ayuda», arreglo rapido (Ctrl+.) que el mismo abrio, pista en linea, enlace
 * del hover y comando de la paleta. Un origen que no este aqui (por ejemplo
 * 'quick_fix_auto', el menu que ADACEEN abre solo) se trata como aplicacion
 * automatica.
 */
const EXPLICIT_CLICK_ORIGINS: ReadonlySet<string> = new Set([
  'selection_widget',
  'codelens',
  'quick_fix',
  'inlay_hint',
  'hover',
  'command',
]);

export function isExplicitClickOrigin(origin: string) {
  return EXPLICIT_CLICK_ORIGINS.has(origin);
}

/**
 * Margen para reconocer el menu de arreglos rapidos que ADACEEN abre solo
 * (adaceen.suggestions.autoOpenSelectionActions sin ventana flotante): VS Code
 * pide las acciones enseguida de ejecutar editor.action.quickFix.
 */
export const QUICK_FIX_AUTO_OPEN_WINDOW_MS = 2000;

/**
 * Origen de la accion del arreglo rapido. Si ADACEEN acaba de abrir el menu
 * (autoOpenedAt), la accion recomendada viene preseleccionada y un Enter la
 * aplicaria: no cuenta como clic ('quick_fix_auto'). Con Ctrl+. es 'quick_fix'.
 */
export function quickFixOrigin(autoOpenedAt: number, now = Date.now()): 'quick_fix' | 'quick_fix_auto' {
  const elapsed = now - autoOpenedAt;
  return autoOpenedAt > 0 && elapsed >= 0 && elapsed <= QUICK_FIX_AUTO_OPEN_WINDOW_MS ? 'quick_fix_auto' : 'quick_fix';
}

/**
 * Un reemplazo elegido en el overlay vale como clic reciente hasta 10 minutos
 * despues de pedirlo. Con VS Code abierto se reclama en segundos; si espero mas
 * (VS Code estaba cerrado), aplicarlo sin preguntar seria una sorpresa.
 */
export const OVERLAY_CLICK_MAX_AGE_MS = 10 * 60 * 1000;

export type QueuedCodeActionOrigin = {
  /** Columna source de project_code_actions ('browser_extension' si lo pidio el overlay). */
  source?: string;
  metadata?: Record<string, unknown>;
  /** Hora del servidor al pedirlo y al reclamarlo (ISO). */
  requestedAt?: string;
  claimedAt?: string;
};

/** Cuanto espero el reemplazo en la cola (con las dos horas del servidor); null si no se sabe. */
export function queuedCodeActionAgeMs(action: QueuedCodeActionOrigin, now = Date.now()): number | null {
  const requested = Date.parse(action.requestedAt || '');
  if (!Number.isFinite(requested)) {
    return null;
  }
  const claimed = Date.parse(action.claimedAt || '');
  return Math.max(0, (Number.isFinite(claimed) ? claimed : now) - requested);
}

/**
 * El reemplazo lo acaba de elegir el estudiante en el overlay («Enviar a VS
 * Code» o la paleta de codigo): ese clic es la confirmacion. Sin origen del
 * overlay, con mas de 10 minutos en la cola o sin la hora en que se pidio
 * (no se puede saber si es reciente) se trata como automatico. El comando
 * «Aplicar siguiente reemplazo del navegador» no cuenta: el estudiante no ve
 * cual es el siguiente de la cola.
 */
export function isFreshOverlayClick(action: QueuedCodeActionOrigin, now = Date.now()) {
  const metadata = action.metadata || {};
  const requestedFrom = typeof metadata.requestedFrom === 'string' ? metadata.requestedFrom.trim() : '';
  const fromOverlay = action.source === 'browser_extension' || metadata.source === 'browser_sync_panel' || requestedFrom !== '';
  if (!fromOverlay) {
    return false;
  }
  const age = queuedCodeActionAgeMs(action, now);
  return age !== null && age <= OVERLAY_CLICK_MAX_AGE_MS;
}

export type TextMatch = {
  /** Posicion elegida (-1 si no aparece). */
  index: number;
  /** Veces que aparece: 0, 1 o 2 (dos o mas). */
  count: 0 | 1 | 2;
  /** La elegida toca el cursor o la seleccion de VS Code [focusStart, focusEnd]. */
  atFocus: boolean;
};

/**
 * Donde esta en el archivo el codigo que el estudiante eligio en el overlay. Si
 * aparece varias veces (una llave de cierre, un `i++;`), se usa la que toca el
 * cursor o la seleccion de VS Code, que es la que el estudiante tenia enfocada;
 * si ninguna la toca, la primera.
 */
export function pickTextMatch(text: string, needle: string, focusStart: number, focusEnd: number): TextMatch {
  const first = needle ? text.indexOf(needle) : -1;
  if (first < 0) {
    return { index: -1, count: 0, atFocus: false };
  }
  let count = 0;
  let chosen = -1;
  for (let index = first; index >= 0 && count < 10000; index = text.indexOf(needle, index + 1)) {
    count += 1;
    if (chosen < 0 && index <= focusEnd && index + needle.length >= focusStart) {
      chosen = index;
    }
  }
  return { index: chosen >= 0 ? chosen : first, count: count > 1 ? 2 : 1, atFocus: chosen >= 0 };
}

/**
 * Al insertar: la linea del cursor (o la seleccion) donde se insertaria es la
 * que el estudiante tenia enfocada al elegir la opcion (originalText).
 *   - originalText es una linea (la del cursor que publico VS Code): tiene que
 *     estar ahi.
 *   - originalText esta en blanco (cursor en una linea vacia): la de ahora
 *     tambien tiene que estar en blanco.
 *   - originalText es un fragmento (la seleccion o lo visible alrededor del
 *     cursor): las lineas donde se inserta tienen que estar en el.
 */
export function insertAnchorMatches(anchorText: string, originalText: string) {
  const original = nonBlankLines(String(originalText || ''));
  const anchor = nonBlankLines(String(anchorText || ''));
  if (original.length === 0) {
    return anchor.length === 0;
  }
  if (original.length === 1) {
    return String(anchorText || '').includes(original[0]);
  }
  const fragment = new Set(original);
  return anchor.every((line) => fragment.has(line));
}

/** Donde caera un reemplazo del navegador en el archivo abierto en VS Code. */
export type QueuedTargetCheck = {
  applyMode: CodeApplyMode;
  /** replace/delete: veces que aparece el codigo que eligio (pickTextMatch: 0, 1 o 2). */
  matchCount: number;
  /** replace/delete: la coincidencia elegida toca el cursor o la seleccion (pickTextMatch). */
  matchAtFocus: boolean;
  /** insert: insertAnchorMatches. */
  anchorMatches: boolean;
  /** Linea (1-based) donde se aplicara. */
  line: number;
  fileLabel: string;
};

/**
 * El clic del overlay solo confirma si VS Code aplica el cambio donde el
 * estudiante lo vio: el codigo elegido aparece una sola vez en el archivo (o,
 * si aparece varias, justo donde esta el cursor), o (al insertar) la linea
 * enfocada sigue en su sitio. Si no, el cambio caeria en otra copia, en la
 * seleccion o en la linea del cursor de ese momento, y hay que preguntar.
 */
export function queuedTargetVerified(check: QueuedTargetCheck) {
  if (check.applyMode === 'insert') {
    return check.anchorMatches;
  }
  return check.matchCount === 1 || (check.matchCount > 1 && check.matchAtFocus);
}

/** Aviso de donde se aplicara un reemplazo cuyo destino no se pudo comprobar ('' si se comprobo). */
export function describeQueuedTarget(check: QueuedTargetCheck) {
  if (queuedTargetVerified(check)) {
    return '';
  }
  const file = check.fileLabel || 'el archivo';
  if (check.applyMode === 'insert') {
    return `No encontré en ${file} la línea que tenías enfocada: se insertará debajo de la línea ${check.line}.`;
  }
  if (check.matchCount > 1) {
    return `El código que elegiste aparece varias veces en ${file}: se aplicará en la primera, línea ${check.line}.`;
  }
  return `No encontré en ${file} el código que elegiste (cambió o ya no está): se aplicará en la línea ${check.line}.`;
}

/**
 * Resumen de un reemplazo del navegador que hay que confirmar: su titulo, hace
 * cuanto se pidio (solo si espero mas de 10 minutos) y donde se aplicara si no
 * se pudo comprobar. Va en el aviso «Aplicar reemplazo»/«Omitir» o antepuesto
 * al detalle del dialogo del docente.
 */
export function queuedActionSummary(options: { label: string; ageMs: number | null; targetNote: string }) {
  const waited = options.ageMs !== null && options.ageMs > OVERLAY_CLICK_MAX_AGE_MS
    ? ` (lo pediste en el navegador ${describeWaitTime(options.ageMs)})`
    : '';
  const note = options.targetNote.trim();
  return `${options.label}${waited}.${note ? ` ${note}` : ''}`;
}

/**
 * Hace falta el aviso «Aplicar reemplazo» / «Omitir» de VS Code: solo para un
 * reemplazo que nadie confirmo (ni el clic del estudiante ni el dialogo del
 * guard) y sin adaceen.backend.autoApplyCodeActions.
 */
export function queuedCodeActionNeedsPrompt(options: { explicitClick: boolean; confirmedByGuard: boolean; autoApply: boolean }) {
  return !options.explicitClick && !options.confirmedByGuard && !options.autoApply;
}

/** «hace 25 min», «hace 3 h», «hace 2 dias» (para el aviso de un reemplazo que espero). */
export function describeWaitTime(ageMs: number) {
  const minutes = Math.max(1, Math.round(ageMs / 60_000));
  if (minutes < 60) {
    return `hace ${minutes} min`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `hace ${hours} h`;
  }
  return `hace ${Math.round(hours / 24)} días`;
}
