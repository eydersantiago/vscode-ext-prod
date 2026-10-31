import * as vscode from 'vscode';
import type { FileViewDependencyGroup, FileViewState } from './file-view-model';

/**
 * Vista «Este archivo» (0.0.34). Desde la 0.0.38 es la primera vista del panel ADACEEN (su
 * icono en la barra de actividad): en el Explorador quedaba debajo de Esquema y Linea de tiempo
 * y casi nadie la veia. Arriba lleva el boton «Ver diagrama» y, en la esquina, el avance del
 * taller («35 %», con lo que falta al pasar el mouse).
 *
 * Volvio lo que la 0.0.26 se llevo junto con el panel de sugerencias (reunion
 * del 20/10/2026): de que trata el archivo activo y el acceso al material del
 * curso. Ese panel se abria al lado del codigo y le quitaba medio editor; aqui
 * queda a la vista sin tapar nada.
 *
 * El HTML se pinta una sola vez; los datos llegan por postMessage
 * (file-view-model.ts arma el estado) y el script redibuja.
 *
 * 0.0.36: cuadro «Dependencias» (pedido del 25/10/2026) debajo de «De qué trata»: lo que usa
 * el archivo de tu proyecto (se abre con un clic), las bibliotecas, lo que no se encontro y
 * quien lo usa. El clic manda (grupo, posicion); extension.ts busca el elemento.
 */

const DEPENDENCY_GROUPS: readonly FileViewDependencyGroup[] = ['local', 'libraries', 'missing', 'dependents'];

type FileViewHandlers = {
  /** La vista se mostro u oculto (para pedir el resumen o el material si faltan). */
  onVisible: () => void;
  openSource: (index: number) => void;
  openMaterial: (id: string) => void;
  loadMaterial: () => void;
  refreshSummary: () => void;
  openQuiz: () => void;
  /** key y label: de que cuadro y que elemento era el clic (el cuadro pudo cambiar despues). */
  openDependency: (group: FileViewDependencyGroup, index: number, key: string, id: string) => void;
  /** Boton «Ver diagrama» (0.0.38): abre el panel con el diagrama del taller y las dependencias. */
  openDiagram: () => void;
  /** La vista se oculto (0.0.38: deja de pedir el avance del taller cada 5 minutos). */
  onHidden?: () => void;
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
  /** Lo ultimo que se mando: el mismo estado otra vez no se manda (volver a pintar quita el foco). */
  private posted = '';
  /** El script del webview ya avisó que escucha (antes de eso un postMessage se pierde). */
  private ready = false;
  private focusPending = false;

  constructor(private readonly handlers: FileViewHandlers) {}

  get visible() {
    return !!this.view?.visible;
  }

  update(state: FileViewState) {
    this.state = state;
    this.applyDescription();
    const text = JSON.stringify(state);
    if (this.view && this.ready && text === this.posted) {
      return;
    }
    if (this.view) {
      this.posted = this.ready ? text : '';
      void this.view.webview.postMessage({ type: 'state', state });
    }
  }

  /**
   * 0.0.38: el avance tambien en la cabecera de la vista («ESTE ARCHIVO  35 %»), que se ve con la
   * vista plegada. El texto completo (lo que falta) esta en la pastilla de adentro.
   */
  private applyDescription() {
    if (this.view) {
      const pill = this.state?.progress;
      this.view.description = pill ? `${pill.text}${pill.stale ? ' · desactualizado' : ''}` : undefined;
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

  /**
   * Lleva la vista al cuadro «Dependencias» (comando ADACEEN: Ver dependencias del archivo). Si la
   * vista se acaba de crear, el aviso espera a que su script este listo.
   */
  focusDependencies() {
    if (this.view && this.ready) {
      void this.view.webview.postMessage({ type: 'focus', section: 'dependencies' });
      return;
    }
    this.focusPending = true;
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    this.ready = false;
    this.posted = '';
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.renderShell();
    this.applyDescription();
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message)),
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.handlers.onVisible();
        } else {
          this.handlers.onHidden?.();
        }
      }),
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = null;
          this.ready = false;
        }
        this.handlers.onHidden?.();
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
        this.ready = true;
        if (this.state && this.view) {
          this.posted = JSON.stringify(this.state);
          void this.view.webview.postMessage({ type: 'state', state: this.state });
        }
        if (this.focusPending && this.view) {
          this.focusPending = false;
          void this.view.webview.postMessage({ type: 'focus', section: 'dependencies' });
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
      case 'openDiagram':
        this.handlers.openDiagram();
        return;
      case 'openDependency':
        if (typeof data.group === 'string' && (DEPENDENCY_GROUPS as readonly string[]).includes(data.group) && Number.isInteger(data.index) && Number(data.index) >= 0) {
          this.handlers.openDependency(
            data.group as FileViewDependencyGroup,
            Number(data.index),
            typeof data.key === 'string' ? data.key : '',
            typeof data.id === 'string' ? data.id.slice(0, 2000) : '',
          );
        }
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
    .topbar { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; }
    .primary { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border: 0; border-radius: 3px;
      color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-weight: 600; }
    .primary:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
    .primary:focus-visible, .pill:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .primary .glyph { font-size: 14px; line-height: 1; }
    .pill { margin-left: auto; flex: none; display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 10px;
      font-size: 11px; font-weight: 600; line-height: 18px; cursor: help; border: 1px solid transparent;
      color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
    .pill.low { box-shadow: inset 3px 0 0 var(--vscode-charts-red, #f14c4c); }
    .pill.mid { box-shadow: inset 3px 0 0 var(--vscode-charts-yellow, #cca700); }
    .pill.high { box-shadow: inset 3px 0 0 var(--vscode-charts-green, #89d185); }
    .pill.stale { opacity: .75; border-style: dashed; border-color: var(--vscode-descriptionForeground); }
    .pill .stale-tag { font-weight: 500; color: inherit; opacity: .9; }
    .file { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: center; margin-bottom: var(--gap); }
    .file-tag { grid-row: span 2; min-width: 34px; height: 34px; padding: 0 6px; box-sizing: border-box; display: grid; place-items: center;
      border-radius: 6px; font-family: var(--vscode-editor-font-family); font-size: 11px; font-weight: 600; letter-spacing: .02em;
      color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); text-transform: lowercase; }
    .file-name { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-meta { font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    section { margin: 0 0 var(--gap); }
    h2 { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 8px; margin: 0 0 6px; font-size: 11px; font-weight: 600;
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
    .now .guide-label { margin: 8px 0 4px; }
    pre.guide { margin: 0; padding: 6px 8px; max-height: 260px; overflow: auto; border-radius: 4px; white-space: pre; tab-size: 4;
      font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size, 12px); line-height: 1.4;
      color: var(--vscode-editor-foreground); background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12)); }
    .now .guide-reason { margin: 4px 0 2px; font-size: 11px; }
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
    /* Cuadro «Dependencias» (0.0.36): acordeones plegados, «Ver dependencias» los abre. */
    details.deps { border: 1px solid var(--line); border-radius: 6px; scroll-margin-top: 8px; }
    details.deps.flash { animation: flash 1.4s ease-out; }
    @keyframes flash { from { box-shadow: 0 0 0 2px var(--vscode-focusBorder); } to { box-shadow: 0 0 0 2px transparent; } }
    details.deps summary { display: flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; user-select: none; }
    details.deps summary::-webkit-details-marker { display: none; }
    details.deps summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    details.deps > summary { padding: 6px 8px; border-radius: 6px; color: var(--vscode-textLink-foreground); }
    details.deps > summary:hover, details.dep-group > summary:hover { background: var(--vscode-list-hoverBackground); }
    .chev { flex: none; width: 0; height: 0; margin: 0 2px; border-left: 4px solid currentColor; border-top: 4px solid transparent;
      border-bottom: 4px solid transparent; transition: transform .12s ease; }
    details[open] > summary > .chev { transform: rotate(90deg); }
    .deps-flag { margin-left: auto; font-size: 11px; color: var(--vscode-editorWarning-foreground, #cca700); }
    .deps-body { padding: 0 8px 6px; }
    details.dep-group { border-top: 1px solid var(--line); }
    details.dep-group > summary { margin: 0 -8px; padding: 5px 8px; font-size: 12px; }
    details.dep-group.missing > summary { color: var(--vscode-editorWarning-foreground, #cca700); }
    .dep-count { margin-left: auto; min-width: 16px; padding: 0 5px; border-radius: 8px; font-size: 10px; line-height: 16px; text-align: center;
      color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
    details.dep-group > .dep-items { padding: 0 0 6px; }
    ul.deps-list { list-style: none; margin: 0 -6px; padding: 0; display: grid; gap: 1px; }
    ul.deps-list button { display: block; width: 100%; text-align: left; padding: 3px 6px; border-radius: 4px;
      color: var(--vscode-foreground); background: transparent; border: 1px solid transparent; }
    ul.deps-list button:hover, ul.deps-list button:focus-visible { background: var(--vscode-list-hoverBackground); outline: none; }
    ul.deps-list button:focus-visible { border-color: var(--vscode-focusBorder); }
    .dep-name { font-family: var(--vscode-editor-font-family); font-size: 12px; font-weight: 600; color: var(--vscode-textLink-foreground); overflow-wrap: anywhere; }
    .dep-meta { display: block; font-size: 11px; color: var(--muted); }
    .dep-warn { display: block; font-size: 11px; color: var(--vscode-editorWarning-foreground, #cca700); }
    ul.libs .dep-name { color: var(--vscode-foreground); font-weight: 500; margin-right: 6px; }
    ul.libs .dep-meta { display: inline; }
    details.dep-group.missing ul.deps-list button { border-left: 2px solid var(--vscode-editorWarning-foreground, #cca700); border-radius: 0 4px 4px 0; }
    details.dep-group.missing .dep-name { color: var(--vscode-foreground); }
    .dep-more { margin: 2px 0 0; padding: 0; border: 0; background: none; color: var(--vscode-textLink-foreground); font-size: 11px; }
    .dep-more:hover { text-decoration: underline; }
    .deps-body > .muted { margin: 2px 0 6px; }
    .deps-note { margin: 6px 0 0; font-size: 11px; color: var(--muted); }
    @media (prefers-reduced-motion: reduce) { .spinner, details.deps.flash { animation: none; } .chev { transition: none; } }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  </style>
</head>
<body>
  <main id="root"></main>
  <div id="status" class="sr-only" role="status" aria-live="polite"></div>
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
          else if (key === 'ontoggle') { node.addEventListener('toggle', attrs[key]); }
          else if (attrs[key] !== false && attrs[key] !== undefined && attrs[key] !== null) { node.setAttribute(key, attrs[key] === true ? '' : attrs[key]); }
        });
        (children || []).forEach(function (child) { if (child) node.appendChild(child); });
        return node;
      }
      function send(message) { vscode.postMessage(message); }
      function fold(value) { return String(value || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, ''); }
      function spinnerText(text) { return el('p', { class: 'muted' }, [el('span', { class: 'spinner', 'aria-hidden': 'true' }), document.createTextNode(text)]); }

      // 0.0.38: «Ver diagrama» arriba y el avance del taller en la esquina (con o sin archivo).
      function topbar(state) {
        var pill = state && state.progress;
        return el('div', { class: 'topbar' }, [
          el('button', { class: 'primary', 'data-focus': 'diagram', title: 'Cómo debe quedar el taller y las dependencias de tu proyecto', onclick: function () { send({ type: 'openDiagram' }); } }, [
            el('span', { class: 'glyph', 'aria-hidden': 'true', text: '◇' }),
            document.createTextNode('Ver diagrama'),
          ]),
          pill ? el('span', { class: 'pill ' + pill.level + (pill.stale ? ' stale' : ''), title: pill.title, tabindex: '0', role: 'status', 'aria-label': pill.title, 'data-focus': 'progress' }, [
            document.createTextNode(pill.text),
            pill.stale ? el('span', { class: 'stale-tag', text: '· desactualizado' }) : null,
          ]) : null,
        ]);
      }

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
          state.summaryLoading ? null : el('button', { class: 'link', 'data-focus': 'summary', text: state.overviewFrom === 'tutor' ? 'Actualizar resumen' : 'Pedir resumen al tutor', onclick: function () { send({ type: 'refreshSummary' }); } }),
        ]));
        return el('section', {}, children);
      }

      // Cuadro «Dependencias» (0.0.36), en acordeones para no llenar la vista (pedido del 25/10):
      // plegado, «Ver dependencias» lo abre; adentro, cada grupo tambien se abre con un clic. Lo
      // abierto se recuerda (tambien al cambiar de archivo) y cada grupo muestra 6 antes de «Ver N más».
      var DEP_VISIBLE = 6;
      var ui = { depsOpen: false, groups: {} };
      var expanded = {};
      var expandedFile = '';
      var pendingFocus = false;
      var flashUntil = 0;
      var announced = '';
      var DEP_GROUPS = [
        { key: 'local', label: 'Usa de tu proyecto', listClass: 'deps-list' },
        { key: 'libraries', label: 'Bibliotecas', listClass: 'deps-list libs' },
        { key: 'missing', label: 'No encontradas', listClass: 'deps-list' },
        { key: 'dependents', label: 'La usan', listClass: 'deps-list' },
      ];

      function depItem(item, group, index, key) {
        return el('li', {}, [
          el('button', { title: item.title || '', 'data-focus': 'item:' + group + ':' + item.id, onclick: function () { send({ type: 'openDependency', group: group, index: index, key: key, id: item.id }); } }, [
            el('span', { class: 'dep-name', text: item.label }),
            item.meta ? el('span', { class: 'dep-meta', text: item.meta }) : null,
            item.warning ? el('span', { class: 'dep-warn', text: item.warning }) : null,
          ]),
        ]);
      }

      function depGroup(deps, group) {
        var items = deps[group.key] || [];
        var emptyText = !items.length && group.key === 'dependents' ? deps.emptyDependents : '';
        if (!items.length && !emptyText) return null;
        var more = !!expanded[group.key];
        var shown = more ? items : items.slice(0, DEP_VISIBLE);
        var hidden = items.length - shown.length;
        var body = emptyText
          ? [el('p', { class: 'muted', text: emptyText })]
          : [
            el('ul', { class: group.listClass }, shown.map(function (item, index) { return depItem(item, group.key, index, deps.key || ''); })),
            hidden > 0 || more && items.length > DEP_VISIBLE
              ? el('button', { class: 'dep-more', 'data-focus': 'more:' + group.key, text: hidden > 0 ? 'Ver ' + hidden + ' más' : 'Ver menos', onclick: function () {
                expanded[group.key] = !more; render(lastState);
              } })
              : null,
          ];
        return el('details', { class: 'dep-group ' + group.key, open: !!ui.groups[group.key], ontoggle: function (event) {
          ui.groups[group.key] = event.target.open; saveView();
        } }, [
          el('summary', { 'data-focus': 'group:' + group.key }, [
            el('span', { class: 'chev', 'aria-hidden': 'true' }),
            document.createTextNode(group.label),
            el('span', { class: 'dep-count', text: String(items.length) }),
          ]),
          el('div', { class: 'dep-items' }, body),
        ]);
      }

      function dependenciesSection(state) {
        var deps = state.dependencies;
        if (!deps) return null;
        if (expandedFile !== state.fileName) { expanded = {}; expandedFile = state.fileName; }
        var empty = !deps.local.length && !deps.libraries.length && !deps.missing.length && !deps.dependents.length;
        var loading = deps.status === 'loading' && empty;
        var flag = loading
          ? el('span', { class: 'deps-flag' }, [el('span', { class: 'spinner', 'aria-hidden': 'true' })])
          : deps.missing.length ? el('span', { class: 'deps-flag', text: deps.missing.length + ' sin encontrar' }) : null;
        var title = el('span', { class: 'deps-title', text: ui.depsOpen ? 'Ocultar dependencias' : 'Ver dependencias' });
        var body = [];
        if (loading) {
          body.push(spinnerText('Buscando las dependencias en el proyecto…'));
        } else {
          if (deps.emptyUses) body.push(el('p', { class: 'muted', text: deps.emptyUses }));
          DEP_GROUPS.forEach(function (group) { body.push(depGroup(deps, group)); });
          if (deps.note) body.push(el('p', { class: 'deps-note', text: deps.note }));
        }
        var box = el('details', { class: 'deps', id: 'deps', open: ui.depsOpen, ontoggle: function (event) {
          ui.depsOpen = event.target.open;
          title.textContent = ui.depsOpen ? 'Ocultar dependencias' : 'Ver dependencias';
          saveView();
        } }, [
          el('summary', { title: deps.summary || '', 'data-focus': 'deps' }, [el('span', { class: 'chev', 'aria-hidden': 'true' }), title, flag]),
          el('div', { class: 'deps-body' }, body),
        ]);
        // El resaltado del comando sigue aunque llegue otro estado y se vuelva a pintar.
        var flashLeft = flashUntil - Date.now();
        if (flashLeft > 0) {
          box.classList.add('flash');
          box.style.animationDelay = '-' + (1400 - flashLeft) + 'ms';
        }
        return el('section', { 'aria-label': 'Dependencias del archivo' }, [box]);
      }

      // Comando «ADACEEN: Ver dependencias del archivo»: abre el acordeon y lo trae a la vista.
      function focusDependencies() {
        var box = document.getElementById('deps');
        if (!box) { pendingFocus = true; return; }
        pendingFocus = false;
        if (!ui.depsOpen) {
          ui.depsOpen = true;
          render(lastState);
          box = document.getElementById('deps');
          if (!box) return;
        }
        box.scrollIntoView({ block: 'start' });
        box.classList.remove('flash');
        box.style.animationDelay = '';
        void box.offsetWidth;
        box.classList.add('flash');
        flashUntil = Date.now() + 1400;
        var summary = box.querySelector('summary');
        if (summary) summary.focus();
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
        var guide = state.suggestion.guide;
        return el('section', {}, [
          el('h2', { text: 'Sugerencia de ahora' }),
          el('div', { class: 'now' }, [
            el('div', { text: state.suggestion.headline }),
            // 0.0.38: el codigo que no se aplica con un clic se ve aqui tambien, de solo lectura.
            guide ? el('p', { class: 'label guide-label', text: 'Código de guía (no se aplica con un clic):' }) : null,
            guide ? el('pre', { class: 'guide', 'aria-label': 'Código de guía del tutor' }, [el('code', { text: guide.code })]) : null,
            guide && guide.reason ? el('p', { class: 'muted guide-reason', text: guide.reason }) : null,
            el('div', { class: 'status', text: state.suggestion.status + (guide ? ' · escríbelo tú usando la guía' : ' · el código y las acciones están junto a tu selección') }),
          ]),
        ]);
      }

      function sourceItem(source) {
        return el('li', { class: source.supplemental ? 'supplemental' : '' }, [
          el('button', { title: 'Abrir en el navegador', 'data-focus': 'source:' + source.index, onclick: function () { send({ type: 'openSource', index: source.index }); } }, [
            el('span', { class: 'title', text: source.title }),
            source.meta ? el('span', { class: 'meta', text: source.meta }) : null,
            source.excerpt ? el('span', { class: 'preview', text: source.excerpt }) : null,
          ]),
        ]);
      }

      function materialItem(item) {
        return el('li', { class: item.supplemental ? 'supplemental' : '' }, [
          el('button', { title: 'Abrir en el navegador', 'data-focus': 'material:' + item.id, onclick: function () { send({ type: 'openMaterial', id: item.id }); } }, [
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
          children.push(el('button', { class: 'secondary', 'data-focus': 'material-load', text: 'Ver todo el material del curso', onclick: function () { send({ type: 'loadMaterial' }); } }));
        } else if (material.status === 'loading') {
          children.push(spinnerText('Buscando el material del curso…'));
        } else if (material.status === 'no_session' || material.status === 'error') {
          children.push(el('p', { class: 'muted' + (material.status === 'error' ? ' error' : ''), text: material.message }));
          children.push(el('div', { class: 'row' }, [el('button', { class: 'link', 'data-focus': 'material-retry', text: 'Reintentar', onclick: function () { send({ type: 'loadMaterial' }); } })]));
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

      // Si se vuelve a pintar con el foco en un boton (o en un grupo), el foco vuelve a ese mismo
      // boton: antes quedaba en <body> y el teclado o el lector de pantalla perdian el lugar.
      function restoreFocus(key) {
        if (!key) return;
        var nodes = root.querySelectorAll('[data-focus]');
        for (var i = 0; i < nodes.length; i += 1) {
          if (nodes[i].getAttribute('data-focus') === key) { nodes[i].focus({ preventScroll: true }); return; }
        }
      }

      // Lo que lee el lector de pantalla: solo cuando el cuadro de otro archivo termina de cargar
      // (antes toda la vista era «aria-live» y se leia otra vez con cada actualizacion).
      function announce(state) {
        var deps = state && state.hasFile && state.dependencies;
        var text = deps && deps.status === 'ready' ? state.fileName + ': ' + (deps.summary || 'sin dependencias') : '';
        if (text && text !== announced) {
          announced = text;
          document.getElementById('status').textContent = 'Dependencias de ' + text;
        }
      }

      function render(state) {
        lastState = state;
        var focused = document.activeElement && document.activeElement.type === 'search';
        var focusKey = document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-focus') : null;
        if (!state || !state.hasFile) {
          root.replaceChildren.apply(root, [
            topbar(state),
            el('p', { class: 'muted', text: 'Abre un archivo de tu proyecto: aquí verás de qué trata, qué usa y el material del curso que usa el tutor.' }),
            el('div', { class: 'divider' }),
            state ? materialSection(state) : null
          ].filter(Boolean));
        } else {
          var parts = [topbar(state), header(state), overviewSection(state), dependenciesSection(state), tipsSection(state), nowSection(state), materialSection(state),
            el('div', { class: 'row' }, [el('button', { class: 'link', 'data-focus': 'quiz', text: 'Quiz e historial', onclick: function () { send({ type: 'openQuiz' }); } })])];
          root.replaceChildren.apply(root, parts.filter(Boolean));
        }
        if (focused) {
          var input = document.querySelector('input[type=search]');
          if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
        } else {
          restoreFocus(focusKey);
        }
        announce(state);
        if (pendingFocus) {
          if (state && state.dependencies && state.dependencies.status === 'ready') focusDependencies();
          else if (!state || !state.dependencies) pendingFocus = false;
        }
        saveView();
      }

      // Lo que se recuerda si VS Code recarga la vista: el ultimo estado y lo abierto.
      function saveView() {
        vscode.setState({ v: 2, state: lastState, ui: ui });
      }

      window.addEventListener('message', function (event) {
        var data = event.data || {};
        if (data.type === 'state' && data.state) render(data.state);
        if (data.type === 'focus' && data.section === 'dependencies') focusDependencies();
      });
      var saved = vscode.getState();
      if (saved && saved.v === 2) {
        if (saved.ui && typeof saved.ui === 'object') {
          ui.depsOpen = !!saved.ui.depsOpen;
          ui.groups = saved.ui.groups && typeof saved.ui.groups === 'object' ? saved.ui.groups : {};
        }
        if (saved.state) render(saved.state);
      } else if (saved && typeof saved === 'object' && 'hasFile' in saved) {
        render(saved); // estado guardado por la 0.0.35
      }
      send({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
  }
}
