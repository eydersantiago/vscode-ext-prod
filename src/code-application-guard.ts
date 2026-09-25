import type { TelemetryEventInput } from './telemetry';

/**
 * Guard unico para aplicar codigo del tutor (A10.8).
 *
 * Antes de CUALQUIER cambio que ADACEEN escribe en el archivo del estudiante
 * (ventana flotante Insertar / Modificar / Eliminar, CodeLens "Aceptar
 * ayuda", quick fix, panel y reemplazos que llegan del navegador) se pregunta
 * a POST /api/suggestions/apply-check:
 *
 *   - allowed=false            -> no se aplica, se muestra `reason` y se
 *                                 registra code_application_blocked.
 *   - requireConfirmation=true -> la confirmacion es el clic explicito del
 *                                 estudiante sobre la accion (explicitClick)
 *                                 en un cambio pequeno (hasta
 *                                 CLICK_CONFIRM_MAX_LINES lineas) que no borra
 *                                 codigo: no se abre otro dialogo. Pregunta una
 *                                 aplicacion automatica (sin ese clic), un
 *                                 cambio grande o una eliminacion, aunque
 *                                 adaceen.backend.autoApplyCodeActions este activo.
 *   - fallo de red / sin respuesta valida -> solo se aplica si
 *     linesChanged <= adaceen.codeApplication.offlineMaxLines.
 *
 * El modulo no importa vscode: la peticion, los mensajes y la telemetria
 * llegan como dependencias, asi el flujo completo se prueba con node:test.
 */

export type CodeApplyMode = 'insert' | 'replace' | 'delete';

export type ApplyCheckRequest = {
  decisionId?: string;
  filePath: string;
  language?: string;
  applyMode: CodeApplyMode;
  linesChanged: number;
  charsChanged: number;
  trigger?: string;
};

export type ApplyCheckDecision = {
  allowed: boolean;
  reason: string;
  reasonCode: string;
  maxLines: number | null;
  remaining: number | null;
  requireConfirmation: boolean;
  decisionId: string | null;
};

export const MAX_LINES_CHANGED = 5000;
export const MAX_CHARS_CHANGED = 500000;
export const DEFAULT_OFFLINE_MAX_LINES = 12;

function clampInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function nonBlankLines(text: string) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Tamano del cambio que se va a aplicar.
 *   - insert: lineas no vacias insertadas.
 *   - delete: lineas no vacias eliminadas.
 *   - replace: lineas que cambian de verdad (las que ya estaban igual no
 *     cuentan): max(anadidas, quitadas), comparando lineas sin sangria.
 * charsChanged: caracteres escritos o quitados (en replace, fuera del
 * prefijo y sufijo comunes).
 */
export function measureCodeChange(applyMode: CodeApplyMode, originalText: string, newText: string) {
  const original = originalText || '';
  const next = newText || '';
  let lines = 0;
  let chars = 0;

  if (applyMode === 'insert') {
    lines = nonBlankLines(next).length;
    chars = next.length;
  } else if (applyMode === 'delete') {
    lines = nonBlankLines(original).length;
    chars = original.length;
  } else {
    const pool = new Map<string, number>();
    for (const line of nonBlankLines(original)) {
      pool.set(line, (pool.get(line) || 0) + 1);
    }
    let added = 0;
    for (const line of nonBlankLines(next)) {
      const available = pool.get(line) || 0;
      if (available > 0) {
        pool.set(line, available - 1);
      } else {
        added += 1;
      }
    }
    let removed = 0;
    for (const count of pool.values()) {
      removed += count;
    }
    lines = Math.max(added, removed);

    const shortest = Math.min(original.length, next.length);
    let prefix = 0;
    while (prefix < shortest && original[prefix] === next[prefix]) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < shortest - prefix &&
      original[original.length - 1 - suffix] === next[next.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    chars = Math.max(original.length - prefix - suffix, next.length - prefix - suffix);
  }

  return {
    linesChanged: clampInt(lines, 0, MAX_LINES_CHANGED),
    charsChanged: clampInt(chars, 0, MAX_CHARS_CHANGED),
  };
}

function optionalInt(value: unknown, min: number): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? Math.max(min, Math.floor(number)) : null;
}

/** Normaliza la respuesta de apply-check; null si no trae una decision valida. */
export function parseApplyCheckResponse(data: unknown): ApplyCheckDecision | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (typeof record.allowed !== 'boolean') {
    return null;
  }
  const reasonCode = typeof record.reasonCode === 'string' && record.reasonCode.trim()
    ? record.reasonCode.trim().slice(0, 80)
    : record.allowed ? 'ok' : 'not_allowed';
  return {
    allowed: record.allowed,
    reason: typeof record.reason === 'string' ? record.reason.trim().slice(0, 600) : '',
    reasonCode,
    maxLines: optionalInt(record.maxLines, 0),
    remaining: optionalInt(record.remaining, 0),
    requireConfirmation: record.requireConfirmation === true,
    decisionId: typeof record.decisionId === 'string' && record.decisionId.trim()
      ? record.decisionId.trim().slice(0, 80)
      : null,
  };
}

/** Regla sin conexion: solo cambios pequenos. */
export function isOfflineApplicationAllowed(linesChanged: number, offlineMaxLines: number) {
  const max = Number.isFinite(offlineMaxLines) ? Math.max(0, Math.floor(offlineMaxLines)) : DEFAULT_OFFLINE_MAX_LINES;
  return linesChanged <= max;
}

export function defaultBlockedReason(reasonCode: string) {
  switch (reasonCode) {
    case 'code_application_disabled':
      return 'Tu docente desactivó la aplicación de código del tutor. Usa la sugerencia como guía y escríbela tú.';
    case 'code_application_too_large':
      return 'El cambio es demasiado grande para aplicarlo automáticamente. Úsalo como guía y escríbelo tú.';
    case 'code_application_limit_reached':
      return 'Ya usaste todas las aplicaciones de código permitidas en este archivo. Sigue con la sugerencia como guía.';
    default:
      return 'Tu docente no permite aplicar este cambio automáticamente. Úsalo como guía.';
  }
}

/**
 * Hasta cuantas lineas el clic del estudiante basta como la confirmacion que
 * pide el docente (requireConfirmation). Un cambio mas grande, o uno que borra
 * codigo, abre igual el dialogo «Aplicar»: un clic sin querer en un CodeLens no
 * reescribe ni borra un bloque entero sin una pausa.
 */
export const CLICK_CONFIRM_MAX_LINES = 5;

/** El clic sobre la accion basta como confirmacion para este cambio. */
export function clickConfirmsChange(applyMode: CodeApplyMode, linesChanged: number) {
  return applyMode !== 'delete' && linesChanged <= CLICK_CONFIRM_MAX_LINES;
}

/** Detalle del dialogo «ADACEEN: ¿Aplicar el cambio del tutor…?». */
export function confirmationDetail(options: {
  applyMode: CodeApplyMode;
  linesChanged: number;
  explicitClick: boolean;
  confirmDetail?: string;
}) {
  const { applyMode, linesChanged } = options;
  const size = applyMode === 'delete'
    ? `Borra ${linesChanged === 1 ? '1 línea' : `${linesChanged} líneas`}`
    : linesChanged === 1 ? 'Es 1 línea' : `Son ${linesChanged} líneas`;
  // Frases enteras: la guia y la sustentacion citan la de la aplicacion automatica.
  const why = options.explicitClick
    ? `Tu docente pide confirmar los cambios del tutor que borran código o tienen más de ${CLICK_CONFIRM_MAX_LINES} líneas. Puedes deshacerlo con Ctrl+Z.`
    : 'Tu docente pide confirmar antes de aplicar código del tutor. Puedes deshacerlo con Ctrl+Z.';
  const lead = String(options.confirmDetail || '').trim();
  return `${lead ? `${lead} ` : ''}${size}. ${why}`;
}

export type CodeApplicationAttempt = {
  decisionId?: string;
  filePath: string;
  language?: string;
  applyMode: CodeApplyMode;
  /** Texto que se reemplaza o elimina ('' al insertar). */
  originalText: string;
  /** Texto que se escribe ('' al eliminar). */
  newText: string;
  /** Disparador de la sugerencia (cursor_idle, selection, blocking...) o browser_code_action. */
  trigger?: string;
  /** Desde donde se pidio (selection_widget, codelens, quick_fix, browser_code_action...), para las metricas. */
  origin: string;
  /** Nombre corto del archivo para los mensajes. */
  fileLabel?: string;
  /** Solo para la telemetria. */
  repoFullName?: string;
  /**
   * El estudiante pulso esta accion concreta: ventana flotante, CodeLens, arreglo
   * rapido, pista, hover, comando o un reemplazo que acaba de elegir en el overlay
   * (y que VS Code encontro donde el lo vio). En un cambio pequeno que no borra
   * codigo, ese clic es la confirmacion que pide requireConfirmation (sin otro
   * dialogo). Ausente o false = aplicacion automatica: se pregunta.
   */
  explicitClick?: boolean;
  /**
   * Texto que el dialogo de confirmacion antepone a su detalle: que es y donde
   * se aplicara (por ejemplo, un reemplazo del navegador que espero en la cola o
   * cuyo codigo ya no esta donde el estudiante lo eligio).
   */
  confirmDetail?: string;
};

export type CodeApplicationGuardDeps = {
  /** POST /api/suggestions/apply-check. Devuelve el JSON; lanza ante red caida, HTTP no 2xx o tiempo agotado. */
  requestApplyCheck: (request: ApplyCheckRequest) => Promise<unknown>;
  /** Confirmacion del estudiante; true = aplicar. */
  confirm: (message: string, detail: string) => Promise<boolean>;
  /** Mensaje informativo al estudiante. */
  notify: (message: string) => void;
  /** Registra code_application_blocked. */
  track: (event: TelemetryEventInput) => void;
  offlineMaxLines: () => number;
  log?: (line: string) => void;
};

export type CodeApplicationVerdict = {
  allowed: boolean;
  /** No hubo respuesta valida del backend y se uso la regla offline. */
  offline: boolean;
  /** El docente pedia confirmar y el estudiante confirmo (con su clic o en el dialogo). */
  confirmed: boolean;
  /** Como se confirmo: 'click' (el clic sobre la accion), 'dialog' (el modal) o null. */
  confirmedBy: 'click' | 'dialog' | null;
  /** El estudiante cancelo en la confirmacion. */
  cancelled: boolean;
  linesChanged: number;
  charsChanged: number;
  reason: string;
  reasonCode: string;
  remaining: number | null;
  decisionId: string | null;
  requireConfirmation: boolean;
};

function blockedEvent(
  attempt: CodeApplicationAttempt,
  request: ApplyCheckRequest,
  reasonCode: string,
  decisionId: string | null,
  extra: Record<string, unknown>,
): TelemetryEventInput {
  return {
    category: 'code_application',
    eventType: 'code_application_blocked',
    decisionId: decisionId || undefined,
    value: reasonCode,
    filePath: attempt.filePath,
    language: attempt.language,
    repoFullName: attempt.repoFullName,
    metadata: {
      linesChanged: request.linesChanged,
      charsChanged: request.charsChanged,
      applyMode: request.applyMode,
      origin: attempt.origin,
      trigger: attempt.trigger || '',
      ...extra,
    },
  };
}

/**
 * Decide si se puede aplicar el cambio. Nunca lanza: ante cualquier fallo al
 * consultar el backend aplica la regla offline.
 */
export async function guardCodeApplication(
  attempt: CodeApplicationAttempt,
  deps: CodeApplicationGuardDeps,
): Promise<CodeApplicationVerdict> {
  const { linesChanged, charsChanged } = measureCodeChange(attempt.applyMode, attempt.originalText, attempt.newText);
  const request: ApplyCheckRequest = {
    ...(attempt.decisionId ? { decisionId: attempt.decisionId.slice(0, 80) } : {}),
    filePath: (attempt.filePath || 'archivo').slice(0, 700),
    ...(attempt.language ? { language: attempt.language.slice(0, 120) } : {}),
    applyMode: attempt.applyMode,
    linesChanged,
    charsChanged,
    ...(attempt.trigger ? { trigger: attempt.trigger.slice(0, 60) } : {}),
  };
  const base = { linesChanged, charsChanged, confirmed: false, confirmedBy: null, cancelled: false };

  let decision: ApplyCheckDecision | null = null;
  let failure = '';
  try {
    decision = parseApplyCheckResponse(await deps.requestApplyCheck(request));
    if (!decision) {
      failure = 'respuesta sin decision';
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  if (!decision) {
    const maxLines = Math.max(0, Math.floor(Number(deps.offlineMaxLines())));
    const allowed = isOfflineApplicationAllowed(linesChanged, maxLines);
    deps.log?.(
      `[CodeApplication] apply-check sin respuesta (${failure}); regla offline: ${linesChanged} linea(s), maximo ${maxLines} -> ${allowed ? 'se aplica' : 'bloqueado'}.`,
    );
    if (!allowed) {
      const reason = `No se pudo confirmar con el servidor si puedes aplicar este cambio. Sin conexión solo se aplican cambios de hasta ${maxLines} línea(s) y este tiene ${linesChanged}.`;
      deps.notify(`ADACEEN: ${reason}`);
      deps.track(blockedEvent(attempt, request, 'offline_too_large', attempt.decisionId || null, {
        offline: true,
        offlineMaxLines: maxLines,
      }));
      return {
        ...base,
        allowed: false,
        offline: true,
        reason,
        reasonCode: 'offline_too_large',
        remaining: null,
        decisionId: attempt.decisionId || null,
        requireConfirmation: false,
      };
    }
    return {
      ...base,
      allowed: true,
      offline: true,
      reason: '',
      reasonCode: 'offline_allowed',
      remaining: null,
      decisionId: attempt.decisionId || null,
      requireConfirmation: false,
    };
  }

  const decisionId = decision.decisionId || attempt.decisionId || null;
  if (!decision.allowed) {
    const reason = decision.reason || defaultBlockedReason(decision.reasonCode);
    deps.notify(`ADACEEN: ${reason}`);
    deps.track(blockedEvent(attempt, request, decision.reasonCode, decisionId, {
      maxLines: decision.maxLines,
      remaining: decision.remaining,
    }));
    return {
      ...base,
      allowed: false,
      offline: false,
      reason,
      reasonCode: decision.reasonCode,
      remaining: decision.remaining,
      decisionId,
      requireConfirmation: decision.requireConfirmation,
    };
  }

  const clickConfirms = !!attempt.explicitClick && clickConfirmsChange(attempt.applyMode, linesChanged);
  if (decision.requireConfirmation && clickConfirms) {
    // El estudiante acaba de pulsar esta accion y el cambio es pequeno: su clic
    // es la confirmacion que pide el docente. Un segundo dialogo «Aplicar» solo
    // repetia la pregunta.
    return {
      ...base,
      allowed: true,
      offline: false,
      confirmed: true,
      confirmedBy: 'click',
      reason: decision.reason,
      reasonCode: decision.reasonCode,
      remaining: decision.remaining,
      decisionId,
      requireConfirmation: true,
    };
  }

  if (decision.requireConfirmation) {
    // Aplicacion automatica (nadie pulso la accion), o un clic sobre un cambio
    // grande o que borra codigo: se pregunta.
    const where = attempt.fileLabel ? ` en ${attempt.fileLabel}` : '';
    const accepted = await deps.confirm(
      `ADACEEN: ¿Aplicar el cambio del tutor${where}?`,
      confirmationDetail({
        applyMode: attempt.applyMode,
        linesChanged,
        explicitClick: !!attempt.explicitClick,
        confirmDetail: attempt.confirmDetail,
      }),
    );
    if (!accepted) {
      return {
        ...base,
        allowed: false,
        offline: false,
        cancelled: true,
        reason: 'Cancelado por el estudiante.',
        reasonCode: 'cancelled_by_user',
        remaining: decision.remaining,
        decisionId,
        requireConfirmation: true,
      };
    }
    return {
      ...base,
      allowed: true,
      offline: false,
      confirmed: true,
      confirmedBy: 'dialog',
      reason: decision.reason,
      reasonCode: decision.reasonCode,
      remaining: decision.remaining,
      decisionId,
      requireConfirmation: true,
    };
  }

  return {
    ...base,
    allowed: true,
    offline: false,
    reason: decision.reason,
    reasonCode: decision.reasonCode,
    remaining: decision.remaining,
    decisionId,
    requireConfirmation: false,
  };
}

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
