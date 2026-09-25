/**
 * Donde se ofrece «Aceptar ayuda» para la sugerencia activa.
 *
 * Con la ventana flotante abierta sobre la seleccion, ella es la unica que
 * ofrece las acciones (Insertar / Modificar / Eliminar). El CodeLens «Aceptar
 * ayuda: …», la pista en linea «Aceptar ayuda: …» y la decoracion de fin de
 * linea repetian la misma accion a dos centimetros: se apagan mientras la
 * ventana este abierta en ese documento y vuelven cuando se retira (el
 * estudiante movio la seleccion). Si el estudiante la cerro con la X, esa
 * sugerencia quedo descartada: no se vuelve a ofrecer en otro sitio hasta que
 * llegue una nueva. El arreglo rapido (Ctrl+.) no se toca: solo sale si el
 * estudiante lo pide.
 *
 * Sin vscode, con pruebas unitarias.
 */

export type SelectionWidgetPresence = {
  visible: boolean;
  /** Documento donde esta abierta la ventana ('' si no hay ninguna). */
  uriString: string;
};

/**
 * Presencia de la ventana flotante tal como la ve el estudiante: hace falta el
 * hilo de comentarios y que los comentarios se vean en el editor (ajuste
 * comments.visible de VS Code). Con los comentarios ocultos el hilo existe pero
 * no se ve, y el CodeLens y la pista tienen que seguir ofreciendo la accion.
 */
export function selectionWidgetPresence(options: { hasThread: boolean; uriString: string; commentsVisible: boolean }): SelectionWidgetPresence {
  const visible = options.hasThread && options.commentsVisible && !!options.uriString;
  return { visible, uriString: visible ? options.uriString : '' };
}

/** La ventana flotante esta abierta sobre este documento. */
export function selectionWidgetCovers(widget: SelectionWidgetPresence, uriString: string) {
  return widget.visible && !!uriString && widget.uriString === uriString;
}

/** El estudiante cerro con la X la ventana de esta sugerencia (dismissedMetricId). */
export function suggestionDismissed(metricId: string | undefined, dismissedMetricId: string) {
  return !!dismissedMetricId && metricId === dismissedMetricId;
}

/**
 * Modelo para la pista en linea y la decoracion de fin de linea: null mientras
 * la ventana flotante muestra la sugerencia en ese mismo documento, o si el
 * estudiante la cerro con la X.
 */
export function inlineSurfaceModel<T extends { uriString: string; metricId?: string }>(
  model: T | null,
  widget: SelectionWidgetPresence,
  dismissedMetricId = '',
): T | null {
  if (!model || selectionWidgetCovers(widget, model.uriString) || suggestionDismissed(model.metricId, dismissedMetricId)) {
    return null;
  }
  return model;
}

/**
 * El CodeLens agrega «Aceptar ayuda: …» (el resumen «ADACEEN: …» se queda, asi
 * la linea del CodeLens no aparece y desaparece al abrir la ventana).
 */
export function codeLensOffersApply(options: {
  applyOffered: boolean;
  documentUri: string;
  widget: SelectionWidgetPresence;
  metricId?: string;
  dismissedMetricId?: string;
}) {
  return options.applyOffered
    && !selectionWidgetCovers(options.widget, options.documentUri)
    && !suggestionDismissed(options.metricId, options.dismissedMetricId || '');
}
