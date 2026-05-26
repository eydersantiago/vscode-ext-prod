import * as vscode from 'vscode';
import type { GithubMentorResult, StallSignal } from './coachTypes';

export type CoachPanelAction =
  | { command: 'pickIdea'; value: string }
  | { command: 'openQuickPick' }
  | { command: 'saveMemory' }
  | { command: 'askManual' };

type CoachPanelActionListener = (action: CoachPanelAction) => void | Promise<void>;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return map[char] || char;
  });
}

function nonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 24; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

export class CoachViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'pdcCoach.recommendations';

  private view?: vscode.WebviewView;
  private latest?: GithubMentorResult;
  private latestSignal?: StallSignal;
  private readonly actionListeners: CoachPanelActionListener[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  onAction(listener: CoachPanelActionListener): void {
    this.actionListeners.push(listener);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.onDidReceiveMessage((message: CoachPanelAction) => {
      void this.emitAction(message);
    });
    view.webview.html = this.render(view.webview);
  }

  update(result: GithubMentorResult, signal?: StallSignal): void {
    this.latest = result;
    this.latestSignal = signal;
    if (this.view) {
      this.view.webview.html = this.render(this.view.webview);
    }
  }

  reveal(): void {
    void vscode.commands.executeCommand(`${CoachViewProvider.viewType}.focus`);
  }

  private async emitAction(action: CoachPanelAction): Promise<void> {
    for (const listener of this.actionListeners) {
      await listener(action);
    }
  }

  private render(webview: vscode.Webview): string {
    const result = this.latest;
    const signal = this.latestSignal;
    const ideas = result?.ideas?.length
      ? result.ideas
      : ['Abre un archivo, selecciona codigo o ejecuta una tarea para recibir recomendaciones.'];
    const guide = result?.guide || [];
    const searches = result?.searches || [];
    const scriptNonce = nonce();

    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${scriptNonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      padding: 14px;
    }
    .hero, .card {
      border: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      border-radius: 8px;
      padding: 10px;
      margin-bottom: 10px;
    }
    .badge {
      display: inline-block;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 11px;
      margin-bottom: 8px;
    }
    h2 { font-size: 15px; margin: 0 0 8px; }
    h3 { font-size: 12px; margin: 14px 0 8px; text-transform: uppercase; opacity: .78; }
    p, li { font-size: 12px; line-height: 1.45; }
    ol, ul { padding-left: 18px; }
    button {
      width: 100%;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border-radius: 4px;
      padding: 7px 8px;
      margin-top: 6px;
      text-align: left;
      cursor: pointer;
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .small { opacity: .76; }
  </style>
</head>
<body>
  <section class="hero">
    <span class="badge">ADACEEN Coach</span>
    <h2>${escapeHtml(result?.welcome_message || 'Recomendaciones listas para Codespaces')}</h2>
    <p class="small">${escapeHtml(result?.analysis_summary || 'El panel se actualiza con inactividad, diagnostics repetidos, tareas fallidas o solicitud manual.')}</p>
    ${signal ? `<p class="small"><strong>Senal:</strong> ${escapeHtml(signal.reason)}</p>` : ''}
    <button class="primary" data-command="askManual">Pedir recomendacion ahora</button>
    <button data-command="saveMemory">Guardar memoria del proyecto</button>
  </section>

  <h3>Opciones accionables</h3>
  ${ideas.map((idea) => `
    <section class="card">
      <p>${escapeHtml(idea)}</p>
      <button data-command="pickIdea" data-value="${escapeHtml(idea)}">Profundizar esta opcion</button>
    </section>
  `).join('')}

  ${guide.length ? `<h3>Guia</h3><ol>${guide.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>` : ''}
  ${searches.length ? `<h3>Busquedas utiles</h3><ul>${searches.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
  <button data-command="openQuickPick">Elegir con QuickPick</button>

  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-command]');
      if (!button) return;
      vscode.postMessage({
        command: button.dataset.command,
        value: button.dataset.value || ''
      });
    });
  </script>
</body>
</html>`;
  }
}
