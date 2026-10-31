import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseFileViewInboundMessage } from '../file-view-messages';

// Lo que manda el script de la vista «Este archivo» se revisa antes de usarlo (0.0.38).

describe('mensajes de la vista «Este archivo» (0.0.38)', () => {
  it('los mensajes sin datos', () => {
    for (const type of ['ready', 'loadMaterial', 'refreshSummary', 'openQuiz', 'openDiagram'] as const) {
      assert.deepEqual(parseFileViewInboundMessage({ type, extra: 'x' }), { type });
    }
  });

  it('abrir una fuente, el material o un elemento del cuadro «Dependencias», revisados', () => {
    assert.deepEqual(parseFileViewInboundMessage({ type: 'openSource', index: 2 }), { type: 'openSource', index: 2 });
    assert.equal(parseFileViewInboundMessage({ type: 'openSource', index: -1 }), null);
    assert.equal(parseFileViewInboundMessage({ type: 'openSource', index: 1.5 }), null);
    assert.deepEqual(parseFileViewInboundMessage({ type: 'openMaterial', id: 'abc' }), { type: 'openMaterial', id: 'abc' });
    assert.equal(parseFileViewInboundMessage({ type: 'openMaterial', id: '' }), null);
    assert.deepEqual(
      parseFileViewInboundMessage({ type: 'openDependency', group: 'missing', index: 0, key: 'k', id: 'figura.h\n' }),
      { type: 'openDependency', group: 'missing', index: 0, key: 'k', id: 'figura.h\n' },
    );
    assert.deepEqual(parseFileViewInboundMessage({ type: 'openDependency', group: 'local', index: 1 }), { type: 'openDependency', group: 'local', index: 1, key: '', id: '' });
    assert.equal(parseFileViewInboundMessage({ type: 'openDependency', group: 'otros', index: 0 }), null);
    assert.equal(parseFileViewInboundMessage({ type: 'openDependency', group: 'local', index: '0' }), null);
    assert.equal((parseFileViewInboundMessage({ type: 'openDependency', group: 'local', index: 0, id: 'x'.repeat(5000) }) as { id: string }).id.length, 2000);
  });

  it('lo que no es un mensaje conocido se ignora', () => {
    for (const bad of [null, 'ready', [], {}, { type: 'run', command: 'rm -rf' }, { type: 'applySuggestion' }]) {
      assert.equal(parseFileViewInboundMessage(bad), null, JSON.stringify(bad));
    }
  });
});
