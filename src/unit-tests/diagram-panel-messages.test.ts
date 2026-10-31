import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildDiagramPanelStateMessage, parseDiagramPanelInboundMessage } from '../diagram-panel-messages';
import { RELATION_STYLE, renderRelationLegendSvg } from '../diagram-svg';

// «Ver diagrama» (0.0.38): lo que va y viene entre la extension y el panel.

describe('mensajes del panel «Ver diagrama» (0.0.38)', () => {
  it('solo acepta los tres mensajes del panel, revisados', () => {
    assert.deepEqual(parseDiagramPanelInboundMessage({ type: 'ready' }), { type: 'ready' });
    assert.deepEqual(parseDiagramPanelInboundMessage({ type: 'refresh', extra: 1 }), { type: 'refresh' });
    assert.deepEqual(parseDiagramPanelInboundMessage({ type: 'open', path: 'include/Banco.h', line: 4 }), { type: 'open', path: 'include/Banco.h', line: 4 });
    assert.deepEqual(parseDiagramPanelInboundMessage({ type: 'open', path: 'src/main.cpp', line: -3 }), { type: 'open', path: 'src/main.cpp', line: null });
    assert.deepEqual(parseDiagramPanelInboundMessage({ type: 'open', path: 'a.h', line: '4' }), { type: 'open', path: 'a.h', line: null });
    for (const bad of [null, 'ready', [], { type: 'open' }, { type: 'open', path: '' }, { type: 'open', path: 'x'.repeat(1001) }, { type: 'run', command: 'rm' }]) {
      assert.equal(parseDiagramPanelInboundMessage(bad), null, JSON.stringify(bad));
    }
  });

  it('sin diagrama: la nota y el grafo vacio, sin SVG', () => {
    const message = buildDiagramPanelStateMessage({
      status: 'ready',
      target: null,
      targetNote: 'Este taller no trae un diagrama de clases.',
      dependencies: { nodes: [], edges: [], libraries: [], missing: [], hidden: 0 },
      updatedLabel: '10:00',
    });
    assert.equal(message.type, 'state');
    assert.equal(message.target, null);
    assert.equal(message.targetNote, 'Este taller no trae un diagrama de clases.');
    assert.equal(message.files.svg, '');
  });

  it('la leyenda trae todas las relaciones con el mismo trazo que el diagrama (implementa y depende de punteadas)', () => {
    const legend = renderRelationLegendSvg();
    for (const style of Object.values(RELATION_STYLE)) {
      assert.match(legend, new RegExp(`>${style.label}<`));
    }
    assert.match(legend, /data-kind="realization"><line[^>]*marker-end="url\(#lg-tri-todo\)"/);
    assert.match(legend, /class="edge todo dashed" data-kind="realization"/);
    assert.match(legend, /class="edge todo dashed" data-kind="dependency"/);
    assert.match(legend, /class="edge todo" data-kind="composition"><line[^>]*marker-end="url\(#lg-dia-fill-todo\)"/);
    assert.match(legend, /data-kind="link"><line x1="4" y1="\d+" x2="44" y2="\d+"\/>/, 'sin marca');
    const message = buildDiagramPanelStateMessage({
      status: 'ready',
      target: { sourcePath: 'docs/diagrama-clases.puml', title: '', classes: [{ name: 'A', kind: 'class', status: 'done', path: 'a.h', line: 1, missingMembers: [], present: 0, total: 0 }], relations: [], counts: { classes: 1, done: 1, partial: 0, missing: 0 } },
      targetNote: '',
      dependencies: { nodes: [], edges: [], libraries: [], missing: [], hidden: 0 },
      updatedLabel: '',
    });
    assert.equal(message.target?.legendSvg, legend);
  });
});
