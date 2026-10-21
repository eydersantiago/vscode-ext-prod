import * as vscode from 'vscode';
import type { FileViewState } from './file-view-model';

/**
 * Vista «Este archivo» (0.0.34), en el Explorador debajo del arbol de archivos
 * (el estudiante la puede arrastrar a otro lado y VS Code lo recuerda).
 *
 * Volvio lo que la 0.0.26 se llevo junto con el panel de sugerencias (reunion
 * del 20/10/2026): de que trata el archivo activo y el acceso al material del
 * curso. Ese panel se abria al lado del codigo y le quitaba medio editor; aqui
 * queda a la vista sin tapar nada.
 *
 * El HTML se pinta una sola vez; los datos llegan por postMessage
 * (file-view-model.ts arma el estado) y el script redibuja.
 */

type FileViewHandlers = {
  /** La vista se mostro u oculto (para pedir el resumen o el material si faltan). */
  onVisible: () => void;
  openSource: (index: number) => void;
  openMaterial: (id: string) => void;
  loadMaterial: () => void;
  refreshSummary: () => void;
  openQuiz: () => void;
};

function randomId(length: number) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export class AdaceenFileViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'adaceen.fileView';

  private view: vscode.WebviewView | null = null;
  private readonly nonce = randomId(32);
  private readonly disposables: vscode.Disposable[] = [];
  private state: FileViewState | null = null;

  constructor(private readonly handlers: FileViewHandlers) {}

  get visible() {
    return !!this.view?.visible;
  }

  update(state: FileViewState) {
    this.state = state;
    if (this.view) {
      void this.view.webview.postMessage({ type: 'state', state });
    }
  }

  /** Muestra la vista. preserveFocus: no quitarle el foco al editor. */
  async reveal(preserveFocus = true) {
    if (this.view) {
      this.view.show(preserveFocus);
      return;
    }
    await vscode.commands.executeCommand(`${AdaceenFileViewProvider.viewType}.focus`);
    if (preserveFocus) {
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.renderShell();
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message)),
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.handlers.onVisible();
        }
      }),
      webviewView.onDidDispose(() => {
        this.view = null;
      }),
    );
    this.handlers.onVisible();
  }

  dispose() {
    this.disposables.forEach((item) => item.dispose());
  }

  private handleMessage(message: unknown) {
    const data = message && typeof message === 'object' ? message as Record<string, unknown> : {};
    switch (data.type) {
      case 'ready':
        if (this.state && this.view) {
          void this.view.webview.postMessage({ type: 'state', state: this.state });
        }
        return;
      case 'openSource':
        if (Number.isInteger(data.index)) {
          this.handlers.openSource(Number(data.index));
        }
        return;
      case 'openMaterial':
        if (typeof data.id === 'string' && data.id) {
          this.handlers.openMaterial(data.id);
        }
        return;
      case 'loadMaterial':
        this.handlers.loadMaterial();
        return;
      case 'refreshSummary':
        this.handlers.refreshSummary();
        return;
      case 'openQuiz':
        this.handlers.openQuiz();
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
    :root { --gap: 14px; --muted: var(--vscode-descriptionForeground); --line: var(--vscode-widget-border, rgba(128,128,128,.28)); }
    body { margin: 0; padding: 10px 14px 18px; color: var(--vscode-foreground); background: transparent;
      font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.5; }
    button { font: inherit; cursor: pointer; }
    .file { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: center; margin-bottom: var(--gap); }
    .file-tag { grid-row: span 2; min-width: 34px; height: 34px; padding: 0 6px; box-sizing: border-box; display: grid; place-items: center;
      border-radius: 6px; font-family: var(--vscode-editor-font-family); font-size: 11px; font-weight: 600; letter-spacing: .02em;
      color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); text-transform: lowercase; }
    .file-name { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-meta { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    section { margin: 0 0 var(--gap); }
    h2 { display: flex; align-items: baseline; gap: 8px; margin: 0 0 6px; font-size: 11px; font-weight: 600;
      letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
    h2 .count { font-weight: 500; letter-spacing: 0; text-transform: none; }
    .overview { margin: 0; padding: 8px 10px; border-left: 3px solid var(--vscode-textLink-foreground);
      background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.08)); border-radius: 0 4px 4px 0; }
    .overview.local { border-left-color: var(--line); }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 6px; font-size: 11px; color: var(--muted); }
    .link { padding: 0; border: 0; background: none; color: var(--vscode-textLink-foreground); font-size: inherit; }
    .link:hover { text-decoration: underline; }
    ol.tips { margin: 0; padding: 0; list-style: none; counter-reset: tip; display: grid; gap: 6px; }
    ol.tips li { counter-increment: tip; display: grid; grid-template-columns: 18px 1fr; gap: 6px; }
    ol.tips li::before { content: counter(tip); width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center;
      font-size: 10px; font-weight: 600; color: var(--vscode-button-foreground); background: var(--vscode-button-background); margin-top: 1px; }
    .now { padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; }
    .now .status { font-size: 11px; color: var(--muted); }
    .label { margin: 0 0 4px; font-size: 11px; color: var(--muted); }
    ul.list { list-style: none; margin: 0 -8px; padding: 0; display: grid; gap: 2px; }
    ul.list li button { display: block; width: 100%; text-align: left; padding: 6px 8px; border-radius: 4px; color: var(--vscode-foreground);
      background: transparent; border: 1px solid transparent; }
    ul.list li button:hover, ul.list li button:focus-visible { background: var(--vscode-list-hoverBackground); outline: none; }
    ul.list li button:focus-visible { border-color: var(--vscode-focusBorder); }
    ul.list .title { display: block; font-weight: 600; color: var(--vscode-textLink-foreground); }
    ul.list .meta { display: block; font-size: 11px; color: var(--muted); }
    ul.list .preview { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 12px; color: var(--muted); margin-top: 2px; }
    ul.list li.supplemental .title { color: var(--vscode-foreground); font-weight: 500; }
    .secondary { padding: 5px 12px; border: 0; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground)); }
    input[type=search] { width: 100%; box-sizing: border-box; margin: 2px 0 8px; padding: 4px 8px; font: inherit; color: var(--vscode-input-foreground);
      background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--line)); border-radius: 3px; }
    input[type=search]:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .muted { color: var(--muted); font-size: 12px; margin: 0; }
    .error { color: var(--vscode-errorForeground); }
    .divider { height: 1px; background: var(--line); margin: 10px 0; }
    .spinner { display: inline-block; width: 9px; height: 9px; margin-right: 6px; vertical-align: -1px; border-radius: 50%;
      border: 2px solid var(--muted); border-top-color: transparent; animation: spin .9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  </style>
</head>
<body>
  <main id="root" aria-live="polite"></main>
  <script nonce="${nonce}">
    (function () {
      var vscode = acquireVsCodeApi();
      var root = document.getElementById('root');
      var query = '';

      function el(tag, attrs, children) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (key) {
          if (key === 'text') { node.textContent = attrs[key]; }
          else if (key === 'onclick') { node.addEventListener('click', attrs[key]); }
          else if (key === 'oninput') { node.addEventListener('input', attrs[key]); }
          else if (attrs[key] !== false && attrs[key] !== undefined && attrs[key] !== null) { node.setAttribute(key, attrs[key] === true ? '' : attrs[key]); }
        });
        (children || []).forEach(function (child) { if (child) node.appendChild(child); });
        return node;
      }
      function send(message) { vscode.postMessage(message); }
      function fold(value) { return String(value || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, ''); }
      function spinnerText(text) { return el('p', { class: 'muted' }, [el('span', { class: 'spinner', 'aria-hidden': 'true' }), document.createTextNode(text)]); }

      function header(state) {
        var tag = (state.language || 'txt').replace(/[^a-z0-9+#]/gi, '').slice(0, 6) || 'txt';
        return el('header', { class: 'file' }, [
          el('span', { class: 'file-tag', 'aria-hidden': 'true', text: tag }),
          el('div', { class: 'file-name', text: state.fileName, title: state.fileName }),
          el('div', { class: 'file-meta', text: state.focusLabel || 'Archivo completo' }),
        ]);
      }

      function overviewSection(state) {
        var children = [el('h2', { text: 'De qué trata' })];
        if (state.overview) {
          children.push(el('p', { class: 'overview' + (state.overviewFrom === 'local' ? ' local' : ''), text: state.overview }));
        }
        if (state.summaryLoading) {
          children.push(spinnerText(state.overview ? 'El tutor está leyendo el archivo para resumirlo…' : 'El tutor está leyendo el archivo…'));
        } else if (!state.overview) {
          children.push(el('p', { class: 'muted', text: 'Todavía no hay resumen de este archivo.' }));
        }
        var note = state.overviewFrom === 'tutor' ? 'Resumen del tutor' : state.overviewFrom === 'local' ? 'Descripción rápida, sin el tutor' : '';
        children.push(el('div', { class: 'row' }, [
          note ? el('span', { text: note }) : null,
          state.summaryLoading ? null : el('button', { class: 'link', text: state.overviewFrom === 'tutor' ? 'Actualizar resumen' : 'Pedir resumen al tutor', onclick: function () { send({ type: 'refreshSummary' }); } }),
        ]));
        return el('section', {}, children);
      }

      function tipsSection(state) {
        if (!state.tips || !state.tips.length) return null;
        return el('section', {}, [
          el('h2', { text: 'Para seguir' }),
          el('ol', { class: 'tips' }, state.tips.map(function (tip) { return el('li', { text: tip }); })),
        ]);
      }

      function nowSection(state) {
        if (!state.suggestion) return null;
        return el('section', {}, [
          el('h2', { text: 'Sugerencia de ahora' }),
          el('div', { class: 'now' }, [
            el('div', { text: state.suggestion.headline }),
            el('div', { class: 'status', text: state.suggestion.status + ' · el código y las acciones están junto a tu selección' }),
          ]),
        ]);
      }

      function sourceItem(source) {
        return el('li', { class: source.supplemental ? 'supplemental' : '' }, [
          el('button', { title: 'Abrir en el navegador', onclick: function () { send({ type: 'openSource', index: source.index }); } }, [
            el('span', { class: 'title', text: source.title }),
            source.meta ? el('span', { class: 'meta', text: source.meta }) : null,
            source.excerpt ? el('span', { class: 'preview', text: source.excerpt }) : null,
          ]),
        ]);
      }

      function materialItem(item) {
        return el('li', { class: item.supplemental ? 'supplemental' : '' }, [
          el('button', { title: 'Abrir en el navegador', onclick: function () { send({ type: 'openMaterial', id: item.id }); } }, [
            el('span', { class: 'title', text: item.title }),
            item.meta ? el('span', { class: 'meta', text: item.meta }) : null,
            item.preview ? el('span', { class: 'preview', text: item.preview }) : null,
          ]),
        ]);
      }

      function materialSection(state) {
        var material = state.material || { status: 'idle', items: [] };
        var title = el('h2', {}, [document.createTextNode('Material del curso'), material.courseCode ? el('span', { class: 'count', text: material.courseCode }) : null]);
        var children = [title];
        if (state.sources && state.sources.length) {
          children.push(el('p', { class: 'label', text: 'Citado en la última sugerencia' }));
          children.push(el('ul', { class: 'list' }, state.sources.map(sourceItem)));
          children.push(el('div', { class: 'divider' }));
        }
        if (material.status === 'idle') {
          children.push(el('button', { class: 'secondary', text: 'Ver todo el material del curso', onclick: function () { send({ type: 'loadMaterial' }); } }));
        } else if (material.status === 'loading') {
          children.push(spinnerText('Buscando el material del curso…'));
        } else if (material.status === 'no_session' || material.status === 'error') {
          children.push(el('p', { class: 'muted' + (material.status === 'error' ? ' error' : ''), text: material.message }));
          children.push(el('div', { class: 'row' }, [el('button', { class: 'link', text: 'Reintentar', onclick: function () { send({ type: 'loadMaterial' }); } })]));
        } else {
          var items = material.items || [];
          if (!items.length) {
            children.push(el('p', { class: 'muted', text: 'Tu docente todavía no cargó material para este curso.' }));
          } else {
            if (items.length > 6) {
              children.push(el('input', { type: 'search', placeholder: 'Buscar en el material', 'aria-label': 'Buscar en el material del curso', value: query, oninput: function (event) {
                query = event.target.value; renderList();
              } }));
            }
            var list = el('ul', { class: 'list', id: 'materialList' });
            children.push(list);
            setTimeout(renderList, 0);
          }
        }
        return el('section', {}, children);
      }

      var lastState = null;
      function renderList() {
        var list = document.getElementById('materialList');
        if (!list || !lastState) return;
        var probe = fold(query.trim());
        var items = (lastState.material.items || []).filter(function (item) { return !probe || fold(item.title + ' ' + item.meta).indexOf(probe) >= 0; });
        list.replaceChildren.apply(list, items.length ? items.map(materialItem) : [el('li', {}, [el('p', { class: 'muted', text: 'Nada coincide con la búsqueda.' })])]);
      }

      function render(state) {
        lastState = state;
        var focused = document.activeElement && document.activeElement.type === 'search';
        if (!state || !state.hasFile) {
          root.replaceChildren(
            el('p', { class: 'muted', text: 'Abre un archivo de tu proyecto: aquí verás de qué trata y el material del curso que usa el tutor.' }),
            el('div', { class: 'divider' }),
            state ? materialSection(state) : null
          );
        } else {
          var parts = [header(state), overviewSection(state), tipsSection(state), nowSection(state), materialSection(state),
            el('div', { class: 'row' }, [el('button', { class: 'link', text: 'Quiz e historial', onclick: function () { send({ type: 'openQuiz' }); } })])];
          root.replaceChildren.apply(root, parts.filter(Boolean));
        }
        if (focused) {
          var input = document.querySelector('input[type=search]');
          if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
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
