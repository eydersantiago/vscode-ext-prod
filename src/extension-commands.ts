// ADACEEN (VS Code): comandos de la paleta: quiz, sugerencias, historial, fuentes RAG, sesion, reemplazos y escaneo.
// Movido desde activate() (src/extension.ts): mismo texto; el estado compartido esta en *-state.ts.
import * as vscode from 'vscode';
import { processNextCodeActionForRepo } from './code-actions';
import { codeApplicationGuardDeps, connection, latestSuggestionHistory, output, quizView, setLatestSuggestionHistory } from './extension-state';
import { detectRepoFullName } from './git-repo';
import { resolveBackendSettings, resolveCurrentBackendBaseUrl } from './settings';
import { applySuggestionCompletion } from './suggestion-apply';
import { resolveWorkspaceFileUri } from './suggestion-edit';
import { buildRagSourceMarkdown, buildRagSourceTargetUrl } from './suggestion-format';
import { formatSuggestionHistoryMarkdown, readSuggestionHistory, writeSuggestionHistory } from './suggestion-history';
import { toQuizHistoryItems } from './suggestion-metrics';
import { recordSuggestionMetric } from './suggestion-publish';
import { refreshActiveSuggestion } from './suggestion-refresh';
import { normalizeRagSources } from './suggestion-results';
import { scheduleCursorIdleSuggestionRefresh } from './suggestion-schedule';
import { activeSuggestionModel } from './suggestion-state';
import type { ScanCommandArgs, SuggestionApplyMode } from './types';
import { performWorkspaceScan, renderScanOutput } from './workspace-scan';

export function registerExtensionCommands(context: vscode.ExtensionContext) {
  const openAssistantDisposable = vscode.commands.registerCommand('adaceen.openAssistant', async () => {
    const model = activeSuggestionModel || await refreshActiveSuggestion('open-panel');
    void quizView.reveal(false);
    if (!model) {
      return;
    }
    recordSuggestionMetric(model, 'vscode_suggestion_panel_opened', model.applyMode);
  });

  const refreshSuggestionsDisposable = vscode.commands.registerCommand('adaceen.refreshSuggestions', async () => {
    // «Otra sugerencia» actualiza la ventana flotante en su sitio (antes abria tambien el quiz).
    const model = await refreshActiveSuggestion('manual-refresh');
    if (model) {
      recordSuggestionMetric(model, 'vscode_suggestion_manual_refresh', model.applyMode);
    }
  });

  const openSuggestionHistoryDisposable = vscode.commands.registerCommand('adaceen.openSuggestionHistory', async () => {
    setLatestSuggestionHistory(readSuggestionHistory(context.workspaceState));
    quizView.updateHistory(toQuizHistoryItems(latestSuggestionHistory));
    if (latestSuggestionHistory.length === 0) {
      vscode.window.showInformationMessage('ADACEEN: aun no hay recomendaciones guardadas en el historial.');
      return;
    }

    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: formatSuggestionHistoryMarkdown(latestSuggestionHistory),
    });
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  });

  const clearSuggestionHistoryDisposable = vscode.commands.registerCommand('adaceen.clearSuggestionHistory', async () => {
    const answer = await vscode.window.showWarningMessage(
      'ADACEEN: se borrara el historial de recomendaciones guardado para este workspace.',
      'Limpiar historial',
    );
    if (answer !== 'Limpiar historial') {
      return;
    }

    setLatestSuggestionHistory([]);
    await writeSuggestionHistory(context.workspaceState, latestSuggestionHistory);
    quizView.updateHistory(toQuizHistoryItems(latestSuggestionHistory));
    vscode.window.showInformationMessage('ADACEEN: historial de recomendaciones limpiado.');
  });

  const openSuggestionHistoryEntryDisposable = vscode.commands.registerCommand(
    'adaceen.openSuggestionHistoryEntry',
    async (entryId?: string) => {
      setLatestSuggestionHistory(readSuggestionHistory(context.workspaceState));
      const entry = latestSuggestionHistory.find((item) => item.id === entryId);
      if (!entry) {
        vscode.window.showInformationMessage('ADACEEN: esa recomendacion ya no esta en el historial.');
        return;
      }

      const uri = await resolveWorkspaceFileUri(entry.filePath);
      if (!uri) {
        vscode.window.showWarningMessage(`ADACEEN: no se encontro ${entry.filePath} en el workspace abierto.`);
        return;
      }

      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
      const startLineNumber = entry.selectionStartLine || entry.line || 1;
      const endLineNumber = entry.selectionEndLine || startLineNumber;
      const startLine = Math.max(0, Math.min(document.lineCount - 1, startLineNumber - 1));
      const endLine = Math.max(startLine, Math.min(document.lineCount - 1, endLineNumber - 1));
      const range = new vscode.Range(new vscode.Position(startLine, 0), document.lineAt(endLine).range.end);
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    },
  );

  const applySuggestionCompletionDisposable = vscode.commands.registerCommand(
    'adaceen.applySuggestionCompletion',
    async (mode?: string, origin?: unknown) => {
      const normalizedMode: SuggestionApplyMode | undefined =
        mode === 'insert' || mode === 'replace' || mode === 'delete' ? mode : undefined;
      // origin lo ponen la ventana flotante, el CodeLens, el quick fix...: va a las metricas y
      // decide si el clic cuenta como confirmacion (isExplicitClickOrigin). Sin origin, la paleta.
      const normalizedOrigin = typeof origin === 'string' && /^[a-z_]{1,40}$/.test(origin) ? origin : 'command';
      await applySuggestionCompletion(normalizedMode, normalizedOrigin);
    },
  );

  const openRagSourceDisposable = vscode.commands.registerCommand('adaceen.openRagSource', async (sourceArg?: unknown) => {
    const sourceItem = normalizeRagSources([sourceArg])[0];
    if (!sourceItem) {
      vscode.window.showInformationMessage('ADACEEN: esta sugerencia no trae una fuente RAG abrible.');
      return;
    }

    const targetUrl = buildRagSourceTargetUrl(sourceItem, resolveCurrentBackendBaseUrl().baseUrl);
    if (targetUrl) {
      await vscode.env.openExternal(vscode.Uri.parse(targetUrl));
      recordSuggestionMetric(activeSuggestionModel, 'vscode_rag_source_opened', sourceItem.citationLabel || sourceItem.title, {
        sourceId: sourceItem.sourceId,
        chunkId: sourceItem.chunkId,
        title: sourceItem.title,
        citationLabel: sourceItem.citationLabel,
        pageStart: sourceItem.pageStart,
        pageEnd: sourceItem.pageEnd,
        courseCode: sourceItem.courseCode,
        url: targetUrl,
      });
      return;
    }

    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: buildRagSourceMarkdown(sourceItem, resolveCurrentBackendBaseUrl().baseUrl),
    });
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    recordSuggestionMetric(activeSuggestionModel, 'vscode_rag_source_opened', sourceItem.citationLabel || sourceItem.title, {
      sourceId: sourceItem.sourceId,
      chunkId: sourceItem.chunkId,
      title: sourceItem.title,
      citationLabel: sourceItem.citationLabel,
      pageStart: sourceItem.pageStart,
      pageEnd: sourceItem.pageEnd,
      courseCode: sourceItem.courseCode,
      openedAsMarkdown: true,
    });
  });

  // Compatibilidad: lo mismo que «ADACEEN: Conectar» → «Tengo un codigo o sesion»; acepta un
  // codigo XXXX-XXXX (lo canjea) o el UUID de antes. Sigue en la paleta: el navegador lo cita.
  // La sesion va a SecretStorage (no a settings), por encima del ajuste heredado.
  const setBackendSessionIdDisposable = vscode.commands.registerCommand('adaceen.setBackendSessionId', () =>
    connection.promptLegacySession(),
  );
  // Con otra sesion cambian la cache de sugerencias y lo que se sincroniza con el navegador.
  connection.onDidChangeSession((_session, idChanged) => {
    if (idChanged) {
      scheduleCursorIdleSuggestionRefresh();
    }
  });

  const applyNextCodeActionDisposable = vscode.commands.registerCommand('adaceen.applyNextCodeAction', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) {
      vscode.window.showWarningMessage('ADACEEN: abre una carpeta o workspace antes de aplicar reemplazos.');
      return;
    }

    const repoFullName = await detectRepoFullName(workspaceFolders);
    if (!repoFullName) {
      vscode.window.showWarningMessage('ADACEEN: no pude detectar el repositorio GitHub owner/repo del workspace.');
      return;
    }

    await processNextCodeActionForRepo(resolveBackendSettings(), repoFullName, output, codeApplicationGuardDeps, true);
  });

  const scanWorkspaceDisposable = vscode.commands.registerCommand(
    'adaceen.scanWorkspace',
    async (args?: ScanCommandArgs) => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) {
        vscode.window.showWarningMessage('ADACEEN: abre una carpeta o workspace antes de escanear.');
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'ADACEEN está leyendo el workspace...',
          cancellable: false,
        },
        async () => {
          const scan = await performWorkspaceScan(args, output);
          renderScanOutput(output, scan);
          output.show(true);
          vscode.window.showInformationMessage(
            `ADACEEN leyó ${scan.payload.totalFiles} archivos (${scan.selection.mode}). Revisa Output.`,
          );
        },
      );
    },
  );
  return {
    openAssistantDisposable,
    refreshSuggestionsDisposable,
    openSuggestionHistoryDisposable,
    clearSuggestionHistoryDisposable,
    openSuggestionHistoryEntryDisposable,
    applySuggestionCompletionDisposable,
    openRagSourceDisposable,
    setBackendSessionIdDisposable,
    applyNextCodeActionDisposable,
    scanWorkspaceDisposable,
  };
}
