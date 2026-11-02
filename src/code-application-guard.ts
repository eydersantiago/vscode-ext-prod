import { CODE_APPLICATION_REASON_CODES } from './code-application';
import type { CodeApplicationReasonCode } from './code-application';
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
 * Que cuenta como clic explicito y el destino de un reemplazo en cola estan en
 * code-application-origin.ts.
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
  reasonCode: CodeApplicationReasonCode;
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

export function nonBlankLines(text: string) {
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
    : record.allowed ? CODE_APPLICATION_REASON_CODES.ok : CODE_APPLICATION_REASON_CODES.notAllowed;
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

export function defaultBlockedReason(reasonCode: CodeApplicationReasonCode) {
  switch (reasonCode) {
    case CODE_APPLICATION_REASON_CODES.disabled:
      return 'Tu docente desactivó la aplicación de código del tutor. Usa la sugerencia como guía y escríbela tú.';
    case CODE_APPLICATION_REASON_CODES.tooLarge:
      return 'El cambio es demasiado grande para aplicarlo automáticamente. Úsalo como guía y escríbelo tú.';
    case CODE_APPLICATION_REASON_CODES.limitReached:
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
  reasonCode: CodeApplicationReasonCode;
  remaining: number | null;
  decisionId: string | null;
  requireConfirmation: boolean;
};

function blockedEvent(
  attempt: CodeApplicationAttempt,
  request: ApplyCheckRequest,
  reasonCode: CodeApplicationReasonCode,
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
        reasonCode: CODE_APPLICATION_REASON_CODES.offlineTooLarge,
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
      reasonCode: CODE_APPLICATION_REASON_CODES.offlineAllowed,
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
        reasonCode: CODE_APPLICATION_REASON_CODES.cancelledByUser,
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

