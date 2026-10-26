import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { canOfferRecommendedAction, responseAllowsApply, suggestionPhase } from '../suggestion-phase';
import type { RecommendedActionInput } from '../suggestion-phase';
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

  it('la respuesta deja aplicar salvo bloqueada, sin modelo o pista local (aunque este cargando)', () => {
    assert.equal(responseAllowsApply({ source: 'backend' }), true);
    assert.equal(responseAllowsApply({ source: 'local' }), true);
    assert.equal(responseAllowsApply({ source: 'backend', loading: true }), true);
    assert.equal(responseAllowsApply({ source: 'backend', blocked: true }), false);
    assert.equal(responseAllowsApply({ source: 'backend', tutorUnavailable: true, loading: true }), false);
    assert.equal(responseAllowsApply({ source: 'local-fallback' }), false);
  });

  it('«Aceptar ayuda» (CodeLens, arreglo rapido, pista en linea, hover): lista, sin aplicar, permitida y con su codigo', () => {
    const ready: RecommendedActionInput = { source: 'backend', applyMode: 'insert', completionText: '}', completionMode: 'insert' };
    assert.equal(canOfferRecommendedAction(ready), true);
    const cases: Array<[string, Partial<RecommendedActionInput>]> = [
      ['cargando', { loading: true }],
      ['pidiendo codigo para otra accion', { pendingMode: 'replace' }],
      ['ya aplicada', { applied: true }],
      ['bloqueada', { blocked: true }],
      ['sin modelo', { tutorUnavailable: true }],
      ['pista local', { source: 'local-fallback' }],
      ['el docente no permite aplicar aqui', { codeApplication: { allowed: false } }],
      ['sin codigo', { completionText: '' }],
      ['codigo escrito para otra accion', { completionMode: 'replace' }],
    ];
    for (const [label, patch] of cases) {
      assert.equal(canOfferRecommendedAction({ ...ready, ...patch }), false, label);
    }
    // Eliminar no necesita codigo del tutor.
    assert.equal(canOfferRecommendedAction({ source: 'backend', applyMode: 'delete', completionText: '' }), true);
  });

  it('la ventana usa la misma regla: sin tutor no ofrece aplicar ni muestra botones', () => {
    assert.equal(selectionWidgetOffersApply(widget()), true);
    assert.equal(selectionWidgetShowsTitleActions(widget()), true);
    for (const patch of [{ tutorUnavailable: true }, { blocked: true }, { source: 'local-fallback' as const }, { codeApplicationAllowed: false }]) {
      assert.equal(selectionWidgetOffersApply(widget(patch)), false, JSON.stringify(patch));
      assert.equal(selectionWidgetShowsTitleActions(widget(patch)), false, JSON.stringify(patch));
    }
    // Cargando o pidiendo codigo: se puede aplicar despues, pero ahora no hay botones.
    assert.equal(selectionWidgetOffersApply(widget({ loading: true })), true);
    assert.equal(selectionWidgetShowsTitleActions(widget({ loading: true })), false);
    assert.equal(selectionWidgetShowsTitleActions(widget({ pendingMode: 'replace' })), false);
  });
});
