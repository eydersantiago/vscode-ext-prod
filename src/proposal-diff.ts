import * as vscode from 'vscode';

/**
 * «Ver cambios» de la ventana flotante (0.0.34): abre la comparacion de VS Code
 * entre el archivo tal como esta y el archivo con la propuesta del tutor ya
 * aplicada, antes de aplicar nada. Sirve sobre todo para «Modificar
 * seleccion»: un bloque mejorado se parece mucho al original y la comparacion
 * marca justo lo que cambia.
 *
 * El lado derecho es un documento de solo lectura en memoria
 * (adaceen-propuesta:/...), que se olvida al cerrarse.
 */

export const PROPOSAL_SCHEME = 'adaceen-propuesta';
const MAX_PROPOSALS = 8;

export class ProposalContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private counter = 0;
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;

  /** Guarda el texto propuesto y devuelve el URI que lo muestra (con el nombre del archivo). */
  remember(fileName: string, text: string) {
    this.counter += 1;
    const safeName = (fileName || 'propuesta').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'propuesta';
    const uri = vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${safeName}`, query: `n=${this.counter}` });
    this.contents.set(uri.toString(), text);
    while (this.contents.size > MAX_PROPOSALS) {
      const oldest = this.contents.keys().next().value as string;
      this.contents.delete(oldest);
    }
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri) {
    return this.contents.get(uri.toString()) ?? '// La propuesta ya no esta disponible: pide la sugerencia otra vez.';
  }

  dispose() {
    this.contents.clear();
    this.changeEmitter.dispose();
  }
}

/** El texto completo del documento con `text` en lugar de `range` (al insertar, rango vacio). */
export function applyEditToText(document: vscode.TextDocument, range: vscode.Range, text: string) {
  const full = document.getText();
  const start = document.offsetAt(range.start);
  const end = document.offsetAt(range.end);
  return `${full.slice(0, start)}${text}${full.slice(end)}`;
}
