// ADACEEN (VS Code): el codigo del tutor que se muestra solo como guia (0.0.38), sin importar
// vscode ni otros modulos del proyecto. Lo usan el modelo de la sugerencia (types.ts), la ventana
// de la seleccion y la vista «Este archivo»; que se ve lo decide resolveDisplayedCode
// (suggestion-phase.ts).

/**
 * Por que un codigo del tutor se muestra solo como guia (de solo lectura, sin aplicar):
 *   policy_cut        el backend lo recorto por el tope de lineas del docente;
 *   incomplete_reply  la respuesta del modelo llego cortada a mitad del bloque (no es un limite
 *                     del docente: el backend lo cerro y lo manda como guia);
 *   elision           resumio con «...» lineas del bloque que no se pudieron completar;
 *   unbalanced        deja llaves o parentesis sin cerrar en una version del bloque;
 *   policy_blocked    el docente no deja aplicar codigo en este archivo.
 */
export type GuideCause = 'policy_cut' | 'incomplete_reply' | 'elision' | 'unbalanced' | 'policy_blocked';
export type GuideReason = { reason: string; cause: GuideCause };
/** Codigo del tutor que se ve como guia, con el motivo y la causa. */
export type SuggestionGuide = GuideReason & { code: string };

/** Rotulo del codigo de guia (ventana flotante y vista «Este archivo»). */
export const GUIDE_CODE_LABEL = 'Código de guía (no se aplica con un clic):';
