// ADACEEN (VS Code): la politica del docente para aplicar codigo, como la dice el backend
// (code_application de POST /suggest-tab y la respuesta de apply-check), sin importar vscode ni
// otros modulos del proyecto (0.0.38): types.ts, suggestion-code.ts, suggestion-results.ts y
// code-application-guard.ts la leen de aqui.
//
// Contrato de code_application (docs/arquitectura/contrato-api.md §2.2, backend del 30/10/2026):
//   { allowed, maxLines, remaining, requireConfirmation, countsAsHint, reason, reasonCode,
//     truncation: "none" | "applicable" | "guide",
//     cut: { kind: "prefix", linesShown, linesTotal, endsCleanly }
//        | { kind: "partial", changesShown, changesTotal } | null }
// Solo truncation (con allowed) dice si el codigo recortado se puede aplicar; cut es informativo.
// Un backend anterior no manda truncation ni cut: truncation queda null («no se sabe») y cut null.

/**
 * Los reasonCode que la extension mira, en un solo sitio: los del backend (code_application y
 * apply-check) y los que pone la propia extension (code-application-guard.ts).
 */
export const CODE_APPLICATION_REASON_CODES = {
  /** Se puede aplicar. */
  ok: 'ok',
  /** El docente desactivo la aplicacion de codigo. */
  disabled: 'code_application_disabled',
  /** El codigo pasaba del tope de lineas del docente (en /suggest-tab: se recorto y solo sirve de guia). */
  tooLarge: 'code_application_too_large',
  /** Ya se usaron las aplicaciones permitidas en el archivo. */
  limitReached: 'code_application_limit_reached',
  /** Piloto: el estudiante esta en la condicion sin tutor. */
  pilotNoTutor: 'pilot_no_tutor',
  /** La respuesta del modelo termino a mitad de un bloque de codigo: se cerro y solo sirve de guia. */
  incompleteReply: 'code_application_incomplete_reply',
  /** apply-check sin reasonCode y sin permiso. */
  notAllowed: 'not_allowed',
  /** Sin respuesta de apply-check: el cambio pasa del tope sin conexion. */
  offlineTooLarge: 'offline_too_large',
  /** Sin respuesta de apply-check: el cambio es pequeño y se aplica. */
  offlineAllowed: 'offline_allowed',
  /** El estudiante cancelo el dialogo «Aplicar». */
  cancelledByUser: 'cancelled_by_user',
} as const;

/** Un reasonCode conocido o cualquier otro texto que mande el backend (se guarda tal cual). */
export type CodeApplicationReasonCode =
  | (typeof CODE_APPLICATION_REASON_CODES)[keyof typeof CODE_APPLICATION_REASON_CODES]
  | (string & {});

/** Si el guardarrail recorto el codigo del tutor: no, se puede aplicar el trozo, o solo guia. */
export type CodeTruncation = 'none' | 'applicable' | 'guide';

/** Cuanto del codigo del tutor quedo (solo informativo: no decide si se aplica). */
export type CodeCutSummary =
  /** Las primeras linesShown de linesTotal lineas del bloque; endsCleanly: el corte quedo cerrado. */
  | { kind: 'prefix'; linesShown: number; linesTotal: number; endsCleanly: boolean }
  /** Un reemplazo con changesShown de los changesTotal cambios; las demas lineas quedan igual. */
  | { kind: 'partial'; changesShown: number; changesTotal: number };

/** code_application de /suggest-tab, revisado. */
export type SuggestionCodeApplication = {
  allowed: boolean;
  maxLines: number | null;
  remaining: number | null;
  requireConfirmation: boolean;
  countsAsHint: boolean;
  reason: string;
  /** '' con un backend que no lo manda. */
  reasonCode: CodeApplicationReasonCode;
  /** null: el backend no lo dice (anterior al 30/10/2026) o manda un valor desconocido. */
  truncation: CodeTruncation | null;
  /** null si no se recorto un bloque (o el backend no lo dice). */
  cut: CodeCutSummary | null;
};

/** Lo que de la politica necesita quien decide que se muestra (la ventana y la vista). */
export type CodeApplicationPolicy = Pick<SuggestionCodeApplication, 'allowed' | 'reason' | 'reasonCode'>;

/** Lo que de la politica dice si el backend recorto el codigo (prepareSuggestionCode). */
export type CodeCutPolicy = Pick<SuggestionCodeApplication, 'truncation' | 'reasonCode' | 'cut'>;

/** Texto de siempre cuando el docente no deja aplicar y el backend no dio el motivo. */
export const POLICY_BLOCKED_REASON = 'Tu docente no permite aplicar código aquí: úsalo como guía y escríbelo tú.';

const MAX_REASON_CHARS = 600;
const MAX_REASON_CODE_CHARS = 80;

function text(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function optionalCount(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

/** truncation del backend; null si no viene o no es uno de los valores del contrato. */
export function normalizeCodeTruncation(value: unknown): CodeTruncation | null {
  return value === 'none' || value === 'applicable' || value === 'guide' ? value : null;
}

/** cut del backend; null si no viene o no tiene la forma de uno de los dos tipos. */
export function normalizeCodeCutSummary(value: unknown): CodeCutSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const data = value as Record<string, unknown>;
  if (data.kind === 'prefix') {
    const linesShown = count(data.linesShown);
    const linesTotal = count(data.linesTotal);
    return linesShown === null || linesTotal === null
      ? null
      : { kind: 'prefix', linesShown, linesTotal, endsCleanly: data.endsCleanly === true };
  }
  if (data.kind === 'partial') {
    const changesShown = count(data.changesShown);
    const changesTotal = count(data.changesTotal);
    return changesShown === null || changesTotal === null ? null : { kind: 'partial', changesShown, changesTotal };
  }
  return null;
}

/** code_application de /suggest-tab revisado; null si no viene. Sin allowed: se puede aplicar. */
export function normalizeSuggestionCodeApplication(value: unknown): SuggestionCodeApplication | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const data = value as Record<string, unknown>;
  return {
    allowed: data.allowed !== false,
    maxLines: optionalCount(data.maxLines),
    remaining: optionalCount(data.remaining),
    requireConfirmation: data.requireConfirmation === true,
    countsAsHint: data.countsAsHint === true,
    reason: text(data.reason, MAX_REASON_CHARS),
    reasonCode: text(data.reasonCode, MAX_REASON_CODE_CHARS),
    truncation: normalizeCodeTruncation(data.truncation),
    cut: normalizeCodeCutSummary(data.cut),
  };
}

/**
 * El recorte que dice la politica. Con un backend que no manda truncation (null), un reasonCode
 * tooLarge tambien es guia: el backend de antes del 30/10 ya marcaba asi el codigo recortado.
 */
export function policyTruncation(codeApplication: Pick<SuggestionCodeApplication, 'truncation' | 'reasonCode'> | null | undefined): CodeTruncation | null {
  if (!codeApplication) {
    return null;
  }
  if (codeApplication.truncation === null && codeApplication.reasonCode === CODE_APPLICATION_REASON_CODES.tooLarge) {
    return 'guide';
  }
  return codeApplication.truncation;
}

/**
 * Nota discreta sobre la aplicacion para mostrar junto a la sugerencia: el motivo si el docente no
 * deja aplicar (o POLICY_BLOCKED_REASON) o cuantas aplicaciones quedan. '' si no hay que decir.
 */
export function codeApplicationNote(model: { blocked?: boolean; codeApplication?: SuggestionCodeApplication | null }) {
  const codeApplication = model.codeApplication;
  if (!codeApplication || model.blocked) {
    return '';
  }
  if (codeApplication.allowed === false) {
    return codeApplication.reason || POLICY_BLOCKED_REASON;
  }
  if (codeApplication.remaining !== null) {
    return codeApplication.remaining === 1
      ? 'Te queda 1 aplicación en este archivo.'
      : `Te quedan ${codeApplication.remaining} aplicaciones en este archivo.`;
  }
  return '';
}
