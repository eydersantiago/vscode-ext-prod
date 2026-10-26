import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { suggestionPhase, suggestionRulesOutApply } from '../suggestion-phase';
import { selectionWidgetOffersApply, selectionWidgetShowsTitleActions } from '../selection-widget-text';
import type { SelectionWidgetModel } from '../selection-widget-text';

function widget(patch: Partial<SelectionWidgetModel> = {}): SelectionWidgetModel {
  return {
    uriString: 'file:///repo/src/main.cpp',
    startLine: 3,
    endLine: 3,
    headline: 'Falta cerrar la llave.',
    completionText: '}',
    completionMode: 'insert',
    language: 'cpp',
    recommendedMode: 'insert',
    source: 'backend',
    ragCourseCode: '',
    loading: false,
    applied: false,
    ...patch,
  };
}

describe('fase de la sugerencia (0.0.37)', () => {
  it('una sola fase, en orden: cargando, pidiendo codigo, bloqueada, sin tutor, pista local, lista', () => {
    assert.equal(suggestionPhase({ source: 'backend', loading: true, blocked: true }), 'loading');
    assert.equal(suggestionPhase({ source: 'backend', pendingMode: 'replace', tutorUnavailable: true }), 'pending');
    assert.equal(suggestionPhase({ source: 'backend', pendingMode: 'insert' }), 'pending');
    assert.equal(suggestionPhase({ source: 'backend', pendingMode: 'delete' }), 'ready', 'eliminar no espera codigo del tutor');
    assert.equal(suggestionPhase({ source: 'backend', blocked: true, tutorUnavailable: true }), 'blocked');
    assert.equal(suggestionPhase({ source: 'backend', tutorUnavailable: true }), 'tutor_unavailable');
    assert.equal(suggestionPhase({ source: 'local-fallback' }), 'local_fallback');
    assert.equal(suggestionPhase({ source: 'local' }), 'ready');
    assert.equal(suggestionPhase({ source: 'backend', pendingMode: '' }), 'ready');
  });

  it('bloqueada, sin modelo o pista local descartan aplicar aunque esten cargando', () => {
    assert.equal(suggestionRulesOutApply({ source: 'backend' }), false);
    assert.equal(suggestionRulesOutApply({ source: 'local' }), false);
    assert.equal(suggestionRulesOutApply({ source: 'backend', blocked: true }), true);
    assert.equal(suggestionRulesOutApply({ source: 'backend', tutorUnavailable: true, loading: true }), true);
    assert.equal(suggestionRulesOutApply({ source: 'local-fallback' }), true);
  });

  it('la ventana usa la misma regla: sin tutor no ofrece aplicar ni muestra botones', () => {
    assert.equal(selectionWidgetOffersApply(widget()), true);
    assert.equal(selectionWidgetShowsTitleActions(widget()), true);
    for (const patch of [{ tutorUnavailable: true }, { blocked: true }, { source: 'local-fallback' as const }, { applyAllowed: false }]) {
      assert.equal(selectionWidgetOffersApply(widget(patch)), false, JSON.stringify(patch));
      assert.equal(selectionWidgetShowsTitleActions(widget(patch)), false, JSON.stringify(patch));
    }
    // Cargando o pidiendo codigo: se puede aplicar despues, pero ahora no hay botones.
    assert.equal(selectionWidgetOffersApply(widget({ loading: true })), true);
    assert.equal(selectionWidgetShowsTitleActions(widget({ loading: true })), false);
    assert.equal(selectionWidgetShowsTitleActions(widget({ pendingMode: 'replace' })), false);
  });
});
