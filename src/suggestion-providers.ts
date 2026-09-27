// ADACEEN (VS Code): proveedores de VS Code para la sugerencia (CodeLens, acciones de codigo e inlay hints).
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import * as vscode from 'vscode';
import { isSuggestionApplyOffered, suggestionApplicationNote } from './active-suggestion';
import { quickFixOrigin } from './code-application-guard';
import { buildSelectionRangeKey } from './editor-snapshot';
import { buildSuggestionHoverMarkdown } from './suggestion-decorations';
import { getSelectedFullLineRange, suggestionApplyModeLabel } from './suggestion-edit';
import { truncateInline } from './suggestion-results';
import { codeLensOffersApply } from './suggestion-surfaces';
import type { SelectionWidgetPresence } from './suggestion-surfaces';
import type { ActiveSuggestionModel, SuggestionApplyMode } from './types';

export class AdaceenSuggestionCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private model: ActiveSuggestionModel | null = null;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  /**
   * widget: donde esta abierta la ventana flotante (ahi ella ofrece «Aceptar ayuda»).
   * dismissedMetricId: sugerencia que el estudiante descarto con la X de la ventana.
   */
  constructor(
    private readonly widget: () => SelectionWidgetPresence,
    private readonly dismissedMetricId: () => string = () => '',
  ) {}

  update(model: ActiveSuggestionModel | null) {
    this.model = model;
    this.changeEmitter.fire();
  }

  /** Se abrio o cerro la ventana flotante: se recalculan los CodeLens. */
  refresh() {
    this.changeEmitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.model || document.uri.toString() !== this.model.uriString) {
      return [];
    }

    const headline = this.model.loading
      ? 'Cargando sugerencias...'
      : this.model.suggestions[0] || this.model.fileOverview || this.model.title;
    const lineIndex = Math.max(0, (Number(this.model.line) || 1) - 2);
    const range = new vscode.Range(lineIndex, 0, lineIndex, 0);
    const lenses = [
      new vscode.CodeLens(
        range,
        {
          title: `ADACEEN: ${truncateInline(headline, 96)}`,
          command: 'adaceen.openAssistant',
        },
      ),
    ];
    const applyOffered = !!this.model.actionsVisible &&
      !this.model.loading &&
      !this.model.applied &&
      this.model.source !== 'local-fallback' &&
      isSuggestionApplyOffered(this.model);
    // Con la ventana flotante abierta en este archivo, ella ofrece la accion: sin repetirla aqui.
    // Tampoco si el estudiante cerro la ventana de esta sugerencia con la X.
    if (codeLensOffersApply({
      applyOffered,
      documentUri: document.uri.toString(),
      widget: this.widget(),
      metricId: this.model.metricId,
      dismissedMetricId: this.dismissedMetricId(),
    })) {
      const recommendedMode = this.model.applyMode || 'insert';
      const note = suggestionApplicationNote(this.model);
      lenses.push(new vscode.CodeLens(range, {
        title: `$(check) Aceptar ayuda: ${suggestionApplyModeLabel(recommendedMode)}`,
        command: 'adaceen.applySuggestionCompletion',
        arguments: [recommendedMode, 'codelens'],
        ...(note ? { tooltip: note } : {}),
      }));
    }
    return lenses;
  }

  dispose() {
    this.changeEmitter.dispose();
  }
}

export function isSuggestionCodeActionRequestFocused(
  model: ActiveSuggestionModel,
  document: vscode.TextDocument,
  range?: vscode.Range,
) {
  if (document.uri.toString() !== model.uriString) {
    return false;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== model.uriString) {
    return false;
  }

  if (model.selectionLineCount > 0) {
    return buildSelectionRangeKey(editor) === model.selectionRangeKey;
  }

  const modelLineIndex = Math.max(0, (Number(model.line) || 1) - 1);
  if (!range) {
    return editor.selection.active.line === modelLineIndex;
  }

  return range.start.line <= modelLineIndex && range.end.line >= modelLineIndex;
}

export function suggestionCodeActionTitle(mode: SuggestionApplyMode, focusLabel: string, preferred: boolean) {
  const suffix = preferred ? ' (recomendado)' : '';
  if (mode === 'delete') {
    return `ADACEEN: Aceptar ayuda - eliminar ${focusLabel}${suffix}`;
  }
  if (mode === 'replace') {
    return `ADACEEN: Aceptar ayuda - modificar ${focusLabel}${suffix}`;
  }
  return `ADACEEN: Aceptar ayuda - agregar debajo${suffix}`;
}

export function buildSuggestionCodeActions(model: ActiveSuggestionModel, origin: 'quick_fix' | 'quick_fix_auto') {
  const recommendedMode = model.applyMode || 'insert';
  const focusLabel = model.selectionLineCount ? 'seleccion' : 'linea';
  const action = new vscode.CodeAction(
    suggestionCodeActionTitle(recommendedMode, focusLabel, true),
    vscode.CodeActionKind.QuickFix,
  );
  action.command = {
    title: action.title,
    command: 'adaceen.applySuggestionCompletion',
    arguments: [recommendedMode, origin],
  };
  action.isPreferred = true;
  return [action];
}

export class AdaceenSuggestionCodeActionProvider implements vscode.CodeActionProvider, vscode.Disposable {
  private model: ActiveSuggestionModel | null = null;

  /**
   * autoOpenedAt: cuando ADACEEN abrio solo el menu de arreglos rapidos. Esa
   * accion (preseleccionada, un Enter la aplica) no cuenta como clic del
   * estudiante: con requireConfirmation pregunta (quickFixOrigin).
   */
  constructor(private readonly autoOpenedAt: () => number = () => 0) {}

  update(model: ActiveSuggestionModel | null) {
    this.model = model;
  }

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (
      !this.model ||
      this.model.loading ||
      this.model.applied ||
      this.model.source === 'local-fallback' ||
      !this.model.actionsVisible ||
      !isSuggestionApplyOffered(this.model) ||
      !isSuggestionCodeActionRequestFocused(this.model, document, range)
    ) {
      return [];
    }

    if (context.only && !context.only.contains(vscode.CodeActionKind.QuickFix)) {
      return [];
    }

    return buildSuggestionCodeActions(this.model, quickFixOrigin(this.autoOpenedAt()));
  }

  dispose() {
    this.model = null;
  }
}

export function isSuggestionInlineHintFocused(model: ActiveSuggestionModel, document: vscode.TextDocument) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== document.uri.toString()) {
    return false;
  }

  if (model.selectionLineCount > 0) {
    return buildSelectionRangeKey(editor) === model.selectionRangeKey;
  }

  return editor.selection.active.line + 1 === model.line;
}

export function isSuggestionInlineHintVisible(model: ActiveSuggestionModel, document: vscode.TextDocument) {
  if (
    model.loading ||
    model.applied ||
    model.source === 'local-fallback' ||
    !isSuggestionApplyOffered(model) ||
    document.uri.toString() !== model.uriString
  ) {
    return false;
  }

  if (!isSuggestionInlineHintFocused(model, document)) {
    return false;
  }

  return model.actionsVisible || model.selectionLineCount > 0;
}

export function getSuggestionInlineHintPosition(model: ActiveSuggestionModel, document: vscode.TextDocument) {
  const editor = vscode.window.activeTextEditor;
  if (
    editor &&
    editor.document.uri.toString() === model.uriString &&
    model.selectionLineCount > 0 &&
    buildSelectionRangeKey(editor) === model.selectionRangeKey
  ) {
    const range = getSelectedFullLineRange(editor);
    const lineIndex = Math.max(0, Math.min(document.lineCount - 1, range.end.line));
    return document.lineAt(lineIndex).range.end;
  }

  const lineIndex = Math.max(0, Math.min(document.lineCount - 1, (Number(model.line) || 1) - 1));
  return document.lineAt(lineIndex).range.end;
}

export class AdaceenSuggestionInlayHintProvider implements vscode.InlayHintsProvider, vscode.Disposable {
  private model: ActiveSuggestionModel | null = null;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeInlayHints = this.changeEmitter.event;

  update(model: ActiveSuggestionModel | null) {
    this.model = model;
    this.changeEmitter.fire();
  }

  provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    _token: vscode.CancellationToken,
  ): vscode.InlayHint[] {
    if (!this.model || !isSuggestionInlineHintVisible(this.model, document)) {
      return [];
    }

    const position = getSuggestionInlineHintPosition(this.model, document);
    if (!range.contains(position)) {
      return [];
    }

    const applyMode = this.model.applyMode || 'insert';
    const modeLabel = suggestionApplyModeLabel(applyMode);
    const labelPart = new vscode.InlayHintLabelPart(`Aceptar ayuda: ${modeLabel}`);
    labelPart.tooltip = buildSuggestionHoverMarkdown(this.model);
    labelPart.command = {
      title: `ADACEEN: Aceptar ayuda (${modeLabel})`,
      command: 'adaceen.applySuggestionCompletion',
      arguments: [applyMode, 'inlay_hint'],
    };

    const hint = new vscode.InlayHint(position, [labelPart], vscode.InlayHintKind.Parameter);
    hint.tooltip = buildSuggestionHoverMarkdown(this.model);
    hint.paddingLeft = true;
    hint.paddingRight = true;
    return [hint];
  }

  dispose() {
    this.changeEmitter.dispose();
  }
}
