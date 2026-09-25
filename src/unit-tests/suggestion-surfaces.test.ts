import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  codeLensOffersApply,
  inlineSurfaceModel,
  selectionWidgetCovers,
  SelectionWidgetPresence,
  selectionWidgetPresence,
  suggestionDismissed,
} from '../suggestion-surfaces';

const MAIN = 'file:///home/estudiante/repo/src/Main.java';
const OTRO = 'file:///home/estudiante/repo/src/Otro.java';
const CERRADA: SelectionWidgetPresence = { visible: false, uriString: '' };
const ABIERTA_EN_MAIN: SelectionWidgetPresence = { visible: true, uriString: MAIN };

describe('ventana flotante frente al CodeLens y la pista en linea', () => {
  it('la ventana cubre solo el documento donde esta abierta', () => {
    assert.equal(selectionWidgetCovers(ABIERTA_EN_MAIN, MAIN), true);
    assert.equal(selectionWidgetCovers(ABIERTA_EN_MAIN, OTRO), false);
    assert.equal(selectionWidgetCovers(CERRADA, MAIN), false);
    assert.equal(selectionWidgetCovers({ visible: true, uriString: '' }, ''), false);
  });

  it('con la ventana abierta no hay pista en linea ni decoracion; al cerrarla vuelven', () => {
    const model = { uriString: MAIN, applyMode: 'insert' };
    assert.equal(inlineSurfaceModel(model, ABIERTA_EN_MAIN), null);
    assert.equal(inlineSurfaceModel(model, CERRADA), model);
    assert.equal(inlineSurfaceModel(model, { visible: true, uriString: OTRO }), model);
    assert.equal(inlineSurfaceModel(null, CERRADA), null);
  });

  it('el CodeLens no repite «Aceptar ayuda» mientras la ventana esta abierta en ese archivo', () => {
    assert.equal(codeLensOffersApply({ applyOffered: true, documentUri: MAIN, widget: ABIERTA_EN_MAIN }), false);
    assert.equal(codeLensOffersApply({ applyOffered: true, documentUri: MAIN, widget: CERRADA }), true);
    assert.equal(codeLensOffersApply({ applyOffered: true, documentUri: OTRO, widget: ABIERTA_EN_MAIN }), true);
    // La politica manda: si no se puede aplicar, no hay CodeLens de aplicar en ningun caso.
    assert.equal(codeLensOffersApply({ applyOffered: false, documentUri: MAIN, widget: CERRADA }), false);
  });
});

describe('ventana flotante que no se ve o que el estudiante cerro', () => {
  it('con los comentarios ocultos (comments.visible=false) la ventana no cuenta como abierta', () => {
    const oculta = selectionWidgetPresence({ hasThread: true, uriString: MAIN, commentsVisible: false });
    assert.deepEqual(oculta, CERRADA);
    // Entonces el CodeLens y la pista siguen ofreciendo la accion.
    assert.equal(codeLensOffersApply({ applyOffered: true, documentUri: MAIN, widget: oculta }), true);
    assert.deepEqual(selectionWidgetPresence({ hasThread: true, uriString: MAIN, commentsVisible: true }), ABIERTA_EN_MAIN);
    assert.deepEqual(selectionWidgetPresence({ hasThread: false, uriString: '', commentsVisible: true }), CERRADA);
  });

  it('cerrada con la X: esa sugerencia no vuelve a ofrecerse en el CodeLens ni en la pista', () => {
    const model = { uriString: MAIN, metricId: 'm-1' };
    assert.equal(suggestionDismissed('m-1', 'm-1'), true);
    assert.equal(suggestionDismissed('m-1', ''), false);
    assert.equal(inlineSurfaceModel(model, CERRADA, 'm-1'), null);
    assert.equal(codeLensOffersApply({ applyOffered: true, documentUri: MAIN, widget: CERRADA, metricId: 'm-1', dismissedMetricId: 'm-1' }), false);
    // Llega otra sugerencia: vuelve a ofrecerse.
    const next = { uriString: MAIN, metricId: 'm-2' };
    assert.equal(inlineSurfaceModel(next, CERRADA, 'm-1'), next);
    assert.equal(codeLensOffersApply({ applyOffered: true, documentUri: MAIN, widget: CERRADA, metricId: 'm-2', dismissedMetricId: 'm-1' }), true);
    // Si la ventana solo se retiro (el estudiante movio la seleccion), no hay nada descartado.
    assert.equal(inlineSurfaceModel(model, CERRADA, ''), model);
  });
});
