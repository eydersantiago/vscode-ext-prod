import * as vscode from 'vscode';
import {
  APPLY_LABEL,
  buildSelectionWidgetText,
  SELECTION_WIDGET_COMMANDS,
  selectionWidgetCode,
  selectionWidgetShowsTitleActions,
} from './selection-widget-text';
import type { SelectionWidgetModel } from './selection-widget-text';
import { assertNeverPhase, suggestionPhase } from './suggestion-phase';

export {
  sanitizeTutorMarkdown,
  SELECTION_WIDGET_ORIGIN,
  selectionWidgetOffersApply,
} from './selection-widget-text';
export type { SelectionWidgetMode, SelectionWidgetModel } from './selection-widget-text';

/**
 * Ventana flotante anclada a la seleccion.
 *
 * Cuando el estudiante selecciona codigo y llega una sugerencia, se muestra
 * un unico widget pegado a esas lineas con:
 *   - la recomendacion en una frase,
 *   - el codigo que el tutor escribio para una accion (0.0.34: nunca un
 *     «TODO» inventado),
 *   - aplicar esa accion, ver los cambios antes de aplicar, y pedir el codigo
 *     de otra accion («Proponer una mejora», «Proponer codigo para continuar»).
 *
 * Se implementa con la API de comentarios de VS Code (CommentController), que
 * es la unica forma que da la API publica de dibujar un panel flotante anclado
 * a un rango del editor, con botones, que funcione igual en escritorio, en
 * Codespaces y en vscode.dev. No depende del lenguaje del archivo.
 *
 * Este modulo no sabe nada del backend: recibe un modelo ya resuelto y lo
 * pinta (el texto sale de selection-widget-text.ts). Aplicar la accion sigue
 * siendo trabajo de extension.ts (adaceen.applySuggestionCompletion).
 */

export const SELECTION_WIDGET_CONTROLLER_ID = 'adaceen.selection';
/** Hilo con acciones de aplicar (los botones del titulo dependen de este valor en package.json). */
const THREAD_CONTEXT = 'adaceen-suggestion';
/** Hilo solo de lectura: cargando, respuesta bloqueada, pista local o aplicacion no permitida. */
const THREAD_CONTEXT_READONLY = 'adaceen-suggestion-readonly';

export function buildSelectionWidgetMarkdown(model: SelectionWidgetModel) {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = { enabledCommands: [...SELECTION_WIDGET_COMMANDS] };
  md.supportHtml = false;
  md.appendMarkdown(buildSelectionWidgetText(model));
  return md;
}

function threadLabel(model: SelectionWidgetModel) {
  const phase = suggestionPhase(model);
  switch (phase) {
    case 'loading':
      return model.partialText ? 'ADACEEN · el tutor escribe' : 'ADACEEN · cargando';
    case 'pending':
      return 'ADACEEN · preparando código';
    case 'blocked':
      return 'ADACEEN · tutor';
    case 'tutor_unavailable':
      return 'ADACEEN · tutor no disponible';
    case 'local_fallback':
    case 'ready':
      return 'ADACEEN · sugerencia';
    default:
      return assertNeverPhase(phase);
  }
}

function commentLabel(model: SelectionWidgetModel) {
  const phase = suggestionPhase(model);
  switch (phase) {
    case 'loading':
    case 'pending':
      return model.partialText ? 'en vivo' : 'cargando';
    case 'blocked':
      return 'mensaje del tutor';
    case 'tutor_unavailable':
      return 'tutor no disponible';
    case 'local_fallback':
      return 'pista';
    case 'ready': {
      // 0.0.38: el codigo que solo se muestra como guia tambien se nombra.
      const shown = selectionWidgetCode(model);
      return shown.kind === 'apply' ? APPLY_LABEL[shown.mode].toLowerCase() : shown.kind === 'guide' ? 'código de guía' : 'pista';
    }
    default:
      return assertNeverPhase(phase);
  }
}

export class AdaceenSelectionWidget implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private thread: vscode.CommentThread | null = null;
  /**
   * El comentario que se muestra. 0.0.39: al repintar en el mismo sitio se cambia este mismo objeto
   * (VS Code identifica el comentario por el objeto): el comentario se actualiza en su lugar en vez
   * de quitarse y crearse otro. VS Code igual vuelve a pintar el cuerpo (y su scroll vuelve arriba):
   * por eso la explicacion en vivo deja de cambiar cuando llena lo visible (selection-widget-text.ts).
   */
  private comment: vscode.Comment | null = null;
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

  /** 0.0.39: la ventana esta abierta sobre estas lineas (base 1) de este documento. */
  showsAnchor(uriString: string, startLine: number, endLine: number): boolean {
    const range = this.thread?.range;
    return !!this.thread
      && !!range
      && this.thread.uri.toString() === uriString
      && range.start.line === Math.max(0, startLine - 1)
      && range.end.line === Math.max(0, endLine - 1);
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

    // La clave es lo que se pinta (texto, etiquetas y botones del titulo): un campo nuevo del
    // modelo que cambie la ventana la repinta sin tener que acordarse de agregarlo aqui.
    const contextValue = selectionWidgetShowsTitleActions(model) ? THREAD_CONTEXT : THREAD_CONTEXT_READONLY;
    const key = [
      model.uriString,
      model.startLine,
      model.endLine,
      contextValue,
      threadLabel(model),
      commentLabel(model),
      buildSelectionWidgetText(model),
    ].join('\u0000');
    if (key === this.currentKey && this.thread) {
      return;
    }

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
    const sameAnchor = this.thread
      && this.thread.uri.toString() === model.uriString
      && this.thread.range?.start.line === range.start.line
      && this.thread.range?.end.line === range.end.line;

    if (sameAnchor && this.thread && this.comment) {
      // Mismo sitio, contenido nuevo: se actualiza en el sitio para no cerrar y abrir (0.0.39: el
      // mismo comentario con el cuerpo nuevo).
      this.comment.body = buildSelectionWidgetMarkdown(model);
      this.comment.contextValue = contextValue;
      this.comment.label = commentLabel(model);
      this.thread.comments = [this.comment];
      this.thread.label = threadLabel(model);
      this.thread.contextValue = contextValue;
    } else {
      const comment: vscode.Comment = {
        author: { name: 'ADACEEN' },
        body: buildSelectionWidgetMarkdown(model),
        mode: vscode.CommentMode.Preview,
        contextValue,
        label: commentLabel(model),
      };
      const previousUri = this.uriString;
      this.disposeThread();
      const thread = this.controller.createCommentThread(uri, range, [comment]);
      thread.canReply = false;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.label = threadLabel(model);
      thread.contextValue = contextValue;
      this.thread = thread;
      this.comment = comment;
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
    this.comment = null;
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
