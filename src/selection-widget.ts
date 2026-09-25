import * as vscode from 'vscode';

/**
 * Ventana flotante anclada a la seleccion.
 *
 * Cuando el estudiante selecciona codigo y llega una sugerencia, se muestra
 * un unico widget pegado a esas lineas con:
 *   - la recomendacion en una frase,
 *   - el codigo sugerido (la "sugerencia de insercion"),
 *   - tres acciones: Insertar debajo / Modificar seleccion / Eliminar seleccion.
 *
 * Se implementa con la API de comentarios de VS Code (CommentController), que
 * es la unica forma que da la API publica de dibujar un panel flotante anclado
 * a un rango del editor, con botones, que funcione igual en escritorio, en
 * Codespaces y en vscode.dev. No depende del lenguaje del archivo.
 *
 * Este modulo no sabe nada del backend: recibe un modelo ya resuelto y lo
 * pinta. Aplicar la accion sigue siendo trabajo de extension.ts
 * (adaceen.applySuggestionCompletion), aqui solo se enlaza.
 */

export type SelectionWidgetMode = 'insert' | 'replace' | 'delete';

export type SelectionWidgetModel = {
  /** Documento al que pertenece la sugerencia. */
  uriString: string;
  /** Primera y ultima linea de la seleccion, en base 1. */
  startLine: number;
  endLine: number;
  /** Frase corta con la recomendacion. */
  headline: string;
  /** Codigo propuesto. Vacio si el backend no propuso codigo. */
  completionText: string;
  /** Lenguaje para el bloque de codigo (java, python, ...). */
  language: string;
  /** Accion que el backend recomienda. */
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
};

export const SELECTION_WIDGET_CONTROLLER_ID = 'adaceen.selection';
/** Hilo con acciones de aplicar (los botones del titulo dependen de este valor en package.json). */
const THREAD_CONTEXT = 'adaceen-suggestion';
/** Hilo solo de lectura: respuesta bloqueada o aplicacion no permitida. */
const THREAD_CONTEXT_READONLY = 'adaceen-suggestion-readonly';
/** Origen que se registra en las metricas al aplicar desde la ventana flotante. */
export const SELECTION_WIDGET_ORIGIN = 'selection_widget';

const MODE_LABEL: Record<SelectionWidgetMode, string> = {
  insert: 'Insertar debajo',
  replace: 'Modificar seleccion',
  delete: 'Eliminar seleccion',
};

const MODE_ICON: Record<SelectionWidgetMode, string> = {
  insert: '$(add)',
  replace: '$(edit)',
  delete: '$(trash)',
};

function commandUri(command: string, args: unknown[] = []) {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

function escapeMarkdown(text: string) {
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

/** La ventana ofrece Insertar / Modificar / Eliminar para este modelo. */
export function selectionWidgetOffersApply(model: SelectionWidgetModel) {
  return !model.blocked && model.applyAllowed !== false;
}

function safeFence(code: string) {
  // Si el codigo trae ``` dentro, se usa una valla mas larga para no romper el bloque.
  const longest = (code.match(/`{3,}/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function sourceLabel(model: SelectionWidgetModel) {
  if (model.loading) {
    return '$(sync~spin) consultando al backend';
  }
  if (model.source === 'backend') {
    return model.ragCourseCode ? `backend · RAG ${escapeMarkdown(model.ragCourseCode)}` : 'backend';
  }
  if (model.source === 'local-fallback') {
    return 'pista local (el backend no respondio)';
  }
  return 'pista local';
}

export function buildSelectionWidgetMarkdown(model: SelectionWidgetModel) {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = {
    enabledCommands: [
      'adaceen.applySuggestionCompletion',
      'adaceen.openAssistant',
      'adaceen.refreshSuggestions',
      'adaceen.selectionWidget.close',
    ],
  };
  md.supportHtml = false;

  const lines: string[] = [];
  const rango = model.startLine === model.endLine
    ? `linea ${model.startLine}`
    : `lineas ${model.startLine}-${model.endLine}`;
  const title = model.blocked && !model.loading ? 'Mensaje del tutor' : 'Sugerencia para la seleccion';
  lines.push(`**${title}** (${rango}) · ${sourceLabel(model)}`);
  lines.push('');

  if (model.headline && !model.blocked) {
    lines.push(escapeMarkdown(model.headline));
    lines.push('');
  }

  if (model.loading) {
    lines.push('_Cuando llegue la respuesta aparecen aqui el codigo y las acciones._');
    md.appendMarkdown(lines.join('\n'));
    return md;
  }

  const secondaryActions = [
    `[$(list-flat) Ver panel](${commandUri('adaceen.openAssistant')})`,
    `[$(refresh) Otra sugerencia](${commandUri('adaceen.refreshSuggestions')})`,
  ];

  if (model.blocked) {
    // Mensaje controlado del tutor (ya viene en Markdown) y ninguna accion de aplicar.
    lines.push(sanitizeTutorMarkdown(model.tutorMessage || '') || '_El tutor no propone codigo para este bloque._');
    lines.push('');
    lines.push(secondaryActions.join(' · '));
    md.appendMarkdown(lines.join('\n'));
    return md;
  }

  if (model.completionText.trim()) {
    const fence = safeFence(model.completionText);
    lines.push(`${fence}${model.language || ''}`);
    lines.push(model.completionText.replace(/\r\n/g, '\n').replace(/\n+$/, ''));
    lines.push(fence);
    lines.push('');
  } else {
    lines.push('_El backend no propuso codigo concreto para este bloque; puedes pedir otra sugerencia o abrir el panel._');
    lines.push('');
  }

  if (!selectionWidgetOffersApply(model)) {
    // El docente no permite aplicar codigo aqui: el codigo queda como guia.
    lines.push(secondaryActions.join(' · '));
    lines.push('');
    lines.push(`_${escapeMarkdown(model.applicationNote || 'Usa el codigo como guia y escribelo tu.')}_`);
    md.appendMarkdown(lines.join('\n'));
    return md;
  }

  const actions = (['insert', 'replace', 'delete'] as SelectionWidgetMode[]).map((mode) => {
    const label = `${MODE_ICON[mode]} ${MODE_LABEL[mode]}`;
    const link = `[${label}](${commandUri('adaceen.applySuggestionCompletion', [mode, SELECTION_WIDGET_ORIGIN])})`;
    return mode === model.recommendedMode ? `**${link}** (recomendada)` : link;
  });
  actions.push(...secondaryActions);
  lines.push(actions.join(' · '));
  lines.push('');
  lines.push(model.applicationNote
    ? `_Todo se puede deshacer con Ctrl+Z. ${escapeMarkdown(model.applicationNote)}_`
    : '_Todo se puede deshacer con Ctrl+Z._');

  md.appendMarkdown(lines.join('\n'));
  return md;
}

export class AdaceenSelectionWidget implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private thread: vscode.CommentThread | null = null;
  private currentKey = '';
  private readonly visibilityEmitter = new vscode.EventEmitter<void>();
  /**
   * Se abrio, se cerro o se movio a otro documento. Con la ventana abierta, el
   * CodeLens y la pista en linea no repiten «Aceptar ayuda» (suggestion-surfaces.ts).
   */
  readonly onDidChangeVisibility = this.visibilityEmitter.event;

  constructor() {
    this.controller = vscode.comments.createCommentController(SELECTION_WIDGET_CONTROLLER_ID, 'ADACEEN');
    // Sin commentingRangeProvider a proposito: el estudiante no crea hilos,
    // solo ve el que ADACEEN abre sobre su seleccion.
    this.controller.options = { prompt: '', placeHolder: '' };
  }

  /** Rango (0-based) que ocupa el widget, o null si no hay ninguno. */
  get range(): vscode.Range | null {
    return this.thread?.range ?? null;
  }

  get uriString(): string {
    return this.thread?.uri.toString() ?? '';
  }

  get visible(): boolean {
    return !!this.thread;
  }

  /**
   * Pinta (o repinta) el widget para el modelo dado. Con null lo oculta.
   * Repintar con el mismo contenido no hace nada, para no parpadear.
   */
  show(model: SelectionWidgetModel | null) {
    if (!model || model.applied || model.startLine <= 0) {
      this.hide();
      return;
    }

    const key = [
      model.uriString,
      model.startLine,
      model.endLine,
      model.loading ? 'loading' : 'ready',
      model.source,
      model.recommendedMode,
      model.headline,
      model.completionText,
      model.blocked ? 'blocked' : 'open',
      model.tutorMessage || '',
      model.applyAllowed === false ? 'readonly' : 'apply',
      model.applicationNote || '',
    ].join('\u0000');
    if (key === this.currentKey && this.thread) {
      return;
    }
    const contextValue = model.loading || selectionWidgetOffersApply(model) ? THREAD_CONTEXT : THREAD_CONTEXT_READONLY;
    const threadLabel = model.loading
      ? 'ADACEEN · cargando'
      : model.blocked ? 'ADACEEN · tutor' : 'ADACEEN · sugerencia';

    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(model.uriString);
    } catch {
      this.hide();
      return;
    }

    const range = new vscode.Range(
      Math.max(0, model.startLine - 1), 0,
      Math.max(0, model.endLine - 1), 0,
    );
    const comment: vscode.Comment = {
      author: { name: 'ADACEEN' },
      body: buildSelectionWidgetMarkdown(model),
      mode: vscode.CommentMode.Preview,
      contextValue,
      label: model.loading
        ? 'cargando'
        : model.blocked
          ? 'mensaje del tutor'
          : selectionWidgetOffersApply(model) ? MODE_LABEL[model.recommendedMode].toLowerCase() : 'solo guia',
    };

    const sameAnchor = this.thread
      && this.thread.uri.toString() === model.uriString
      && this.thread.range?.start.line === range.start.line
      && this.thread.range?.end.line === range.end.line;

    if (sameAnchor && this.thread) {
      // Mismo sitio, contenido nuevo: se actualiza en el sitio para no cerrar y abrir.
      this.thread.comments = [comment];
      this.thread.label = threadLabel;
      this.thread.contextValue = contextValue;
    } else {
      const previousUri = this.uriString;
      this.disposeThread();
      const thread = this.controller.createCommentThread(uri, range, [comment]);
      thread.canReply = false;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.label = threadLabel;
      thread.contextValue = contextValue;
      this.thread = thread;
      if (previousUri !== uri.toString()) {
        // Se abrio (o paso a otro documento): el CodeLens y la pista se recalculan.
        this.visibilityEmitter.fire();
      }
    }
    this.currentKey = key;
  }

  hide() {
    if (this.disposeThread()) {
      this.visibilityEmitter.fire();
    }
  }

  /** Cierra el hilo sin avisar; true si habia uno. */
  private disposeThread() {
    const had = !!this.thread;
    if (this.thread) {
      this.thread.dispose();
      this.thread = null;
    }
    this.currentKey = '';
    return had;
  }

  /**
   * Llamar cuando cambia la seleccion: si el estudiante se fue a otro sitio
   * (o quito la seleccion), el widget se retira solo.
   */
  onSelectionChanged(editor: vscode.TextEditor) {
    if (!this.thread) {
      return;
    }
    if (editor.document.uri.toString() !== this.thread.uri.toString()) {
      this.hide();
      return;
    }
    const sel = editor.selection;
    const range = this.thread.range;
    if (!range) {
      return;
    }
    const startsInside = sel.start.line >= range.start.line && sel.start.line <= range.end.line;
    const endsInside = sel.end.line >= range.start.line && sel.end.line <= range.end.line;
    if (!startsInside && !endsInside) {
      this.hide();
    }
  }

  dispose() {
    this.disposeThread();
    this.controller.dispose();
    this.visibilityEmitter.dispose();
  }
}
