import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  CODE_APPLICATION_REASON_CODES,
  codeApplicationNote,
  normalizeCodeCutSummary,
  normalizeCodeTruncation,
  normalizeSuggestionCodeApplication,
  POLICY_BLOCKED_REASON,
  policyTruncation,
} from '../code-application';

// code_application de /suggest-tab (contrato del 30/10/2026, 0.0.38).

describe('code_application de /suggest-tab (0.0.38)', () => {
  it('lee el contrato completo', () => {
    assert.deepEqual(normalizeSuggestionCodeApplication({
      allowed: false, maxLines: 5, remaining: 2, requireConfirmation: true, countsAsHint: true,
      reason: 'El codigo sugerido pasaba de 5 lineas.', reasonCode: 'code_application_too_large',
      truncation: 'guide', cut: { kind: 'prefix', linesShown: 5, linesTotal: 12, endsCleanly: false },
    }), {
      allowed: false, maxLines: 5, remaining: 2, requireConfirmation: true, countsAsHint: true,
      reason: 'El codigo sugerido pasaba de 5 lineas.', reasonCode: 'code_application_too_large',
      truncation: 'guide', cut: { kind: 'prefix', linesShown: 5, linesTotal: 12, endsCleanly: false },
    });
  });

  it('sin allowed se puede aplicar; sin el objeto, null', () => {
    assert.equal(normalizeSuggestionCodeApplication({})?.allowed, true);
    assert.equal(normalizeSuggestionCodeApplication({ allowed: false })?.allowed, false);
    assert.equal(normalizeSuggestionCodeApplication(null), null);
    assert.equal(normalizeSuggestionCodeApplication([]), null);
  });

  it('truncation desconocido o sin el campo (backend desplegado): no se sabe (null)', () => {
    assert.equal(normalizeSuggestionCodeApplication({ truncation: 'cortado' })?.truncation, null);
    assert.equal(normalizeSuggestionCodeApplication({})?.truncation, null);
    assert.equal(normalizeSuggestionCodeApplication({ truncation: '' })?.truncation, null);
    for (const value of ['none', 'applicable', 'guide'] as const) {
      assert.equal(normalizeCodeTruncation(value), value);
    }
  });

  it('cut: los dos tipos; sin el campo, null o invalido, null', () => {
    assert.deepEqual(normalizeCodeCutSummary({ kind: 'partial', changesShown: 2.9, changesTotal: 6 }), { kind: 'partial', changesShown: 2, changesTotal: 6 });
    assert.deepEqual(normalizeCodeCutSummary({ kind: 'prefix', linesShown: 3, linesTotal: 8 }), { kind: 'prefix', linesShown: 3, linesTotal: 8, endsCleanly: false });
    for (const bad of [undefined, null, 'prefix', { kind: 'prefix', linesShown: 'x', linesTotal: 8 }, { kind: 'partial', changesShown: 1 }, { kind: 'otro', linesShown: 1, linesTotal: 2 }, { shown: 5, total: 12 }]) {
      assert.equal(normalizeCodeCutSummary(bad), null, JSON.stringify(bad));
    }
    assert.equal(normalizeSuggestionCodeApplication({})?.cut, null, 'el backend desplegado no lo manda');
    assert.equal(normalizeSuggestionCodeApplication({ cut: { kind: 'prefix' } })?.cut, null);
  });

  it('reasonCode y reason con tope; numeros invalidos, null', () => {
    const value = normalizeSuggestionCodeApplication({ reasonCode: `  ${'x'.repeat(200)}  `, reason: 'r'.repeat(900), maxLines: 'mucho', remaining: -3 });
    assert.equal(value?.reasonCode.length, 80);
    assert.equal(value?.reason.length, 600);
    assert.equal(value?.maxLines, null);
    assert.equal(value?.remaining, 0);
  });

  it('policyTruncation: lo que dice el backend; sin truncation, tooLarge tambien es guia', () => {
    const base = normalizeSuggestionCodeApplication({})!;
    assert.equal(policyTruncation({ ...base, truncation: 'guide' }), 'guide');
    assert.equal(policyTruncation({ ...base, truncation: 'applicable' }), 'applicable');
    assert.equal(policyTruncation({ ...base, truncation: 'none', reasonCode: CODE_APPLICATION_REASON_CODES.tooLarge }), 'none', 'el backend nuevo manda');
    assert.equal(policyTruncation({ ...base, truncation: null, reasonCode: CODE_APPLICATION_REASON_CODES.tooLarge }), 'guide');
    assert.equal(policyTruncation({ ...base, truncation: null }), null);
    assert.equal(policyTruncation(null), null);
  });

  it('la nota de la politica: el motivo (o el texto de siempre) o cuantas aplicaciones quedan', () => {
    const base = normalizeSuggestionCodeApplication({})!;
    assert.equal(codeApplicationNote({ codeApplication: { ...base, allowed: false } }), POLICY_BLOCKED_REASON);
    assert.equal(codeApplicationNote({ codeApplication: { ...base, allowed: false, reason: 'Desactivada.' } }), 'Desactivada.');
    assert.equal(codeApplicationNote({ codeApplication: { ...base, remaining: 1 } }), 'Te queda 1 aplicación en este archivo.');
    assert.equal(codeApplicationNote({ codeApplication: { ...base, remaining: 3 } }), 'Te quedan 3 aplicaciones en este archivo.');
    assert.equal(codeApplicationNote({ codeApplication: base }), '');
    assert.equal(codeApplicationNote({ blocked: true, codeApplication: { ...base, allowed: false } }), '', 'bloqueada: el mensaje del tutor ya lo dice');
  });

  it('los reasonCode del backend y de la extension estan en un solo sitio', () => {
    assert.equal(CODE_APPLICATION_REASON_CODES.incompleteReply, 'code_application_incomplete_reply');
    assert.equal(CODE_APPLICATION_REASON_CODES.pilotNoTutor, 'pilot_no_tutor');
    assert.equal(CODE_APPLICATION_REASON_CODES.ok, 'ok');
    assert.equal(CODE_APPLICATION_REASON_CODES.offlineTooLarge, 'offline_too_large');
  });
});
