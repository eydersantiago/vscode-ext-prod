// ADACEEN (VS Code): barra de estado de la sugerencia, hover y decoraciones en el editor.
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import * as vscode from 'vscode';
import { isSuggestionApplyOffered, primarySuggestionText, suggestionApplicationNote } from './active-suggestion';
import { ACTIVE_SUGGESTION_SELECTION_MAX_LINES } from './constants';
import { buildSelectionRangeKey } from './editor-snapshot';
import { sanitizeTutorMarkdown } from './selection-widget';
import { suggestionApplyModeLabel } from './suggestion-edit';
import { buildCommandUri } from './suggestion-format';
import { truncateInline } from './suggestion-results';
import type { ActiveSuggestionModel } from './types';

export function updateSuggestionStatusBar(statusBar: vscode.StatusBarItem, model: ActiveSuggestionModel | null, enabled: boolean) {
  if (!enabled) {
    statusBar.hide();
    return;
  }

  if (!model) {
    statusBar.text = '$(lightbulb) ADACEEN';
    statusBar.tooltip = 'Abrir panel ADACEEN. Abre un archivo para recibir sugerencias.';
    statusBar.show();
    return;
  }

  if (model.loading) {
    statusBar.text = `$(sync~spin) ADACEEN: cargando`;
    statusBar.tooltip = [
      `Cargando sugerencias para ${model.fileName}...`,
      model.fileOverview ? `Descripcion: ${model.fileOverview}` : '',
    ].filter(Boolean).join('\n');
    statusBar.show();
    return;
  }

  statusBar.text = `$(lightbulb) ADACEEN: ${truncateInline(model.fileName, 22)}`;
  statusBar.tooltip = [
    model.fileOverview ? `Descripcion: ${model.fileOverview}` : '',
    model.summary,
    model.selectionTruncated
      ? `Seleccion limitada: primeras ${ACTIVE_SUGGESTION_SELECTION_MAX_LINES} lineas de ${model.selectionOriginalLineCount}.`
      : '',
	    '',
	    'Clic: abrir panel ADACEEN.',
	    ...(model.suggestions || []).map((item) => `- ${item}`),
    model.backendError ? `Backend: ${model.backendError}` : '',
  ].filter(Boolean).join('\n');
  statusBar.show();
}

export function escapeMarkdown(value: string) {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');
}

export function buildInlineSuggestionLabel(model: ActiveSuggestionModel) {
  if (model.loading) {
    return "ADACEEN: cargando pista";
  }
  if (model.applied) {
    return `ADACEEN aplicado: ${truncateInline(model.lineSummary || primarySuggestionText(model), 82)}`;
  }
  if (model.blocked) {
    return `ADACEEN tutor: ${truncateInline(primarySuggestionText(model), 82)}`;
  }
  const action = suggestionApplyModeLabel(model.applyMode).toLowerCase();
  const focus = primarySuggestionText(model);
  const scope = model.selectionLineCount ? 'seleccion' : action;
  return `ADACEEN ${scope}: ${truncateInline(focus, 82)}`;
}

export function buildSuggestionHoverMarkdown(model: ActiveSuggestionModel) {
  const markdown = new vscode.MarkdownString('', true);
  markdown.isTrusted = {
    enabledCommands: [
      'adaceen.openAssistant',
      'adaceen.applySuggestionCompletion',
      'adaceen.openRagSource',
    ],
  };

  const focusLabel = model.selectionLineCount
    ? `seleccion (${model.selectionLineCount}${model.selectionTruncated ? `/${model.selectionOriginalLineCount || model.selectionLineCount}` : ''} lineas)`
    : `linea ${model.line}`;
  markdown.appendMarkdown(`**ADACEEN en ${escapeMarkdown(focusLabel)}**\n\n`);
  if (model.selectionTruncated) {
    markdown.appendMarkdown(
      `> Seleccion limitada: se analizaron las primeras ${ACTIVE_SUGGESTION_SELECTION_MAX_LINES} lineas de ${model.selectionOriginalLineCount || 'la seleccion'}.\n\n`,
    );
  }
  const openPanelUri = buildCommandUri('adaceen.openAssistant');
  if (model.blocked) {
    // Mensaje controlado del tutor: se muestra tal cual (Markdown) y sin enlace de aplicar.
    markdown.appendMarkdown(`${sanitizeTutorMarkdown(model.tutorMessage || primarySuggestionText(model))}\n\n`);
    markdown.appendMarkdown(`[Ver panel](${openPanelUri})`);
  } else {
    markdown.appendMarkdown(`${escapeMarkdown(primarySuggestionText(model))}\n\n`);
    markdown.appendMarkdown(`**Accion:** ${escapeMarkdown(suggestionApplyModeLabel(model.applyMode))}\n\n`);

    const applyUri = buildCommandUri('adaceen.applySuggestionCompletion', [model.applyMode, 'hover']);
    const applicationNote = suggestionApplicationNote(model);
    markdown.appendMarkdown(`[Ver panel](${openPanelUri})`);
    if (!model.loading && !model.applied && model.source !== 'local-fallback' && isSuggestionApplyOffered(model)) {
      markdown.appendMarkdown(` · [Aceptar ayuda: ${escapeMarkdown(suggestionApplyModeLabel(model.applyMode))}](${applyUri})`);
    } else if (model.applied) {
      markdown.appendMarkdown(`\n\n_Ayuda aplicada. Mantengo el contexto para que puedas validar el cambio._`);
    }
    if (applicationNote && !model.applied && !model.loading) {
      markdown.appendMarkdown(`\n\n_${escapeMarkdown(applicationNote)}_`);
    }
  }

  const ragSource = model.ragSources[0];
  if (ragSource) {
    const ragUri = buildCommandUri('adaceen.openRagSource', [ragSource]);
    const pageText = ragSource.pageStart
      ? ` p. ${ragSource.pageEnd && ragSource.pageEnd !== ragSource.pageStart ? `${ragSource.pageStart}-${ragSource.pageEnd}` : ragSource.pageStart}`
      : '';
    const ragLabel = ragSource.knowledgeTier === 'supplemental' || ragSource.contextDomain === 'bitacora'
      ? 'Contexto suplementario'
      : 'Fuente RAG';
    markdown.appendMarkdown(`\n\n**${ragLabel}:** ${escapeMarkdown(ragSource.title)}${escapeMarkdown(pageText)} ${escapeMarkdown(ragSource.citationLabel || '')}`);
    markdown.appendMarkdown(`\n\n[Abrir fuente o detalle](${ragUri})`);
  }

  if (model.fileOverview) {
    markdown.appendMarkdown(`\n\n---\n${escapeMarkdown(truncateInline(model.fileOverview, 260))}`);
  }

  return markdown;
}

export function clearSuggestionDecorations(decorationType: vscode.TextEditorDecorationType) {
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(decorationType, []);
  }
}

export function applySuggestionDecoration(
  decorationType: vscode.TextEditorDecorationType,
  model: ActiveSuggestionModel | null,
) {
  clearSuggestionDecorations(decorationType);
  if (!model) {
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== model.uriString) {
    return;
  }

  const lineIndex = Math.max(0, Math.min(editor.document.lineCount - 1, (Number(model.line) || 1) - 1));
  const line = editor.document.lineAt(lineIndex);
  const range = model.selectionLineCount > 0 && buildSelectionRangeKey(editor) === model.selectionRangeKey
    ? editor.selection
    : new vscode.Range(line.range.end, line.range.end);
  const showPassiveLabel = model.loading || model.applied || model.source === 'local-fallback' || !!model.blocked;
  const decoration: vscode.DecorationOptions = {
    range,
    hoverMessage: buildSuggestionHoverMarkdown(model),
  };

  if (showPassiveLabel) {
    decoration.renderOptions = {
      after: {
        contentText: `  ${buildInlineSuggestionLabel(model)}`,
        color: model.loading
          ? new vscode.ThemeColor('editorCodeLens.foreground')
          : new vscode.ThemeColor('editorInfo.foreground'),
        fontStyle: 'italic',
        margin: '0 0 0 1rem',
      },
    };
  }

  editor.setDecorations(decorationType, [decoration]);
}
