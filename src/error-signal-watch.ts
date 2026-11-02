// ADACEEN (VS Code): señales de error y de bloqueo del archivo activo (A6.2): telemetria y sugerencia con trigger "blocking".
// Movido desde activate() (src/extension.ts): mismo texto; el estado compartido esta en *-state.ts.
import * as vscode from 'vscode';
import { collectDocumentDiagnostics, isSupportedActiveDocument } from './editor-snapshot';
import { ERROR_TEXT_MAX_CHARS, ErrorSignalTracker } from './error-signals';
import type { BlockingSignal, ErrorSignal } from './error-signals';
import { output, telemetry } from './extension-state';
import { detectBranchName } from './git-repo';
import { errorSignalSettingsFromConfig, resolveActiveSuggestionSettings, resolveTriggerSettings } from './settings';
import { editorPageContext } from './suggestion-metrics';
import { refreshActiveSuggestion } from './suggestion-refresh';
import { inferActiveLanguage, truncateInline } from './suggestion-results';
import { isAutoRefreshSuppressed } from './suggestion-schedule';
import { cursorIdleSuggestionTimer, lastKnownRepoFullName, pendingBlocking, setCursorIdleSuggestionTimer, setPendingBlocking } from './suggestion-state';
import type { TelemetryEventInput } from './telemetry';

export function createErrorSignals() {
  // --- Senales de error y bloqueo (A6.2): activacion por eventos definidos ---
  const errorSignalTracker = new ErrorSignalTracker(errorSignalSettingsFromConfig());
  const lastEditAtByUri = new Map<string, number>();
  let errorSignalTimer: ReturnType<typeof setTimeout> | null = null;

  const clearErrorSignalTimer = () => {
    if (errorSignalTimer) {
      clearTimeout(errorSignalTimer);
      errorSignalTimer = null;
    }
  };

  const rememberEdit = (uriString: string) => {
    lastEditAtByUri.delete(uriString);
    lastEditAtByUri.set(uriString, Date.now());
    while (lastEditAtByUri.size > 50) {
      lastEditAtByUri.delete(lastEditAtByUri.keys().next().value as string);
    }
  };

  const recordErrorSignal = (signal: ErrorSignal, document: vscode.TextDocument, errorCount: number) => {
    const filePath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
    const base: TelemetryEventInput = {
      source: 'vscode_extension',
      category: 'signal',
      eventType: signal.type,
      pageContext: editorPageContext(),
      repoFullName: lastKnownRepoFullName || undefined,
      branch: detectBranchName(),
      filePath,
      language: inferActiveLanguage(filePath, document.languageId),
      // El backend lo convierte en errorHash y no guarda el texto.
      errorText: signal.text.slice(0, ERROR_TEXT_MAX_CHARS),
    };
    if (signal.type === 'compile_error_detected') {
      telemetry.track({ ...base, metadata: { line: signal.line, errorCount } });
      return;
    }
    if (signal.type === 'blocking_resolved') {
      // Cierra el episodio de bloqueo: su duracion es el tiempo hasta desbloqueo (A3.3).
      telemetry.track({
        ...base,
        durationMs: signal.durationMs,
        metadata: {
          line: signal.line,
          blockedForMs: signal.blockedForMs,
          resolvedWhileAway: signal.resolvedWhileAway,
          errorCount,
        },
      });
      return;
    }
    telemetry.track({
      ...base,
      durationMs: signal.durationMs,
      count: signal.count,
      metadata: {
        line: signal.line,
        reason: signal.reason,
        blockingSeconds: resolveTriggerSettings().blockingSeconds,
        errorCount,
      },
    });
  };

  /** Pide una sugerencia con trigger "blocking" (si adaceen.triggers.suggestOnBlocking lo permite). */
  const requestBlockingSuggestion = (signal: BlockingSignal, document: vscode.TextDocument) => {
    if (!resolveTriggerSettings().suggestOnBlocking || !resolveActiveSuggestionSettings().enabled) {
      return;
    }
    // Las peticiones siguientes de este archivo salen con trigger "blocking" hasta que una responda.
    setPendingBlocking({ uriString: document.uri.toString(), key: signal.key, text: signal.text, detectedAt: Date.now() });
    if (isAutoRefreshSuppressed()) {
      return;
    }
    if (cursorIdleSuggestionTimer) {
      clearTimeout(cursorIdleSuggestionTimer);
      setCursorIdleSuggestionTimer(null);
    }
    void refreshActiveSuggestion('blocking');
  };

  /** Relee los errores del archivo activo y emite compile_error_detected / blocking_detected. */
  const evaluateErrorSignals = () => {
    clearErrorSignalTimer();
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSupportedActiveDocument(editor.document)) {
      return;
    }
    const document = editor.document;
    const uriString = document.uri.toString();
    const summary = collectDocumentDiagnostics(document.uri);
    const now = Date.now();
    const lastEditAt = lastEditAtByUri.get(uriString) ?? Number.NEGATIVE_INFINITY;
    const signals = errorSignalTracker.observe(uriString, summary.errors, now, lastEditAt);
    if (pendingBlocking?.uriString === uriString && !errorSignalTracker.isPresent(pendingBlocking.key)) {
      // El error que causo el bloqueo ya se corrigio.
      setPendingBlocking(null);
    }
    let firstBlocking: BlockingSignal | null = null;
    for (const signal of signals) {
      recordErrorSignal(signal, document, summary.errors.length);
      if (signal.type === 'blocking_resolved') {
        output.appendLine(
          `[Signals] Desbloqueo en ${vscode.workspace.asRelativePath(document.uri, false)}:${signal.line} tras ${Math.round(signal.durationMs / 1000)} s${signal.resolvedWhileAway ? ' (corregido desde otro archivo)' : ''}.`,
        );
        continue;
      }
      if (signal.type === 'blocking_detected') {
        output.appendLine(
          `[Signals] Bloqueo en ${vscode.workspace.asRelativePath(document.uri, false)}:${signal.line} (${signal.reason === 'persistent' ? `${Math.round(signal.durationMs / 1000)} s con el mismo error` : `${signal.count} apariciones en 10 min`}): ${truncateInline(signal.text, 140)}`,
        );
        firstBlocking = firstBlocking || signal;
      }
    }
    if (firstBlocking) {
      // Una sola peticion aunque en la misma lectura se bloqueen varios errores.
      requestBlockingSuggestion(firstBlocking, document);
    }
    // Los diagnosticos pueden no cambiar mas: se vuelve a mirar cuando venza el siguiente plazo.
    const deadline = errorSignalTracker.nextDeadline(now, lastEditAt);
    if (deadline !== null) {
      errorSignalTimer = setTimeout(evaluateErrorSignals, Math.min(10 * 60_000, Math.max(250, deadline - now + 50)));
    }
  };
  return { errorSignalTracker, clearErrorSignalTimer, rememberEdit, evaluateErrorSignals };
}
