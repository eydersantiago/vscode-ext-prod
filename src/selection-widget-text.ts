// ADACEEN (VS Code): texto (Markdown) de la ventana flotante anclada a la seleccion.
// Sin importar vscode, para probarlo con node:test; selection-widget.ts lo pinta.
//
// 0.0.34 (reunion del 20/10/2026):
//   - El codigo que se muestra es el que escribio el tutor para una accion
//     (completionMode). Esa accion se aplica con un clic y «Ver cambios» abre la
//     comparacion antes de aplicar.
//   - Las otras acciones se ofrecen como «Proponer una mejora» y «Proponer codigo
//     para continuar»: piden su propio codigo al tutor y lo muestran aqui, en vez
//     de aplicar un fragmento escrito para otra cosa (o un «TODO» inventado).
//   - «Ver panel» llevaba al quiz; ahora es «Resumen y material» (vista «Este
//     archivo» con el resumen y el material del curso).

export type SelectionWidgetMode = 'insert' | 'replace' | 'delete';

export type SelectionWidgetModel = {
  /** Documento al que pertenece la sugerencia. */
  uriString: string;
  /** Primera y ultima linea de la seleccion, en base 1. */
  startLine: number;
  endLine: number;
  /** Frase corta con la recomendacion. */
  headline: string;
  /** Codigo propuesto por el tutor. Vacio si no escribio codigo. */
  completionText: string;
  /** Accion para la que sirve completionText ('' si no hay codigo). */
  completionMode: SelectionWidgetMode | '';
  /** Lenguaje para el bloque de codigo (java, python, ...). */
  language: string;
  /** Accion que el tutor recomienda. */
  recommendedMode: SelectionWidgetMode;
  /** De donde salio: backend | local | local-fallback. */
  source: string;
  /** Etiqueta del RAG, p. ej. "FPOO". Vacia si no aplica. */
  ragCourseCode: string;
  loading: boolean;
  applied: boolean;
  /**
   * La politica del docente bloqueo la respuesta: se muestra tutorMessage
   * (Markdown del backend) y no se ofrece aplicar codigo.
   */
  blocked?: boolean;
  tutorMessage?: string;
  /** false cuando el backend dice que no se puede aplicar codigo aqui (code_application.allowed). */
  applyAllowed?: boolean;
  /** Nota discreta bajo las acciones, p. ej. "Te quedan 3 aplicaciones en este archivo". */
  applicationNote?: string;
  /** Se esta pidiendo al tutor el codigo de esta accion. */
  pendingMode?: SelectionWidgetMode | '';
  /** La respuesta tarda mas de lo normal (GPU lenta o encendiendose). */
  slow?: boolean;
  /** El ultimo pedido de codigo llego sin codigo o fallo. */
  codeRequestNote?: string;
  /** La sugerencia responde a un pedido del estudiante (Proponer una mejora / codigo). */
  requestedAction?: SelectionWidgetMode | '';
  /** Aviso sobre el codigo (una version mejorada que quita casi todo el bloque). */
  proposalWarning?: string;
};

/** Comandos que puede abrir un enlace de la ventana (y ninguno mas). */
export const SELECTION_WIDGET_COMMANDS = [
  'adaceen.applySuggestionCompletion',
  'adaceen.showProposalDiff',
  'adaceen.refreshSuggestions',
  'adaceen.openFileView',
  'adaceen.selectionWidget.close',
];

/** Origen que se registra en las metricas al aplicar desde la ventana flotante. */
export const SELECTION_WIDGET_ORIGIN = 'selection_widget';

export const APPLY_LABEL: Record<SelectionWidgetMode, string> = {
  insert: 'Insertar debajo',
  replace: 'Modificar selección',
  delete: 'Eliminar selección',
};

const PROPOSE_LABEL: Record<'insert' | 'replace', string> = {
  replace: 'Proponer una mejora',
  insert: 'Proponer código para continuar',
};

const SLOW_NOTE = 'El tutor está tardando más de lo normal (la GPU puede estar lenta o encendiéndose). La respuesta aparece aquí sola.';

export function commandUri(command: string, args: unknown[] = []) {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

export function escapeMarkdown(text: string) {
  return text.replace(/([\\`*_{}[\]()#+\-!|<>])/g, '\\$1');
}

/**
 * El Markdown que llega del backend se pinta en un MarkdownString con
 * comandos habilitados: se desactivan los enlaces command: que pudiera traer
 * para que un texto del servidor nunca pueda disparar "aplicar" ni otro comando.
 */
export function sanitizeTutorMarkdown(text: string) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/command:/gi, 'command​:')
    .trim();
}

/** La ventana ofrece acciones de aplicar para este modelo. */
export function selectionWidgetOffersApply(model: SelectionWidgetModel) {
  return !model.blocked && model.applyAllowed !== false && model.source !== 'local-fallback';
}

/** Los botones del titulo (Insertar / Modificar / Eliminar) solo cuando hay algo que aplicar. */
export function selectionWidgetShowsTitleActions(model: SelectionWidgetModel) {
  return !model.loading && !model.pendingMode && selectionWidgetOffersApply(model);
}

function safeFence(code: string) {
  // Si el codigo trae ``` dentro, se usa una valla mas larga para no romper el bloque.
  const longest = (code.match(/`{3,}/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

export function selectionRangeLabel(model: Pick<SelectionWidgetModel, 'startLine' | 'endLine'>) {
  return model.startLine === model.endLine
    ? `línea ${model.startLine}`
    : `líneas ${model.startLine}-${model.endLine}`;
}

function sourceLabel(model: SelectionWidgetModel) {
  if (model.loading || model.pendingMode) {
    return '$(sync~spin) consultando al tutor';
  }
  if (model.source === 'backend') {
    return model.ragCourseCode ? `tutor · material ${escapeMarkdown(model.ragCourseCode)}` : 'tutor';
  }
  if (model.source === 'local-fallback') {
    return 'pista local (el tutor no respondió)';
  }
  return 'pista local';
}

export function selectionWidgetTitle(model: SelectionWidgetModel) {
  if (model.loading) {
    return 'Sugerencia para la selección';
  }
  if (model.pendingMode === 'replace') {
    return 'Preparando una versión mejorada';
  }
  if (model.pendingMode === 'insert') {
    return 'Preparando código para continuar';
  }
  if (model.blocked) {
    return 'Mensaje del tutor';
  }
  if (model.requestedAction === 'replace' && model.completionMode === 'replace') {
    return 'Versión mejorada de la selección';
  }
  if (model.requestedAction === 'insert' && model.completionMode === 'insert') {
    return 'Código para continuar';
  }
  return 'Sugerencia para la selección';
}

/** Enlaces de accion, en orden: aplicar (y ver cambios), proponer, eliminar. */
export function selectionWidgetActionLinks(model: SelectionWidgetModel, origin = SELECTION_WIDGET_ORIGIN) {
  const ready = model.completionText.trim() ? model.completionMode : '';
  const apply = (mode: SelectionWidgetMode, label: string, icon: string) =>
    `[${icon} ${label}](${commandUri('adaceen.applySuggestionCompletion', [mode, origin])})`;
  const diff = (mode: SelectionWidgetMode) => `[$(diff) Ver cambios](${commandUri('adaceen.showProposalDiff', [mode])})`;
  const links: string[] = [];
  if (ready) {
    links.push(`**${apply(ready, APPLY_LABEL[ready], '$(check)')}**`, diff(ready));
  } else if (model.recommendedMode === 'delete') {
    links.push(`**${apply('delete', APPLY_LABEL.delete, '$(trash)')}**`, diff('delete'));
  }
  if (ready !== 'replace') {
    links.push(apply('replace', PROPOSE_LABEL.replace, '$(sparkle)'));
  }
  if (ready !== 'insert') {
    links.push(apply('insert', PROPOSE_LABEL.insert, '$(add)'));
  }
  if (ready || model.recommendedMode !== 'delete') {
    links.push(apply('delete', APPLY_LABEL.delete, '$(trash)'));
  }
  return links;
}

export function buildSelectionWidgetText(model: SelectionWidgetModel) {
  const lines: string[] = [];
  const range = selectionRangeLabel(model);
  lines.push(`**${selectionWidgetTitle(model)}** (${range}) · ${sourceLabel(model)}`);
  lines.push('');

  if (model.headline && !model.blocked) {
    lines.push(escapeMarkdown(model.headline));
    lines.push('');
  }

  if (model.loading) {
    lines.push(`_${model.slow ? SLOW_NOTE : 'Cuando llegue la respuesta aparecen aquí el código y las acciones.'}_`);
    return lines.join('\n');
  }

  if (model.pendingMode === 'replace' || model.pendingMode === 'insert') {
    const target = model.startLine === model.endLine
      ? `la línea ${model.startLine}`
      : `las líneas ${model.startLine}-${model.endLine}`;
    const waiting = model.pendingMode === 'replace'
      ? `Preparando la versión mejorada de ${target}…`
      : 'Preparando el código para continuar debajo de la selección…';
    lines.push(`$(sync~spin) _${model.slow ? `${waiting} ${SLOW_NOTE}` : waiting}_`);
    return lines.join('\n');
  }

  const secondary = [
    `[$(refresh) Otra sugerencia](${commandUri('adaceen.refreshSuggestions')})`,
    `[$(book) Resumen y material](${commandUri('adaceen.openFileView')})`,
  ].join(' · ');

  if (model.blocked) {
    // Mensaje controlado del tutor (ya viene en Markdown) y ninguna accion de aplicar.
    lines.push(sanitizeTutorMarkdown(model.tutorMessage || '') || '_El tutor no propone código para este bloque._');
    lines.push('');
    lines.push(secondary);
    return lines.join('\n');
  }

  if (model.source === 'local-fallback') {
    lines.push('_El tutor no respondió a tiempo: esta es una pista local, sin código. Pide otra sugerencia en un momento._');
    lines.push('');
    lines.push(secondary);
    return lines.join('\n');
  }

  const code = model.completionText.trim() ? model.completionText.replace(/\r\n/g, '\n').replace(/\n+$/, '') : '';
  if (code && model.completionMode) {
    lines.push(model.completionMode === 'replace'
      ? '_Versión mejorada (reemplaza la selección):_'
      : '_Código para insertar debajo:_');
    const fence = safeFence(code);
    lines.push(`${fence}${model.language || ''}`);
    lines.push(code);
    lines.push(fence);
    lines.push('');
    if (model.proposalWarning) {
      lines.push(`$(warning) _${escapeMarkdown(model.proposalWarning)}_`);
      lines.push('');
    }
  } else {
    lines.push(`_${escapeMarkdown(model.codeRequestNote || 'El tutor no escribió código para este bloque. Puedes pedírselo con «Proponer una mejora» o «Proponer código para continuar».')}_`);
    lines.push('');
  }

  if (!selectionWidgetOffersApply(model)) {
    // El docente no permite aplicar codigo aqui: el codigo queda como guia.
    lines.push(secondary);
    lines.push('');
    lines.push(`_${escapeMarkdown(model.applicationNote || 'Usa el código como guía y escríbelo tú.')}_`);
    return lines.join('\n');
  }

  lines.push(selectionWidgetActionLinks(model).join(' · '));
  lines.push(secondary);
  lines.push('');
  const undo = 'Todo se puede deshacer con Ctrl+Z (⌘Z en Mac).';
  lines.push(model.applicationNote
    ? `_${undo} ${escapeMarkdown(model.applicationNote)}_`
    : `_${undo}_`);
  return lines.join('\n');
}
