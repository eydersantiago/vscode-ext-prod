// ADACEEN (VS Code): temporizador del recordatorio de como pedir ayuda (0.0.40); el texto y la regla estan en selection-hint.ts.
// Movido desde activate() (src/extension.ts): mismo texto; el estado compartido esta en *-state.ts.
import * as vscode from 'vscode';
import { SELECTION_HINT_ACTION, SELECTION_HINT_DEFAULT_MINUTES, SELECTION_HINT_TEXT, selectionHintDue, selectionHintIntervalMs } from './selection-hint';
import { resolveActiveSuggestionSettings } from './settings';
import { selectionHint } from './suggestion-state';

export function registerSelectionHint(context: vscode.ExtensionContext) {
  // 0.0.40: el tutor ya no responde solo al mover el cursor. Al entrar y cada 30 min (ajuste
  // adaceen.suggestions.selectionHintMinutes; 0 lo apaga) se recuerda como pedir ayuda, salvo que
  // en ese rato el estudiante ya la haya pedido. Con la ventana sin foco espera a que vuelva.
  const maybeShowSelectionHint = () => {
    const settings = resolveActiveSuggestionSettings();
    if (!settings.enabled || !vscode.window.state.focused) {
      return;
    }
    const intervalMs = selectionHintIntervalMs(
      vscode.workspace.getConfiguration('adaceen').get<number>('suggestions.selectionHintMinutes', SELECTION_HINT_DEFAULT_MINUTES),
    );
    const now = Date.now();
    if (!selectionHintDue(selectionHint, now, intervalMs)) {
      return;
    }
    selectionHint.lastShownAt = now;
    void vscode.window.showInformationMessage(SELECTION_HINT_TEXT, SELECTION_HINT_ACTION);
  };
  // Unos segundos despues de entrar, para no perderse entre los avisos del arranque.
  const selectionHintFirstTimer = setTimeout(maybeShowSelectionHint, 5000);
  const selectionHintTimer = setInterval(maybeShowSelectionHint, 60_000);
  context.subscriptions.push(
    { dispose: () => { clearTimeout(selectionHintFirstTimer); clearInterval(selectionHintTimer); } },
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        maybeShowSelectionHint();
      }
    }),
  );
}
