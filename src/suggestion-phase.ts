// ADACEEN (VS Code): la fase de una sugerencia, derivada en un solo sitio (0.0.37).
// Sin importar vscode, para probarlo con node:test.
//
// La ventana flotante, el CodeLens, el arreglo rapido, la pista en linea y las metricas miraban
// cada uno sus propias banderas (loading, pendingMode, blocked, source, y desde la 0.0.37 la de
// «sin modelo») en su propio orden: una sugerencia sin modelo podia revelar acciones y contar
// vscode_suggestion_actions_revealed mientras la ventana decia «El tutor no esta disponible».

/** De donde salio la sugerencia (el mismo valor que ActiveSuggestionModel['source']). */
export type SuggestionSource = 'backend' | 'local' | 'local-fallback';

/**
 * Lo que la sugerencia muestra ahora:
 *   loading            se esta consultando al tutor
 *   pending            se pidio al tutor el codigo de una accion (mejora o continuar)
 *   blocked            la politica del docente bloqueo la respuesta (solo su mensaje)
 *   tutor_unavailable  el backend respondio sin modelo (GPU apagada o sin worker)
 *   local_fallback     el tutor no respondio a tiempo: pista local, sin codigo
 *   ready              respuesta del tutor (o pista local) lista
 */
export type SuggestionPhase = 'loading' | 'pending' | 'blocked' | 'tutor_unavailable' | 'local_fallback' | 'ready';

/** Lo que hace falta para saber la fase: lo tienen el modelo de la sugerencia y el de la ventana. */
export type SuggestionPhaseInput = {
  loading?: boolean;
  pendingMode?: string;
  blocked?: boolean;
  tutorUnavailable?: boolean;
  source: string;
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
 * La respuesta misma descarta aplicar codigo, este cargando o no: bloqueada por la politica,
 * sin modelo o pista local. Si el docente permite aplicar aqui (code_application) se mira aparte.
 */
export function suggestionRulesOutApply(model: SuggestionPhaseInput): boolean {
  return !!model.blocked || !!model.tutorUnavailable || model.source === 'local-fallback';
}
