import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildDiagramPanelMessage, parseDiagramPanelInboundMessage } from '../diagram-panel-messages';

// «Ver diagrama» (0.0.38): lo que va y viene entre la extension y el panel.

describe('mensajes del panel «Ver diagrama» (0.0.38)', () => {
  it('solo acepta los tres mensajes del panel, revisados', () => {
    assert.deepEqual(parseDiagramPanelInboundMessage({ type: 'ready' }), { type: 'ready' });
    assert.deepEqual(parseDiagramPanelInboundMessage({ type: 'refresh', extra: 1 }), { type: 'refresh' });
    assert.deepEqual(parseDiagramPanelInboundMessage({ type: 'open', path: 'include/Banco.h', line: 4 }), { type: 'open', path: 'include/Banco.h', line: 4 });
    assert.deepEqual(parseDiagramPanelInboundMessage({ type: 'open', path: 'src/main.cpp', line: -3 }), { type: 'open', path: 'src/main.cpp', line: 0 });
    assert.deepEqual(parseDiagramPanelInboundMessage({ type: 'open', path: 'a.h', line: '4' }), { type: 'open', path: 'a.h', line: 0 });
    for (const bad of [null, 'ready', [], { type: 'open' }, { type: 'open', path: '' }, { type: 'open', path: 'x'.repeat(1001) }, { type: 'run', command: 'rm' }]) {
      assert.equal(parseDiagramPanelInboundMessage(bad), null, JSON.stringify(bad));
    }
  });

  it('sin diagrama: la nota y el grafo vacio, sin SVG', () => {
    const message = buildDiagramPanelMessage({
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
});
