// ADACEEN (VS Code): la fase de una sugerencia y si se ofrece aplicar, derivadas en un solo sitio
// (0.0.37). Sin importar vscode, para probarlo con node:test.
//
// La ventana flotante, el CodeLens, el arreglo rapido, la pista en linea, el hover, la etiqueta
// junto a la linea, la vista «Este archivo» y las metricas miraban cada uno sus propias banderas
// (loading, pendingMode, blocked, source, y desde la 0.0.37 la de «sin modelo») en su propio
// orden: una sugerencia sin modelo podia revelar acciones y contar
// vscode_suggestion_actions_revealed mientras la ventana decia «El tutor no esta disponible».
// Ahora todas preguntan aqui.
import { CODE_APPLICATION_REASON_CODES, POLICY_BLOCKED_REASON } from './code-application';
import type { CodeApplicationPolicy } from './code-application';
import { producedMode, suggestionReadyForMode } from './suggestion-code';
import type { CodeReadiness } from './suggestion-code';
import type { SuggestionGuide } from './suggestion-guide';
import type { SuggestionApplyMode, SuggestionSource } from './types';

/**
 * Lo que la sugerencia muestra ahora:
 *   loading            se esta consultando al tutor
 *   pending            se pidio al tutor el codigo de una accion (mejora o continuar)
 *   blocked            la politica del docente bloqueo la respuesta (solo su mensaje)
 *   tutor_unavailable  el backend respondio sin modelo (GPU apagada o sin worker)
 *   local_fallback     el tutor no respondio a tiempo: pista local, sin codigo
 *   ready              respuesta del tutor (o pista local) lista
 * Que la sugerencia ya se aplico no es una fase: lo dice `applied`, que cada vista mira primero.
 */
export type SuggestionPhase = 'loading' | 'pending' | 'blocked' | 'tutor_unavailable' | 'local_fallback' | 'ready';

/** Lo que hace falta para saber la fase: lo tienen el modelo de la sugerencia y el de la ventana. */
export type SuggestionPhaseInput = {
  loading?: boolean;
  pendingMode?: SuggestionApplyMode | '';
  blocked?: boolean;
  tutorUnavailable?: boolean;
  source: SuggestionSource;
};

export function suggestionPhase(model: SuggestionPhaseInput): SuggestionPhase {
  if (model.loading) {
    return 'loading';
  }
  // Solo se pide codigo para mejorar o continuar; eliminar no espera al tutor.
  if (model.pendingMode === 'replace' || model.pendingMode === 'insert') {
    return 'pending';
  }
  if (model.blocked) {
    return 'blocked';
  }
  if (model.tutorUnavailable) {
    return 'tutor_unavailable';
  }
  if (model.source === 'local-fallback') {
    return 'local_fallback';
  }
  return 'ready';
}

/**
 * La respuesta deja aplicar codigo, este cargando o no: no la bloqueo la politica, hubo modelo y
 * no es una pista local. Si el docente permite aplicar en este archivo (code_application) se
 * mira aparte.
 */
export function responseAllowsApply(model: SuggestionPhaseInput): boolean {
  return !model.blocked && !model.tutorUnavailable && model.source !== 'local-fallback';
}

/** Lo que necesita canOfferRecommendedAction: la fase, si ya se aplico, la politica y el codigo. */
export type RecommendedActionInput = SuggestionPhaseInput & CodeReadiness & {
  applied?: boolean;
  codeApplication?: { allowed?: boolean } | null;
};

/**
 * Se puede ofrecer ahora «Aceptar ayuda» con la accion recomendada (CodeLens, arreglo rapido,
 * pista en linea y hover): la sugerencia esta lista y sin aplicar, la respuesta y la politica lo
 * permiten y, salvo eliminar, el tutor ya escribio el codigo para esa accion.
 */
export function canOfferRecommendedAction(model: RecommendedActionInput): boolean {
  return suggestionPhase(model) === 'ready'
    && !model.applied
    && responseAllowsApply(model)
    && model.codeApplication?.allowed !== false
    && suggestionReadyForMode(model, model.applyMode || 'insert');
}

/** Lo que la ventana flotante y la vista «Este archivo» muestran del codigo del tutor. */
export type DisplayedCode =
  | { kind: 'apply'; code: string; mode: SuggestionApplyMode }
  | ({ kind: 'guide' } & SuggestionGuide)
  | { kind: 'none' };

/** Lo que necesita resolveDisplayedCode (lo tienen el modelo de la sugerencia y el de la ventana). */
export type DisplayedCodeInput = SuggestionPhaseInput & CodeReadiness & {
  applied?: boolean;
  guide?: SuggestionGuide | null;
  /** Lo que dice la politica del docente para aplicar en este archivo (allowed false: no deja). */
  codeApplication?: Partial<CodeApplicationPolicy> | null;
};

function cleanCode(text: string | undefined) {
  const value = String(text || '');
  return value.trim() ? value.replace(/\r\n?/g, '\n').replace(/\n+$/, '') : '';
}

/** Los reasonCode con que el backend manda un codigo recortado como guia (no niegan aplicar por si mismos). */
const CUT_REASON_CODES: readonly string[] = [CODE_APPLICATION_REASON_CODES.tooLarge, CODE_APPLICATION_REASON_CODES.incompleteReply];

/**
 * ¿El docente no deja aplicar por una razon que no es el recorte (desactivado, sin aplicaciones,
 * piloto sin tutor)? El backend solo pone el reasonCode del recorte si antes se podia aplicar; si
 * no, deja el suyo, y la guia tiene que decir ese motivo.
 */
function blockedBeyondCut(policy: DisplayedCodeInput['codeApplication']) {
  const reasonCode = policy?.reasonCode || '';
  return policy?.allowed === false && !!reasonCode && !CUT_REASON_CODES.includes(reasonCode);
}

/**
 * El codigo que se ve (0.0.38), decidido en un solo sitio para la ventana flotante y la vista
 * «Este archivo»:
 *   - el de la accion (producedMode) si se puede aplicar;
 *   - el mismo como guia si el docente no deja aplicar (policy_blocked, con su motivo);
 *   - la guia que dejo prepareSuggestionCode (recortado, resumen «...» o llaves sin cerrar); un
 *     recorte con la aplicacion ya negada por otra razon muestra esa razon (policy_blocked);
 *   - o nada.
 * Nunca se esconde un codigo que el tutor escribio, y una guia nunca se ofrece para aplicar. Solo
 * con la sugerencia lista y sin aplicar (en las demas fases no se muestra codigo).
 */
export function resolveDisplayedCode(model: DisplayedCodeInput): DisplayedCode {
  if (model.applied || suggestionPhase(model) !== 'ready') {
    return { kind: 'none' };
  }
  const policy = model.codeApplication;
  const policyReason = policy?.reason || POLICY_BLOCKED_REASON;
  const code = cleanCode(model.completionText);
  const mode = producedMode(model);
  if (code && mode) {
    // En la fase lista la respuesta deja aplicar (responseAllowsApply); falta la politica.
    return policy?.allowed === false
      ? { kind: 'guide', code, reason: policyReason, cause: 'policy_blocked' }
      : { kind: 'apply', code, mode };
  }
  const guide = model.guide ? cleanCode(model.guide.code) : '';
  if (!guide || !model.guide) {
    return { kind: 'none' };
  }
  return model.guide.cause === 'policy_cut' && blockedBeyondCut(policy)
    ? { kind: 'guide', code: guide, reason: policyReason, cause: 'policy_blocked' }
    : { kind: 'guide', code: guide, reason: model.guide.reason, cause: model.guide.cause };
}

/** Para los switch sobre la fase: si aparece una fase nueva, tsc obliga a decidir que mostrar. */
export function assertNeverPhase(phase: never): never {
  throw new Error(`Fase de sugerencia sin manejar: ${String(phase)}`);
}
