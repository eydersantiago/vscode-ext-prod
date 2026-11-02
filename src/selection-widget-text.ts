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

import type { CodeApplicationPolicy } from './code-application';
import { GUIDE_CODE_LABEL } from './suggestion-guide';
import type { SuggestionGuide } from './suggestion-guide';
import { assertNeverPhase, resolveDisplayedCode, responseAllowsApply, suggestionPhase } from './suggestion-phase';
import type { DisplayedCode, SuggestionPhase } from './suggestion-phase';
import type { SuggestionApplyMode, SuggestionSource } from './types';

/** La accion de la ventana: la misma que la de la sugerencia (insertar, reemplazar o eliminar). */
export type SelectionWidgetMode = SuggestionApplyMode;

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
  source: SuggestionSource;
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
  /**
   * La politica del docente para aplicar en este archivo (code_application: si deja, por que no y
   * su codigo; 0.0.38). null o sin el campo: deja. Lo que descarta la respuesta (bloqueada, sin
   * modelo o pista local) no va aqui: lo deriva responseAllowsApply de las otras banderas.
   */
  codeApplication?: CodeApplicationPolicy | null;
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
  /** El backend respondio sin modelo: solo «Otra sugerencia» (y el resumen), sin pedir codigo. */
  tutorUnavailable?: boolean;
  /**
   * Codigo del tutor que no se aplica con un clic (0.0.38): se muestra de solo lectura, como
   * guia, con su motivo y su causa. Antes la ventana lo escondia y solo quedaba el motivo.
   */
  guide?: SuggestionGuide | null;
  /**
   * 0.0.39: la explicacion que el tutor lleva escrita (en vivo, solo prosa), mientras carga o
   * prepara el codigo. Se muestra en vez de «Cuando llegue la respuesta aparecen aqui el codigo y
   * las acciones», con la nota de que el codigo llega al final.
   */
  partialText?: string;
  /**
   * 0.0.39: la explicacion completa de la respuesta (lista): la ventana la conserva al terminar y
   * pone debajo el codigo y las acciones. Sin ella (pista local, respuesta de antes), el titular.
   */
  explanationText?: string;
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

/** Sin modelo (GPU apagada o sin worker): lo que dice la ventana en vez del texto del backend. */
export const UNAVAILABLE_TEXT = 'El tutor no está disponible ahora: el servidor del modelo no respondió.';
const UNAVAILABLE_NOTE = 'Mientras vuelve, revisa el primer error que muestra el compilador y la línea que indica. «Otra sugerencia» le pregunta otra vez al tutor.';

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

/** Lo que dice la ventana mientras llega la explicacion en vivo (0.0.39). */
export const LIVE_NOTE = 'El tutor está escribiendo: aquí va su explicación; el código y las acciones aparecen al terminar.';

/** Los encabezados de seccion del formato del tutor («1) Resumen:», «2) Sugerencias del codigo:»...). */
const SECTION_HEADING = /^\s*(?:#+\s*)?(?:\*\*)?\s*\d{1,2}\s*[).:-]\s*(?:\*\*)?\s*(resumen|sugerencias?(?:\s+del\s+(?:c[oó]digo|archivo))?|riesgos?|dudas?(?:\s+o\s+riesgos?)?|enlaces?\s+relevantes?)\s*:?\s*(?:\*\*)?\s*$/i;

/**
 * La explicacion viene del modelo y se pinta en un MarkdownString con comandos habilitados: ningun
 * enlace, imagen, definicion de enlace ni autoenlace queda activo (el texto se ve, el enlace no).
 * sanitizeTutorMarkdown ya corta «command:», pero un destino con entidades («command&#58;») se
 * decodifica al pintar.
 */
function neutralizeLinks(text: string) {
  // Dentro de `codigo` el Markdown no arma enlaces y una barra invertida se veria: no se toca.
  return text.split(/(`[^`\n]*`)/).map((part, index) => (index % 2 === 1
    ? part
    : part
      .replace(/!\[/g, '[')
      .replace(/\]\(/g, ']\\(')
      .replace(/^(\s*)\[([^\]\n]*)\]:/gm, '$1\\[$2]:')
      .replace(/</g, '\\<'))).join('');
}

/**
 * La explicacion del tutor (en vivo o la de la respuesta final) lista para la ventana (0.0.39):
 * sanitizada (sanitizeTutorMarkdown: sin enlaces command:), sin imagenes remotas, cortada en un
 * bloque de codigo si llegara uno (el backend ya no los manda en vivo), con los encabezados
 * «1) Resumen:» en negrita y sin sangrias de 4 espacios (no se vuelven bloque de codigo).
 */
export function formatTutorExplanation(text: string) {
  const kept: string[] = [];
  for (const line of sanitizeTutorMarkdown(text).split('\n')) {
    if (/```|~~~/.test(line)) {
      break;
    }
    const heading = SECTION_HEADING.exec(line);
    if (heading) {
      const name = heading[1].trim();
      kept.push(`**${name.charAt(0).toUpperCase()}${name.slice(1)}**`);
      continue;
    }
    kept.push(neutralizeLinks(line).replace(/^[ \t]{4,}/, '  '));
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Scroll de la ventana (0.0.39). La ventana es un hilo de comentarios de VS Code: el cuerpo tiene
 * `max-height: 20em` con su propia barra (ajuste comments.maxHeight, activo por defecto), asi que
 * una explicacion larga hace scroll dentro de la ventana sin hacer nada. Pero cada vez que el
 * cuerpo cambia VS Code lo vacia y lo vuelve a armar, y el scroll vuelve arriba. Por eso:
 *   - en vivo, la explicacion crece hasta lo que cabe sin scroll (LIVE_VISIBLE_LINES lineas
 *     estimadas); despues la ventana deja de cambiar (lo que se ve se queda, el estudiante puede
 *     desplazarse sin saltos) y el resto llega con el final;
 *   - lista, va la explicacion completa y debajo el codigo y las acciones, con scroll si hace
 *     falta; si es larga, una linea arriba avisa que el codigo y las acciones estan al final (los
 *     botones Insertar / Modificar / Eliminar del titulo de la ventana se ven siempre).
 * Con comments.maxHeight en false la ventana crece entera y el que se desplaza es el editor.
 */
export const LIVE_VISIBLE_LINES = 8;
/** Caracteres por linea que se estiman para la ventana (el ancho del editor varia; se estima corto). */
const CHARS_PER_VISUAL_LINE = 70;
export const LIVE_MORE_NOTE = '… el tutor sigue escribiendo: el resto de la explicación aparece al terminar, junto con el código.';
const LONG_READY_NOTE = {
  code: '↓ El código y las acciones están al final de la ventana (desplázate dentro de ella).',
  actions: '↓ Las acciones están al final de la ventana (desplázate dentro de ella).',
};

function visualLines(line: string) {
  return Math.max(1, Math.ceil(line.length / CHARS_PER_VISUAL_LINE));
}

/**
 * Lo que se muestra en vivo: la explicacion (ya formateada) hasta LIVE_VISIBLE_LINES lineas
 * estimadas, por lineas enteras. truncated: quedo mas por mostrar (va con el final). Mientras
 * crece, cada texto empieza con el anterior; ya cortado, no cambia mas.
 */
export function liveExplanationExcerpt(formatted: string): { text: string; truncated: boolean } {
  const lines = formatted.split('\n');
  let used = 0;
  const kept: string[] = [];
  for (const line of lines) {
    used += visualLines(line);
    if (used > LIVE_VISIBLE_LINES) {
      return { text: kept.join('\n').trim(), truncated: true };
    }
    kept.push(line);
  }
  return { text: formatted, truncated: false };
}

function explanationIsLong(formatted: string) {
  return formatted.split('\n').reduce((sum, line) => sum + visualLines(line), 0) > LIVE_VISIBLE_LINES;
}

/** La ventana ofrece acciones de aplicar para este modelo (la misma regla que isSuggestionApplyOffered). */
export function selectionWidgetOffersApply(model: SelectionWidgetModel) {
  return responseAllowsApply(model) && model.codeApplication?.allowed !== false;
}

/** Los botones del titulo (Insertar / Modificar / Eliminar) solo cuando hay algo que aplicar. */
export function selectionWidgetShowsTitleActions(model: SelectionWidgetModel) {
  return suggestionPhase(model) === 'ready' && selectionWidgetOffersApply(model);
}

/** Lo que la ventana muestra del codigo del tutor (0.0.38): la misma regla que la vista «Este archivo». */
export function selectionWidgetCode(model: SelectionWidgetModel): DisplayedCode {
  return resolveDisplayedCode(model);
}

/**
 * Causas de guia que ya dicen por que no se aplica (el tope de lineas, la respuesta cortada o la
 * politica): la nota del backend (code_application.reason) no se repite con otras palabras. Una
 * guia por resumen «...» o llaves sin cerrar no dice nada de la politica: ahi la nota si va.
 */
function guideExplainsWhyNotApplicable(shown: DisplayedCode) {
  return shown.kind === 'guide' && (shown.cause === 'policy_cut' || shown.cause === 'incomplete_reply' || shown.cause === 'policy_blocked');
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

function sourceLabel(model: SelectionWidgetModel, phase: SuggestionPhase) {
  switch (phase) {
    case 'loading':
    case 'pending':
      return '$(sync~spin) consultando al tutor';
    case 'tutor_unavailable':
      return 'tutor no disponible';
    case 'local_fallback':
      return 'pista local (el tutor no respondió)';
    case 'blocked':
    case 'ready':
      if (model.source === 'backend') {
        return model.ragCourseCode ? `tutor · material ${escapeMarkdown(model.ragCourseCode)}` : 'tutor';
      }
      return 'pista local';
    default:
      return assertNeverPhase(phase);
  }
}

export function selectionWidgetTitle(model: SelectionWidgetModel) {
  const phase = suggestionPhase(model);
  switch (phase) {
    case 'pending':
      return model.pendingMode === 'replace' ? 'Preparando una versión mejorada' : 'Preparando código para continuar';
    case 'blocked':
      return 'Mensaje del tutor';
    case 'ready':
      if (model.requestedAction === 'replace' && model.completionMode === 'replace') {
        return 'Versión mejorada de la selección';
      }
      if (model.requestedAction === 'insert' && model.completionMode === 'insert') {
        return 'Código para continuar';
      }
      return 'Sugerencia para la selección';
    case 'loading':
    case 'tutor_unavailable':
    case 'local_fallback':
      return 'Sugerencia para la selección';
    default:
      return assertNeverPhase(phase);
  }
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
  const phase = suggestionPhase(model);
  const lines: string[] = [];
  const range = selectionRangeLabel(model);
  lines.push(`**${selectionWidgetTitle(model)}** (${range}) · ${sourceLabel(model, phase)}`);
  lines.push('');

  // 0.0.39: con la explicacion en vivo (cargando o preparando codigo) va ella, no el titular (la
  // pista local o la sugerencia anterior); lista, la explicacion completa en vez del titular.
  const live = (phase === 'loading' || phase === 'pending')
    ? liveExplanationExcerpt(formatTutorExplanation(model.partialText || ''))
    : { text: '', truncated: false };
  const liveText = live.text ? (live.truncated ? `${live.text}\n\n_${LIVE_MORE_NOTE}_` : live.text) : '';
  const explanation = phase === 'ready' ? formatTutorExplanation(model.explanationText || '') : '';
  if (explanation) {
    if (explanationIsLong(explanation)) {
      lines.push(`_${selectionWidgetCode(model).kind === 'none' ? LONG_READY_NOTE.actions : LONG_READY_NOTE.code}_`);
      lines.push('');
    }
    lines.push(explanation);
    lines.push('');
  } else if (model.headline && !liveText && phase !== 'blocked' && phase !== 'tutor_unavailable') {
    lines.push(escapeMarkdown(model.headline));
    lines.push('');
  }

  const secondary = [
    `[$(refresh) Otra sugerencia](${commandUri('adaceen.refreshSuggestions')})`,
    `[$(book) Resumen y material](${commandUri('adaceen.openFileView')})`,
  ].join(' · ');

  switch (phase) {
    case 'loading':
      if (liveText) {
        lines.push(`_${model.slow ? `${LIVE_NOTE} ${SLOW_NOTE}` : LIVE_NOTE}_`);
        lines.push('');
        lines.push(liveText);
        return lines.join('\n');
      }
      lines.push(`_${model.slow ? SLOW_NOTE : 'Cuando llegue la respuesta aparecen aquí el código y las acciones.'}_`);
      return lines.join('\n');
    case 'pending': {
      const target = model.startLine === model.endLine
        ? `la línea ${model.startLine}`
        : `las líneas ${model.startLine}-${model.endLine}`;
      const waiting = model.pendingMode === 'replace'
        ? `Preparando la versión mejorada de ${target}…`
        : 'Preparando el código para continuar debajo de la selección…';
      lines.push(`$(sync~spin) _${model.slow ? `${waiting} ${SLOW_NOTE}` : waiting}_`);
      if (liveText) {
        lines.push('');
        lines.push(`_${LIVE_NOTE}_`);
        lines.push('');
        lines.push(liveText);
      }
      return lines.join('\n');
    }
    case 'blocked':
      // Mensaje controlado del tutor (ya viene en Markdown) y ninguna accion de aplicar.
      lines.push(sanitizeTutorMarkdown(model.tutorMessage || '') || '_El tutor no propone código para este bloque._');
      lines.push('');
      lines.push(secondary);
      return lines.join('\n');
    case 'tutor_unavailable':
      // Una sola explicacion, sin «respondio sin codigo» y sin pedir codigo (tambien fallaria).
      lines.push(UNAVAILABLE_TEXT);
      lines.push('');
      lines.push(`_${UNAVAILABLE_NOTE}_`);
      lines.push('');
      lines.push(secondary);
      return lines.join('\n');
    case 'local_fallback':
      lines.push('_El tutor no respondió a tiempo: esta es una pista local, sin código. Pide otra sugerencia en un momento._');
      lines.push('');
      lines.push(secondary);
      return lines.join('\n');
    case 'ready':
      break;
    default:
      return assertNeverPhase(phase);
  }

  const offersApply = selectionWidgetOffersApply(model);
  const shown = selectionWidgetCode(model);
  const pushCode = (text: string) => {
    const fence = safeFence(text);
    lines.push(`${fence}${model.language || ''}`);
    lines.push(text);
    lines.push(fence);
    lines.push('');
  };
  if (shown.kind === 'apply') {
    lines.push(shown.mode === 'replace'
      ? '_Versión mejorada (reemplaza la selección):_'
      : '_Código para insertar debajo:_');
    pushCode(shown.code);
    if (model.proposalWarning) {
      lines.push(`$(warning) _${escapeMarkdown(model.proposalWarning)}_`);
      lines.push('');
    }
  } else if (shown.kind === 'guide') {
    // 0.0.38: el codigo se ve siempre. Si no se puede aplicar tal cual (recortado, resumen «...»,
    // llaves sin cerrar) o el docente no deja aplicarlo, como guia de solo lectura con el motivo.
    lines.push(`_${GUIDE_CODE_LABEL}_`);
    pushCode(shown.code);
    lines.push(`$(info) _${escapeMarkdown(shown.reason)}_`);
    lines.push('');
  } else {
    lines.push(`_${escapeMarkdown(model.codeRequestNote || 'El tutor no escribió código para este bloque. Puedes pedírselo con «Proponer una mejora» o «Proponer código para continuar».')}_`);
    lines.push('');
  }

  if (!offersApply) {
    // El docente no permite aplicar codigo aqui. Si la guia ya lo explica (recortado por el tope
    // de lineas o aplicacion no permitida), la nota del backend («pasaba de 5 lineas y se
    // recorto») no lo repite con otras palabras.
    lines.push(secondary);
    if (!guideExplainsWhyNotApplicable(shown)) {
      lines.push('');
      lines.push(`_${escapeMarkdown(model.applicationNote || 'Usa el código como guía y escríbelo tú.')}_`);
    }
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
