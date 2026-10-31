// ADACEEN (VS Code): panel «Ver diagrama» en el area del editor (0.0.38).
//
// Dos secciones: «Cómo debe quedar» (el diagrama de clases del taller con el estado de cada clase
// en el codigo del estudiante) y «Dependencias de tu proyecto» (sus archivos y quien incluye a
// quien). El SVG lo arma la extension (diagram-svg.ts, con el texto escapado) y llega por
// postMessage; el script del panel solo lo inserta y avisa los clics. Sin recursos externos y con
// CSP estricta (nonce): funciona igual en vscode.dev. Los colores salen del tema de VS Code.
import * as vscode from 'vscode';
import type { DiagramViewState } from './diagram-model';
import { buildDiagramPanelMessage, parseDiagramPanelInboundMessage } from './diagram-panel-messages';
import type { DiagramPanelMessage } from './diagram-panel-messages';

export type DiagramPanelHandlers = {
  /** «Actualizar»: volver a leer el proyecto. */
  refresh: () => void;
  /** Clic en una clase o un archivo: abrir esa ruta relativa (solo las que mando la extension). */
  open: (path: string, line: number) => void;
  /** El panel se cerro. */
  onDispose: () => void;
  /** El panel volvio a verse (estaba detras de otra pestaña). */
  onVisible: () => void;
};

function assertNeverMessage(message: never): never {
  throw new Error(`Mensaje del panel sin manejar: ${JSON.stringify(message)}`);
}

function randomNonce() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < 32; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export class AdaceenDiagramPanel implements vscode.Disposable {
  static readonly viewType = 'adaceen.diagram';

  private panel: vscode.WebviewPanel | null = null;
  private ready = false;
  private pending: DiagramPanelMessage | null = null;

  constructor(private readonly handlers: DiagramPanelHandlers) {}

  get isOpen() {
    return !!this.panel;
  }

  get visible() {
    return !!this.panel?.visible;
  }

  /** Abre el panel (o lo trae al frente) junto al editor. */
  show() {
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      AdaceenDiagramPanel.viewType,
      'ADACEEN · Diagrama',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    this.panel = panel;
    this.ready = false;
    panel.webview.html = this.renderShell(randomNonce());
    // Los oyentes son de este panel: se desechan con el (antes se juntaban con cada panel nuevo).
    const listeners: vscode.Disposable[] = [];
    listeners.push(
      panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message)),
      panel.onDidChangeViewState((event) => {
        if (event.webviewPanel.visible) {
          this.handlers.onVisible();
        }
      }),
      panel.onDidDispose(() => {
        listeners.splice(0).forEach((item) => item.dispose());
        if (this.panel === panel) {
          this.panel = null;
          this.ready = false;
          this.pending = null;
        }
        this.handlers.onDispose();
      }),
    );
  }

  update(state: DiagramViewState) {
    const message = buildDiagramPanelMessage(state);
    if (this.panel && this.ready) {
      void this.panel.webview.postMessage(message);
      return;
    }
    this.pending = message;
  }

  dispose() {
    // Cerrar el panel desecha sus oyentes (onDidDispose).
    this.panel?.dispose();
    this.panel = null;
  }

  private handleMessage(raw: unknown) {
    const message = parseDiagramPanelInboundMessage(raw);
    if (!message) {
      return;
    }
    switch (message.type) {
      case 'ready':
        // Lo leido mientras el panel cargaba (quien lo abre ya pidio leer el proyecto).
        this.ready = true;
        if (this.pending && this.panel) {
          void this.panel.webview.postMessage(this.pending);
          this.pending = null;
        }
        return;
      case 'refresh':
        this.handlers.refresh();
        return;
      case 'open':
        this.handlers.open(message.path, message.line);
        return;
      default:
        assertNeverMessage(message);
    }
  }

  private renderShell(nonce: string) {
    return `<!doctype html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ADACEEN · Diagrama</title>
  <style nonce="${nonce}">
    :root {
      --muted: var(--vscode-descriptionForeground);
      --line: var(--vscode-widget-border, rgba(128,128,128,.35));
      --done: var(--vscode-charts-green, #388a34);
      --partial: var(--vscode-charts-yellow, #bf8803);
      --missing: var(--vscode-charts-red, #e51400);
      --accent: var(--vscode-focusBorder, #007fd4);
      --card: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 18px 22px 28px; color: var(--vscode-foreground); background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.5; }
    header.top { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin-bottom: 14px; }
    h1 { margin: 0; font-size: 16px; font-weight: 600; }
    .updated { color: var(--muted); font-size: 12px; }
    button { font: inherit; cursor: pointer; }
    .refresh { margin-left: auto; padding: 4px 12px; border: 0; border-radius: 3px; color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground); }
    .refresh:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground)); }
    .refresh:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
    section { margin: 0 0 22px; padding: 14px 16px 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
    h2 { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin: 0 0 4px; font-size: 13px; font-weight: 600;
      letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
    .sub { margin: 0 0 10px; color: var(--muted); font-size: 12px; }
    .stats { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 6px 0 10px; font-size: 12px; }
    .stat { display: inline-flex; align-items: center; gap: 6px; }
    .dot { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
    .dot.done { background: var(--done); } .dot.partial { background: var(--partial); } .dot.missing { background: var(--missing); }
    .legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 8px 0 0; font-size: 11px; color: var(--muted); }
    .legend svg { vertical-align: middle; margin-right: 4px; }
    .canvas { overflow: auto; max-width: 100%; padding: 4px 0; }
    .empty { margin: 0; color: var(--muted); }
    ul.plain { margin: 6px 0 0; padding-left: 18px; }
    ul.plain li { margin: 2px 0; }
    .warn { color: var(--vscode-editorWarning-foreground, var(--partial)); }
    code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
    details { margin-top: 10px; }
    summary { cursor: pointer; color: var(--vscode-textLink-foreground); }
    summary:focus-visible { outline: 1px solid var(--accent); }
    /* SVG: colores del tema */
    svg.diagram { display: block; margin: 0 auto; overflow: visible; font-family: var(--vscode-font-family); }
    svg .node .box { fill: var(--vscode-editor-background); stroke: var(--line); stroke-width: 1.2; }
    svg .node .stripe { fill: var(--line); }
    svg .node.done .stripe { fill: var(--done); } svg .node.partial .stripe { fill: var(--partial); } svg .node.missing .stripe { fill: var(--missing); }
    svg .node.done .box { stroke: var(--done); } svg .node.partial .box { stroke: var(--partial); }
    svg .node.missing .box { stroke: var(--missing); stroke-dasharray: 5 4; }
    svg .node text { fill: var(--vscode-foreground); font-size: 11px; }
    svg .node .name { font-size: 13px; font-weight: 600; }
    svg .node .stereo, svg .node .folder { fill: var(--muted); font-size: 10px; font-style: italic; }
    svg .node .status { fill: var(--muted); font-size: 11px; }
    svg .node.done .status { fill: var(--done); } svg .node.partial .status { fill: var(--partial); } svg .node.missing .status { fill: var(--missing); }
    svg .node .member { fill: var(--vscode-foreground); font-family: var(--vscode-editor-font-family); font-size: 11px; }
    svg .node .member.more { fill: var(--muted); font-style: italic; }
    svg .node .sep { stroke: var(--line); }
    svg .node.openable { cursor: pointer; }
    svg .node.openable:hover .box, svg .node.openable:focus .box { stroke: var(--accent); stroke-width: 2; }
    svg .node:focus { outline: none; }
    svg .node.file.warn .box { stroke: var(--partial); }
    svg .node.file.active .box { stroke: var(--accent); stroke-width: 2.4; fill: var(--vscode-editor-selectionHighlightBackground, var(--vscode-editor-background)); }
    svg .node .warn-text { fill: var(--vscode-editorWarning-foreground, var(--partial)); font-size: 10px; font-weight: 600; }
    svg .edge line { stroke: var(--muted); stroke-width: 1.4; fill: none; }
    svg .edge.done line { stroke: var(--done); }
    svg .edge.todo line { stroke: var(--muted); opacity: .8; }
    svg .edge.dashed line { stroke-dasharray: 6 4; }
    svg .edge.hot line { stroke: var(--accent); stroke-width: 2; }
    svg .edge-label, svg .edge-mult { fill: var(--muted); font-size: 10px; }
    svg .mk path { stroke-width: 1.3; }
    svg .mk-done path { stroke: var(--done); } svg .mk-todo path, svg .mk-plain path { stroke: var(--muted); } svg .mk-hot path { stroke: var(--accent); }
    svg .mk .mk-hollow { fill: var(--vscode-editor-background); }
    svg .mk-done .mk-solid { fill: var(--done); } svg .mk-todo .mk-solid { fill: var(--muted); }
    svg .mk .mk-open { fill: none; }
    @media (forced-colors: active) { svg .node .box { stroke: CanvasText; } }
  </style>
</head>
<body>
  <header class="top">
    <h1>Diagrama del taller</h1>
    <span class="updated" id="updated"></span>
    <button class="refresh" id="refresh" type="button" title="Volver a leer el proyecto">Actualizar</button>
  </header>
  <main>
    <section aria-labelledby="t-target">
      <h2 id="t-target">Cómo debe quedar</h2>
      <div id="target"><p class="empty">Leyendo el proyecto…</p></div>
    </section>
    <section aria-labelledby="t-files">
      <h2 id="t-files">Dependencias de tu proyecto</h2>
      <div id="files"><p class="empty">Leyendo el proyecto…</p></div>
    </section>
  </main>
  <script nonce="${nonce}">
    (function () {
      var vscode = acquireVsCodeApi();
      function el(tag, attrs, children) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (key) {
          if (key === 'text') node.textContent = attrs[key];
          else if (attrs[key] !== null && attrs[key] !== undefined && attrs[key] !== false) node.setAttribute(key, attrs[key]);
        });
        (children || []).forEach(function (child) { if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child); });
        return node;
      }
      // El SVG lo arma la extension con todo el texto escapado: se parsea como SVG (no como HTML)
      // y se copia nodo por nodo, sin scripts ni atributos de eventos.
      function svgNode(markup) {
        if (!markup) return null;
        var doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
        var svg = doc.documentElement;
        if (!svg || svg.nodeName !== 'svg' || doc.getElementsByTagName('parsererror').length) return null;
        Array.prototype.forEach.call(svg.querySelectorAll('script, foreignObject'), function (node) { node.remove(); });
        Array.prototype.forEach.call(svg.querySelectorAll('*'), function (node) {
          Array.prototype.slice.call(node.attributes).forEach(function (attr) { if (/^on/i.test(attr.name) || /^(?:href|xlink:href)$/i.test(attr.name)) node.removeAttribute(attr.name); });
        });
        return document.importNode(svg, true);
      }
      function legendShape(kind) {
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('width', '28'); svg.setAttribute('height', '12'); svg.setAttribute('aria-hidden', 'true');
        var line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', '1'); line.setAttribute('y1', '6'); line.setAttribute('x2', kind === 'arrow' ? '26' : '18'); line.setAttribute('y2', '6');
        line.setAttribute('stroke', 'currentColor'); line.setAttribute('stroke-width', '1.3');
        if (kind === 'dashed') line.setAttribute('stroke-dasharray', '4 3');
        svg.appendChild(line);
        var path = document.createElementNS(ns, 'path');
        var shapes = { tri: 'M18 1 L27 6 L18 11 Z', fill: 'M14 6 L20 2 L27 6 L20 10 Z', dia: 'M14 6 L20 2 L27 6 L20 10 Z', arrow: 'M20 2 L26 6 L20 10', dashed: 'M18 1 L27 6 L18 11 Z' };
        path.setAttribute('d', shapes[kind]);
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('fill', kind === 'fill' ? 'currentColor' : 'none');
        svg.appendChild(path);
        return svg;
      }
      function legend() {
        return el('div', { class: 'legend' }, [
          el('span', {}, [el('span', { class: 'dot done' }), ' hecha']),
          el('span', {}, [el('span', { class: 'dot partial' }), ' a medias (le falta lo de la lista)']),
          el('span', {}, [el('span', { class: 'dot missing' }), ' falta']),
          el('span', {}, [legendShape('tri'), 'hereda de']),
          el('span', {}, [legendShape('fill'), 'se compone de']),
          el('span', {}, [legendShape('dia'), 'agrupa a']),
          el('span', {}, [legendShape('arrow'), 'usa a']),
          el('span', {}, ['Verde: la relación ya está en tu código. Clic en una clase: abre su archivo.']),
        ]);
      }
      function stat(kind, count, label) {
        return el('span', { class: 'stat' }, [el('span', { class: 'dot ' + kind }), count + ' ' + label]);
      }
      function renderTarget(message) {
        var box = document.getElementById('target');
        var target = message.target;
        if (!target) {
          box.replaceChildren(el('p', { class: 'empty', text: message.targetNote || 'Este taller no trae un diagrama de clases.' }));
          return;
        }
        var counts = target.counts;
        var svg = svgNode(target.svg);
        box.replaceChildren.apply(box, [
          el('p', { class: 'sub', text: (target.title ? target.title + ' · ' : '') + 'según ' + target.sourcePath + '. Es una guía: tu docente decide cómo se califica.' }),
          el('div', { class: 'stats' }, [
            stat('done', counts.done, counts.done === 1 ? 'hecha' : 'hechas'),
            stat('partial', counts.partial, 'a medias'),
            stat('missing', counts.missing, counts.missing === 1 ? 'falta' : 'faltan'),
            target.relationsTotal ? el('span', { class: 'stat', text: target.relationsDone + ' de ' + target.relationsTotal + ' relaciones en tu código' }) : null,
          ]),
          svg ? el('div', { class: 'canvas' }, [svg]) : el('p', { class: 'empty', text: 'No se pudo dibujar el diagrama.' }),
          legend(),
        ].filter(Boolean));
      }
      function renderFiles(message) {
        var box = document.getElementById('files');
        var files = message.files;
        var parts = [];
        var svg = svgNode(files.svg);
        if (svg) {
          parts.push(el('p', { class: 'sub', text: 'Cada flecha va del archivo que incluye o importa al que usa. El archivo que tienes abierto va resaltado; clic en uno para abrirlo.' }));
          parts.push(el('div', { class: 'canvas' }, [svg]));
          if (files.hidden) parts.push(el('p', { class: 'sub', text: 'Y ' + files.hidden + ' archivos más que no caben en el dibujo.' }));
        } else {
          parts.push(el('p', { class: 'empty', text: 'No se encontraron archivos de código en la carpeta abierta.' }));
        }
        if (files.missing.length) {
          parts.push(el('p', { class: 'warn', text: 'No encontrados:' }));
          parts.push(el('ul', { class: 'plain' }, files.missing.map(function (item) {
            return el('li', {}, [el('code', { text: item.label }), ' en ' + item.from + (item.hint ? ' · ' + item.hint : '')]);
          })));
        }
        if (files.libraries.length) {
          parts.push(el('details', {}, [
            el('summary', { text: 'Bibliotecas (' + files.libraries.length + ')' }),
            el('ul', { class: 'plain' }, files.libraries.map(function (item) {
              return el('li', {}, [el('code', { text: item.label }), (item.description ? ': ' + item.description : '') + ' · ' + item.count + (item.count === 1 ? ' archivo' : ' archivos')]);
            })),
          ]));
        }
        box.replaceChildren.apply(box, parts);
      }
      function render(message) {
        document.getElementById('updated').textContent = message.status === 'loading' ? 'Leyendo…' : message.updatedLabel ? 'Leído a las ' + message.updatedLabel : '';
        renderTarget(message);
        renderFiles(message);
        vscode.setState({ v: 1, message: message });
      }
      function openFrom(target) {
        var node = target && target.closest ? target.closest('[data-open]') : null;
        if (!node) return;
        vscode.postMessage({ type: 'open', path: node.getAttribute('data-open'), line: Number(node.getAttribute('data-line')) || 0 });
      }
      document.addEventListener('click', function (event) { openFrom(event.target); });
      document.addEventListener('keydown', function (event) {
        if ((event.key === 'Enter' || event.key === ' ') && event.target && event.target.getAttribute && event.target.getAttribute('data-open')) {
          event.preventDefault();
          openFrom(event.target);
        }
      });
      document.getElementById('refresh').addEventListener('click', function () {
        document.getElementById('updated').textContent = 'Leyendo…';
        vscode.postMessage({ type: 'refresh' });
      });
      window.addEventListener('message', function (event) {
        var data = event.data || {};
        if (data.type === 'state') render(data);
      });
      var saved = vscode.getState();
      if (saved && saved.v === 1 && saved.message) render(saved.message);
      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
  }
}
