import * as vscode from 'vscode';
import { CLIENT_ID_HEADER, getOrCreateClientId } from './client-identity';

/**
 * Panel "Quiz y seguimiento".
 *
 * Es una vista (WebviewView) en su propio contenedor de la barra de
 * actividades, asi que el estudiante puede arrastrarla a la barra lateral
 * derecha o al panel inferior y VS Code recuerda donde la dejo.
 *
 * Que muestra:
 *   - Quiz: tras aceptar una sugerencia (o cuando el docente lanza uno) una
 *     pregunta de opcion multiple; si falla, una pregunta abierta corta que
 *     califica el backend. Cuando y cada cuanto lo decide la politica del
 *     docente en el backend; aqui solo se pide y se muestra.
 *   - Historial: recomendaciones anteriores, con salto al codigo.
 *
 * El HTML se pinta una sola vez; los cambios llegan por postMessage y el
 * script redibuja solo el contenido, asi que nada se cierra ni salta al
 * recibir datos nuevos.
 */

export type QuizRequestContext = {
  baseUrl: string;
  headers: Record<string, string>;
};

export type QuizHistoryItem = {
  id: string;
  fileName: string;
  meta: string;
  summary: string;
};

export type QuizAcceptedChange = {
  filePath: string;
  language: string;
  applyMode: 'insert' | 'replace' | 'delete';
  originalCode: string;
  newCode: string;
  suggestionText: string;
  ragCourseCode: string;
  repoFullName: string;
};

type PublicQuiz = {
  id: string;
  trigger: 'after_accept' | 'teacher_launch';
  launchId: string | null;
  status: 'pending' | 'followup' | 'done' | 'skipped' | 'expired';
  topic: string;
  filePath: string;
  language: string;
  question: string;
  options: string[];
  createdAt: string;
  result: { correct: boolean; chosenIndex: number; correctIndex: number; explanation: string } | null;
  followUpQuestion: string | null;
  followUp: { answer: string; score: number | null; feedback: string } | null;
};

type ViewPhase = 'idle' | 'loading' | 'quiz' | 'error';

type ViewState = {
  phase: ViewPhase;
  message: string;
  quiz: PublicQuiz | null;
  busy: boolean;
  history: QuizHistoryItem[];
};

type QuizViewOptions = {
  memento: vscode.Memento;
  output: vscode.OutputChannel;
  getRequestContext: () => QuizRequestContext | null;
  openHistoryEntry: (id: string) => void;
  openAllHistory: () => void;
};

const ACCEPT_COUNT_KEY = 'adaceen.quiz.acceptCount';
const PENDING_POLL_MS = 30000;
const GENERATE_TIMEOUT_MS = 150000;
const DEFAULT_TIMEOUT_MS = 60000;

function randomId(length: number) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export class AdaceenQuizViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'adaceen.quizView';

  private view: vscode.WebviewView | null = null;
  private readonly nonce = randomId(32);
  private readonly disposables: vscode.Disposable[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private state: ViewState = { phase: 'idle', message: '', quiz: null, busy: false, history: [] };
  private lastAction: (() => Promise<void>) | null = null;
  private generation = 0;

  constructor(private readonly options: QuizViewOptions) {
    this.pollTimer = setInterval(() => {
      void this.checkPending(false);
    }, PENDING_POLL_MS);
    setTimeout(() => {
      void this.checkPending(false);
    }, 5000);
  }

  // --- API para extension.ts ------------------------------------------------

  updateHistory(history: QuizHistoryItem[]) {
    this.state = { ...this.state, history };
    this.postState();
  }

  /** Muestra el panel. preserveFocus: no quitarle el foco al editor. */
  async reveal(preserveFocus = true) {
    if (this.view) {
      this.view.show(preserveFocus);
      return;
    }
    await vscode.commands.executeCommand(`${AdaceenQuizViewProvider.viewType}.focus`);
    if (preserveFocus) {
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }
  }

  async onSuggestionAccepted(change: QuizAcceptedChange) {
    const acceptCount = (Number(this.options.memento.get<number>(ACCEPT_COUNT_KEY)) || 0) + 1;
    await this.options.memento.update(ACCEPT_COUNT_KEY, acceptCount);

    const generation = ++this.generation;
    const run = async () => {
      this.setState({ phase: 'loading', message: 'Preparando una pregunta sobre el cambio que aceptaste...', quiz: null, busy: true });
      const data = await this.request('POST', '/api/quiz/after-accept', {
        filePath: change.filePath,
        language: change.language,
        applyMode: change.applyMode,
        originalCode: change.originalCode.slice(0, 12000),
        newCode: change.newCode.slice(0, 12000),
        suggestionText: change.suggestionText.slice(0, 3000),
        acceptCount,
        ...(change.ragCourseCode ? { ragCourseCode: change.ragCourseCode.slice(0, 40) } : {}),
        ...(change.repoFullName ? { repoFullName: change.repoFullName.slice(0, 200) } : {}),
      }, GENERATE_TIMEOUT_MS);
      if (generation !== this.generation) {
        return; // llego otra aceptacion mientras tanto; manda la mas reciente
      }
      const quiz = (data?.quiz as PublicQuiz | null) || null;
      if (quiz) {
        this.setState({ phase: 'quiz', message: '', quiz, busy: false });
        await this.reveal(true);
        return;
      }
      const reason = String(data?.reason || '');
      this.options.output.appendLine(`[Quiz] sin pregunta tras aceptar (${reason || 'sin motivo'})${data?.error ? `: ${String(data.error)}` : ''}`);
      this.setState({ phase: 'idle', message: '', quiz: null, busy: false });
    };
    this.lastAction = run;
    await run().catch((error) => {
      if ((error as { status?: number })?.status === 404) {
        // Backend todavia sin las rutas del quiz: se sigue sin molestar al estudiante.
        this.options.output.appendLine('[Quiz] el backend no tiene /api/quiz (404); quiz desactivado hasta que se despliegue.');
        this.setState({ phase: 'idle', message: '', quiz: null, busy: false });
        return;
      }
      this.fail(error, 'No se pudo preparar la pregunta.');
    });
  }

  /** Quiz lanzado por el docente, o uno abierto que quedo sin responder. */
  async checkPending(fromUser: boolean) {
    if (this.state.phase === 'loading' || (this.state.phase === 'quiz' && this.state.quiz?.status !== 'done')) {
      return;
    }
    const data = await this.request('GET', '/api/quiz/pending', undefined, 15000).catch((error) => {
      if (fromUser) {
        void vscode.window.showWarningMessage(`ADACEEN: no se pudo consultar el quiz (${String(error?.message || error)}).`);
      }
      return null;
    });
    const quiz = (data?.quiz as PublicQuiz | null) || null;
    if (!quiz) {
      if (fromUser) {
        void vscode.window.showInformationMessage('ADACEEN: no hay ningun quiz pendiente.');
      }
      return;
    }
    if (this.state.quiz?.id === quiz.id) {
      return;
    }
    this.setState({ phase: 'quiz', message: '', quiz, busy: false });
    if (quiz.trigger === 'teacher_launch') {
      const visible = !!this.view?.visible;
      if (visible) {
        this.view?.show(true);
      } else {
        const pick = await vscode.window.showInformationMessage(
          `ADACEEN: tu docente lanzo un quiz${quiz.topic ? ` sobre "${quiz.topic}"` : ''}.`,
          'Responder',
        );
        if (pick === 'Responder') {
          await this.reveal(false);
        }
      }
    }
  }

  dispose() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.disposables.forEach((item) => item.dispose());
  }

  // --- WebviewViewProvider --------------------------------------------------

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.renderShell();
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((message: unknown) => {
        void this.handleMessage(message);
      }),
      webviewView.onDidDispose(() => {
        this.view = null;
      }),
    );
  }

  // --- internos -------------------------------------------------------------

  private setState(patch: Partial<ViewState>) {
    this.state = { ...this.state, ...patch };
    this.postState();
  }

  private postState() {
    if (this.view) {
      void this.view.webview.postMessage({ type: 'state', state: this.state });
    }
  }

  private fail(error: unknown, message: string) {
    const detail = error instanceof Error ? error.message : String(error);
    this.options.output.appendLine(`[Quiz] ${message} ${detail}`);
    this.setState({ phase: 'error', message: `${message} ${detail}`.trim(), busy: false });
  }

  /** Mismo id persistente que usan el resto de llamadas (client-identity.ts). */
  private clientId() {
    return getOrCreateClientId(this.options.memento);
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const context = this.options.getRequestContext();
    if (!context?.baseUrl) {
      throw new Error('sin backend configurado (adaceen.backend.baseUrl)');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${context.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          ...context.headers,
          [CLIENT_ID_HEADER]: this.clientId(),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok && response.status !== 409) {
        const failure = new Error(String(data.error || `HTTP ${response.status}`)) as Error & { status?: number };
        failure.status = response.status;
        throw failure;
      }
      return data;
    } catch (error) {
      if (error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError') {
        throw new Error('el backend tardo demasiado');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async handleMessage(message: unknown) {
    const data = message && typeof message === 'object' ? message as Record<string, unknown> : {};
    const quiz = this.state.quiz;
    switch (data.type) {
      case 'ready':
        this.postState();
        return;
      case 'answer': {
        const index = Number(data.index);
        if (!quiz || quiz.status !== 'pending' || this.state.busy || !Number.isInteger(index)) {
          return;
        }
        const run = async () => {
          this.setState({ busy: true });
          const result = await this.request('POST', `/api/quiz/${encodeURIComponent(quiz.id)}/answer`, { choiceIndex: index });
          this.setState({ phase: 'quiz', quiz: (result.quiz as PublicQuiz) || quiz, busy: false, message: '' });
        };
        this.lastAction = run;
        await run().catch((error) => this.fail(error, 'No se pudo enviar tu respuesta.'));
        return;
      }
      case 'followup': {
        const text = String(data.text || '').trim();
        if (!quiz || quiz.status !== 'followup' || this.state.busy || !text) {
          return;
        }
        const run = async () => {
          this.setState({ busy: true, message: 'Revisando tu explicacion...' });
          const result = await this.request('POST', `/api/quiz/${encodeURIComponent(quiz.id)}/followup`, { answer: text.slice(0, 2000) }, GENERATE_TIMEOUT_MS);
          this.setState({ phase: 'quiz', quiz: (result.quiz as PublicQuiz) || quiz, busy: false, message: '' });
        };
        this.lastAction = run;
        await run().catch((error) => this.fail(error, 'No se pudo enviar tu explicacion.'));
        return;
      }
      case 'skip':
        if (quiz && (quiz.status === 'pending' || quiz.status === 'followup')) {
          await this.request('POST', `/api/quiz/${encodeURIComponent(quiz.id)}/skip`, {}).catch(() => null);
        }
        this.setState({ phase: 'idle', quiz: null, busy: false, message: '' });
        return;
      case 'dismiss':
        this.setState({ phase: 'idle', quiz: null, busy: false, message: '' });
        return;
      case 'retry':
        if (this.lastAction) {
          await this.lastAction().catch((error) => this.fail(error, 'Sigue sin funcionar.'));
        } else {
          this.setState({ phase: 'idle', message: '' });
        }
        return;
      case 'checkPending':
        await this.checkPending(true);
        return;
      case 'openHistory':
        if (typeof data.id === 'string') {
          this.options.openHistoryEntry(data.id);
        }
        return;
      case 'showAllHistory':
        this.options.openAllHistory();
        return;
      default:
        return;
    }
  }

  private renderShell() {
    const nonce = this.nonce;
    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 10px 12px 16px; color: var(--vscode-foreground); background: transparent;
      font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.45; }
    h2 { margin: 14px 0 6px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
      color: var(--vscode-descriptionForeground); }
    h2:first-child { margin-top: 0; }
    .card { padding: 10px 12px 12px; border-radius: 6px; background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3)); }
    .card.quiz { border-color: var(--vscode-focusBorder); }
    .badge { display: inline-block; font-size: 10px; padding: 1px 7px; border-radius: 999px; margin-bottom: 6px;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .question { margin: 2px 0 10px; font-weight: 600; }
    .options { display: grid; gap: 6px; }
    button { font: inherit; cursor: pointer; }
    .option { text-align: left; padding: 7px 9px; border-radius: 4px; color: var(--vscode-foreground);
      background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); }
    .option:hover:not(:disabled) { border-color: var(--vscode-focusBorder); }
    .option:disabled { cursor: default; opacity: .85; }
    .option .letter { font-weight: 600; margin-right: 6px; }
    .option.correct { border-color: var(--vscode-testing-iconPassed, #33c789); background: rgba(51,199,137,.12); opacity: 1; }
    .option.wrong { border-color: var(--vscode-errorForeground, #f14c4c); background: rgba(241,76,76,.10); opacity: 1; }
    .verdict { margin: 10px 0 4px; font-weight: 600; }
    .verdict.ok { color: var(--vscode-testing-iconPassed, #33c789); }
    .verdict.bad { color: var(--vscode-errorForeground, #f14c4c); }
    textarea { width: 100%; box-sizing: border-box; min-height: 70px; margin: 6px 0; padding: 6px 8px; resize: vertical;
      font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); border-radius: 4px; }
    .row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .primary { padding: 5px 12px; border: 0; border-radius: 3px;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .primary:hover { background: var(--vscode-button-hoverBackground); }
    .secondary { padding: 5px 12px; border: 0; border-radius: 3px;
      background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .link { padding: 0; border: 0; background: none; color: var(--vscode-textLink-foreground); }
    .score { font-size: 20px; font-weight: 600; }
    .spinner { display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px; border-radius: 50%;
      border: 2px solid var(--vscode-descriptionForeground); border-top-color: transparent; animation: spin .9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    ul.history { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    ul.history li button { display: block; width: 100%; text-align: left; padding: 6px 8px; border-radius: 4px;
      background: transparent; color: var(--vscode-foreground); border: 1px solid transparent; }
    ul.history li button:hover { border-color: var(--vscode-widget-border, rgba(128,128,128,.35)); }
    ul.history .meta { display: block; font-size: 11px; color: var(--vscode-descriptionForeground); }
    ul.history .summary { display: block; font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  </style>
</head>
<body>
  <div id="quiz"></div>
  <h2>Historial</h2>
  <div id="history"></div>
  <script nonce="${nonce}">
    (function () {
      var vscode = acquireVsCodeApi();
      var quizEl = document.getElementById('quiz');
      var historyEl = document.getElementById('history');
      var LETTERS = ['A', 'B', 'C', 'D', 'E'];
      var lastQuizKey = '';

      function el(tag, attrs, children) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (key) {
          if (key === 'text') { node.textContent = attrs[key]; }
          else if (key === 'onclick') { node.addEventListener('click', attrs[key]); }
          else if (attrs[key] !== false && attrs[key] !== undefined && attrs[key] !== null) { node.setAttribute(key, attrs[key] === true ? '' : attrs[key]); }
        });
        (children || []).forEach(function (child) { if (child) node.appendChild(child); });
        return node;
      }
      function send(message) { vscode.postMessage(message); }

      function renderIdle(state) {
        return el('div', { class: 'card' }, [
          el('h2', { text: 'Quiz' }),
          el('p', { class: 'muted', text: 'Cuando aceptes una sugerencia de ADACEEN, aqui aparecera una pregunta corta para comprobar que entendiste el cambio. Tu docente tambien puede lanzar preguntas para la clase.' }),
          el('p', { class: 'muted', text: 'Puedes arrastrar este panel a la barra lateral derecha o al panel inferior.' }),
          el('div', { class: 'row' }, [el('button', { class: 'link', text: 'Buscar quiz del docente', onclick: function () { send({ type: 'checkPending' }); } })]),
        ]);
      }

      function renderQuiz(state) {
        var quiz = state.quiz;
        var result = quiz.result;
        var badge = quiz.trigger === 'teacher_launch'
          ? 'Lanzado por tu docente' + (quiz.topic ? ' · ' + quiz.topic : '')
          : 'Sobre tu cambio' + (quiz.filePath ? ' · ' + quiz.filePath.split(/[\\\\/]/).pop() : '');
        var children = [el('span', { class: 'badge', text: badge }), el('p', { class: 'question', text: quiz.question })];

        var options = el('div', { class: 'options' }, quiz.options.map(function (option, index) {
          var cls = 'option';
          if (result) {
            if (index === result.correctIndex) cls += ' correct';
            else if (index === result.chosenIndex) cls += ' wrong';
          }
          return el('button', {
            class: cls,
            disabled: !!result || state.busy,
            onclick: function () { send({ type: 'answer', index: index }); },
          }, [el('span', { class: 'letter', text: LETTERS[index] || String(index + 1) }), document.createTextNode(option)]);
        }));
        children.push(options);

        if (result) {
          children.push(el('p', { class: 'verdict ' + (result.correct ? 'ok' : 'bad'), text: result.correct ? 'Correcto.' : 'No es esa.' }));
          if (result.explanation) children.push(el('p', { class: 'muted', text: result.explanation }));
        }

        if (quiz.status === 'followup') {
          var previous = document.getElementById('followupText');
          var draft = previous ? previous.value : '';
          var area = el('textarea', { id: 'followupText', placeholder: 'Explicalo con tus palabras...', disabled: state.busy });
          area.value = draft;
          children.push(el('p', { class: 'question', text: quiz.followUpQuestion || '' }));
          children.push(area);
          children.push(el('div', { class: 'row' }, [
            el('button', { class: 'primary', disabled: state.busy, text: 'Enviar explicacion', onclick: function () {
              var node = document.getElementById('followupText');
              send({ type: 'followup', text: node ? node.value : '' });
            } }),
            el('button', { class: 'secondary', disabled: state.busy, text: 'Omitir', onclick: function () { send({ type: 'skip' }); } }),
          ]));
        } else if (quiz.followUp) {
          children.push(el('p', { class: 'question', text: quiz.followUpQuestion || 'Tu explicacion' }));
          children.push(el('p', { class: 'muted', text: '"' + quiz.followUp.answer + '"' }));
          if (typeof quiz.followUp.score === 'number') children.push(el('p', { class: 'score', text: quiz.followUp.score + ' / 100' }));
          children.push(el('p', { text: quiz.followUp.feedback }));
        }

        if (quiz.status === 'pending') {
          children.push(el('div', { class: 'row' }, [el('button', { class: 'link', disabled: state.busy, text: 'Omitir', onclick: function () { send({ type: 'skip' }); } })]));
        } else if (quiz.status !== 'followup') {
          children.push(el('div', { class: 'row' }, [el('button', { class: 'primary', text: 'Listo', onclick: function () { send({ type: 'dismiss' }); } })]));
        }
        if (state.busy && state.message) {
          children.push(el('p', { class: 'muted' }, [el('span', { class: 'spinner' }), document.createTextNode(state.message)]));
        }
        return el('div', { class: 'card quiz' }, children);
      }

      function render(state) {
        var quizKey = JSON.stringify([state.phase, state.message, state.busy, state.quiz]);
        if (quizKey !== lastQuizKey) {
          lastQuizKey = quizKey;
          var node;
          if (state.phase === 'loading') {
            node = el('div', { class: 'card' }, [el('p', { class: 'muted' }, [el('span', { class: 'spinner' }), document.createTextNode(state.message || 'Cargando...')])]);
          } else if (state.phase === 'error') {
            node = el('div', { class: 'card' }, [
              el('p', { class: 'verdict bad', text: state.message || 'Algo fallo.' }),
              el('div', { class: 'row' }, [
                el('button', { class: 'primary', text: 'Reintentar', onclick: function () { send({ type: 'retry' }); } }),
                el('button', { class: 'secondary', text: 'Cerrar', onclick: function () { send({ type: 'dismiss' }); } }),
              ]),
            ]);
          } else if (state.phase === 'quiz' && state.quiz) {
            node = renderQuiz(state);
          } else {
            node = renderIdle(state);
          }
          quizEl.replaceChildren(node);
        }

        var items = state.history || [];
        if (!items.length) {
          historyEl.replaceChildren(el('p', { class: 'muted', text: 'Aun no hay recomendaciones guardadas.' }));
        } else {
          historyEl.replaceChildren(
            el('ul', { class: 'history' }, items.map(function (item) {
              return el('li', {}, [el('button', { title: 'Ir a ese codigo', onclick: function () { send({ type: 'openHistory', id: item.id }); } }, [
                el('strong', { text: item.fileName }),
                el('span', { class: 'meta', text: item.meta }),
                el('span', { class: 'summary', text: item.summary }),
              ])]);
            })),
            el('div', { class: 'row' }, [el('button', { class: 'link', text: 'Ver historial completo', onclick: function () { send({ type: 'showAllHistory' }); } })])
          );
        }
        vscode.setState(state);
      }

      window.addEventListener('message', function (event) {
        var data = event.data || {};
        if (data.type === 'state' && data.state) render(data.state);
      });
      var saved = vscode.getState();
      if (saved) render(saved);
      send({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
  }
}
