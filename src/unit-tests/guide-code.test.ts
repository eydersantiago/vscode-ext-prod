import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  ELISION_EXPANDED_NOTE,
  ELISION_UNUSABLE_REASON,
  POLICY_CUT_NOTE,
  POLICY_CUT_REASON,
  UNBALANCED_REASON,
  extractSuggestionCode,
  isElisionLine,
  isPolicyCutLine,
  prepareSuggestionCode,
  resolveSuggestionModes,
  stripPolicyCutLines,
  suggestionCodeFields,
} from '../suggestion-code';
import { buildSelectionWidgetText, selectionWidgetActionLinks, selectionWidgetCode, selectionWidgetShowsTitleActions } from '../selection-widget-text';
import type { SelectionWidgetModel } from '../selection-widget-text';
import { buildFileViewState, EMPTY_MATERIAL_STATE, suggestionGuide } from '../file-view-model';
import type { ActiveSuggestionModel } from '../types';

// 0.0.38 (piloto del 30/10/2026): la ventana de la seleccion de `int main(){ ... }` solo mostro
// «El tutor resumió parte de tu bloque con «...»...» y «El codigo sugerido pasaba de 5 lineas y
// se recortó: usalo como guia.», sin ningun codigo. El backend corto el codigo a 5 lineas y le
// agrego «// ... recortado por la politica del docente: completa el resto tu»; la extension lo
// tomo por un resumen del modelo, no lo pudo completar y escondio el codigo.

const MAIN_SELECTION = [
  'int main(){',
  '    Banco banco;',
  '    Cliente ana("1", "Ana", "300");',
  '    banco.agregarCliente(ana);',
  '    Cuenta* c = banco.abrirCuenta("1", 1000);',
  '    c->retirarDinero(200);',
  '    cout << c->getSaldo() << endl;',
  '    return 0;',
  '}',
].join('\n');

/** Lo que mando el backend: 5 lineas y su marca de recorte (limitCodeBlocks). */
const CUT_ANSWER = [
  '1) Resumen:',
  '- Falta validar el retiro.',
  '',
  '```cpp',
  'int main(){',
  '    Banco banco;',
  '    Cliente ana("1", "Ana", "300");',
  '    banco.agregarCliente(ana);',
  '    Cuenta* c = banco.abrirCuenta("1", 1000);',
  '// ... recortado por la politica del docente: completa el resto tu',
  '```',
].join('\n');

const BACKEND_NOTE = 'El codigo sugerido pasaba de 5 lineas y se recortó: usalo como guia.';

function widget(patch: Partial<SelectionWidgetModel> = {}): SelectionWidgetModel {
  return {
    uriString: 'file:///repo/src/main.cpp',
    startLine: 10,
    endLine: 18,
    headline: 'Falta validar el retiro.',
    completionText: '',
    completionMode: '',
    language: 'cpp',
    recommendedMode: 'replace',
    source: 'backend',
    ragCourseCode: 'FPOO',
    loading: false,
    applied: false,
    ...patch,
  };
}

function prepareFromAnswer(answer: string, selection: string, requestedAction: 'insert' | 'replace' | '' = '') {
  const modes = resolveSuggestionModes({ focusText: answer, code: extractSuggestionCode(answer), requestedAction, selection });
  const prepared = prepareSuggestionCode(modes.completionText, { selection, mode: modes.completionMode, language: 'cpp' });
  return { modes, prepared, fields: suggestionCodeFields(prepared, modes) };
}

describe('marca de recorte del backend (0.0.38)', () => {
  it('se reconoce con y sin tildes, y no es un resumen del modelo', () => {
    assert.equal(isPolicyCutLine('// ... recortado por la politica del docente: completa el resto tu'), true);
    assert.equal(isPolicyCutLine('    // ... recortado por la política del docente: completa el resto tú'), true);
    assert.equal(isPolicyCutLine('# ... recortado por la politica del docente: completa el resto tu'), true);
    assert.equal(isPolicyCutLine('... recortado por el límite del docente'), true);
    assert.equal(isPolicyCutLine('// recortado por la politica del docente'), true);
    assert.equal(isPolicyCutLine('cout << "recortado por la politica del docente";'), false, 'una cadena no es la marca');
    assert.equal(isPolicyCutLine('// ...'), false);
    assert.equal(isElisionLine('// ... recortado por la politica del docente: completa el resto tu'), false);
    assert.equal(isElisionLine('// ...'), true, 'los resumenes del modelo se siguen reconociendo');
  });

  it('se quita del codigo y dice que se quito', () => {
    assert.deepEqual(stripPolicyCutLines('a();\n// ... recortado por la politica del docente: completa el resto tu'), { code: 'a();', cut: true });
    assert.deepEqual(stripPolicyCutLines('a();\nb();'), { code: 'a();\nb();', cut: false });
  });

  it('el caso del piloto: la version de main cortada se muestra como guia, sin aplicar', () => {
    const { modes, prepared, fields } = prepareFromAnswer(CUT_ANSWER, MAIN_SELECTION, 'replace');
    assert.equal(modes.completionMode, 'replace');
    assert.equal(prepared.policyCut, true);
    assert.equal(prepared.unusable, true);
    assert.equal(prepared.unusableReason, POLICY_CUT_REASON);
    assert.notEqual(prepared.unusableReason, ELISION_UNUSABLE_REASON, 'ya no dice que el tutor resumio con «...»');
    assert.doesNotMatch(prepared.code, /recortado/, 'la marca no se muestra');
    assert.match(prepared.code, /Cuenta\* c = banco\.abrirCuenta\("1", 1000\);/);
    assert.equal(fields.completionText, '', 'nada lo aplica');
    assert.equal(fields.completionMode, '');
    assert.equal(fields.guideCode, prepared.code, 'el codigo no se pierde');
    assert.equal(fields.guideReason, POLICY_CUT_REASON);

    const text = buildSelectionWidgetText(widget({
      guideCode: fields.guideCode,
      guideReason: fields.guideReason,
      codeApplicationAllowed: false,
      applicationNote: BACKEND_NOTE,
    }));
    assert.match(text, /Código de guía \(no se aplica con un clic\)/);
    assert.match(text, /```cpp\nint main\(\)\{\n {4}Banco banco;/);
    assert.match(text, /Tu docente limita cuántas líneas escribe el tutor/);
    assert.doesNotMatch(text, /resumió parte de tu bloque/);
    assert.doesNotMatch(text, /pasaba de 5 lineas/, 'el motivo no se repite con las palabras del backend');
    assert.doesNotMatch(text, /applySuggestionCompletion/, 'sin aplicar ni pedir codigo: el docente no deja');
    assert.doesNotMatch(text, /recortado por la politica/);
  });

  it('el caso del piloto con la politica permitiendo aplicar: guia y deja pedir otra version', () => {
    const { fields } = prepareFromAnswer(CUT_ANSWER, MAIN_SELECTION, 'replace');
    const model = widget({ guideCode: fields.guideCode, guideReason: fields.guideReason });
    assert.equal(selectionWidgetShowsTitleActions(model), true);
    const links = selectionWidgetActionLinks(model).map((link) => decodeURIComponent(link));
    assert.ok(!links.some((link) => link.includes('$(check)')), 'la guia no se aplica con un clic');
    assert.ok(links.some((link) => link.includes('Proponer una mejora')));
    const text = buildSelectionWidgetText(model);
    assert.match(text, /Código de guía/);
    assert.match(text, /Banco banco;/);
  });

  it('codigo para insertar cortado que cierra sus llaves: se puede insertar, con aviso', () => {
    const answer = 'Aplicar: insert\n```cpp\nif (cantidad <= 0) {\n    return false;\n}\n// ... recortado por la politica del docente: completa el resto tu\n```';
    const { prepared, fields } = prepareFromAnswer(answer, 'saldo -= cantidad;');
    assert.equal(prepared.unusable, false);
    assert.equal(prepared.policyCut, true);
    assert.deepEqual(prepared.notes, [POLICY_CUT_NOTE]);
    assert.equal(fields.completionMode, 'insert');
    assert.equal(fields.completionText, 'if (cantidad <= 0) {\n    return false;\n}');
    assert.equal(fields.guideCode, '');
  });

  it('codigo para insertar cortado a mitad de un bloque: solo guia', () => {
    const answer = 'Aplicar: insert\n```cpp\nif (cantidad <= 0) {\n    cout << "monto invalido";\n// ... recortado por la politica del docente: completa el resto tu\n```';
    const { prepared, fields } = prepareFromAnswer(answer, 'saldo -= cantidad;');
    assert.equal(prepared.unusable, true);
    assert.equal(prepared.unusableReason, POLICY_CUT_REASON);
    assert.equal(fields.completionText, '');
    assert.match(fields.guideCode, /monto invalido/);
  });

  it('un bloque que solo traia la marca no es codigo', () => {
    const prepared = prepareSuggestionCode('// ... recortado por la politica del docente: completa el resto tu', { mode: 'insert', language: 'cpp' });
    assert.equal(prepared.code, '');
    assert.equal(prepared.unusable, false);
  });
});

describe('codigo que no se puede aplicar: se muestra como guia (0.0.38)', () => {
  it('un resumen «...» real que no se puede completar sigue sin aplicarse, pero se ve', () => {
    const selection = 'double area() const {\n  return base * altura;\n}';
    const prepared = prepareSuggestionCode('void otra() {\n  // ...\n  imprimir();\n}', { selection, mode: 'replace', language: 'cpp' });
    assert.equal(prepared.unusable, true);
    assert.equal(prepared.unusableReason, ELISION_UNUSABLE_REASON);
    const fields = suggestionCodeFields(prepared, { completionMode: 'replace', completionText: 'x' });
    assert.equal(fields.guideCode, 'void otra() {\n  // ...\n  imprimir();\n}');
    const text = buildSelectionWidgetText(widget({ guideCode: fields.guideCode, guideReason: fields.guideReason }));
    assert.match(text, /imprimir\(\);/);
    assert.match(text, /Úsalo como guía/);
  });

  it('un resumen «...» que se puede completar se sigue completando y aplicando', () => {
    const selection = 'int x = 0;\nx = x + 1;\ncout << x;\nreturn x;';
    const prepared = prepareSuggestionCode('int x = 0;\nx = x + 1;\n// ...\nreturn x;', { selection, mode: 'replace', language: 'cpp' });
    assert.equal(prepared.unusable, false);
    assert.deepEqual(prepared.notes, [ELISION_EXPANDED_NOTE]);
    const fields = suggestionCodeFields(prepared, { completionMode: 'replace', completionText: '' });
    assert.equal(fields.completionText, 'int x = 0;\nx = x + 1;\ncout << x;\nreturn x;');
    assert.equal(fields.guideCode, '');
  });

  it('llaves sin cerrar: guia con su motivo', () => {
    const selection = 'void f() {\n  a();\n}';
    const prepared = prepareSuggestionCode('void f() {\n  a();\n  if (x) {\n', { selection, mode: 'replace', language: 'cpp' });
    assert.equal(prepared.unusableReason, UNBALANCED_REASON);
    const fields = suggestionCodeFields(prepared, { completionMode: 'replace', completionText: '' });
    assert.match(fields.guideCode, /if \(x\) \{/);
  });

  it('con el docente sin permitir aplicar, el codigo de la accion tambien se ve como guia', () => {
    const model = widget({ completionText: 'if (x) {\n  y();\n}', completionMode: 'insert', codeApplicationAllowed: false, applicationNote: 'Tu docente no permite aplicar código aquí.' });
    assert.deepEqual(selectionWidgetCode(model), { kind: 'guide', code: 'if (x) {\n  y();\n}' });
    const text = buildSelectionWidgetText(model);
    assert.match(text, /Código de guía/);
    assert.match(text, /Tu docente no permite aplicar código aquí/);
    assert.doesNotMatch(text, /Código para insertar debajo/);
  });

  it('sin codigo de guia, sigue el mensaje de siempre', () => {
    assert.deepEqual(selectionWidgetCode(widget()), { kind: 'none' });
    assert.match(buildSelectionWidgetText(widget()), /El tutor no escribió código para este bloque/);
  });
});

describe('vista «Este archivo»: el codigo de guia tambien se ve (0.0.38)', () => {
  function model(patch: Partial<ActiveSuggestionModel> = {}): ActiveSuggestionModel {
    return {
      uriString: 'file:///repo/src/main.cpp', filePath: 'src/main.cpp', fileName: 'main.cpp', language: 'cpp',
      repoFullName: '', title: '', summary: '', fileOverview: '', lineSummary: 'Falta validar el retiro.',
      suggestions: [], fileSuggestions: [], lineSuggestions: [], nextSteps: [], chips: [], source: 'backend',
      backendError: '', ragSources: [], ragCourseCode: '', updatedAt: '', line: 10, column: 1,
      selectionLineCount: 9, selectionOriginalLineCount: 9, selectionTruncated: false, selectionRangeKey: '10-18',
      fileSummaryCacheKey: 'k', metricId: 'm', completionText: '', completionMode: '', applyMode: 'replace', triggerKind: 'cursor',
      ...patch,
    } as ActiveSuggestionModel;
  }

  it('lleva el codigo y el motivo junto a la sugerencia de ahora', () => {
    const state = buildFileViewState(model({ guideCode: 'int main(){\n    Banco banco;', guideReason: POLICY_CUT_REASON }), null, false, EMPTY_MATERIAL_STATE);
    assert.deepEqual(state.suggestion?.guide, { code: 'int main(){\n    Banco banco;', reason: POLICY_CUT_REASON, language: 'cpp' });
  });

  it('con el docente sin permitir aplicar, el codigo de la accion va como guia con su motivo', () => {
    const guide = suggestionGuide(model({
      completionText: 'x++;', completionMode: 'insert',
      codeApplication: { allowed: false, maxLines: 5, remaining: null, requireConfirmation: false, countsAsHint: false, reason: BACKEND_NOTE },
    }));
    assert.deepEqual(guide, { code: 'x++;', reason: BACKEND_NOTE, language: 'cpp' });
  });

  it('sin guia, aplicada o cargando: nada', () => {
    assert.equal(suggestionGuide(model({ completionText: 'x++;', completionMode: 'insert' })), null, 'se aplica desde la ventana');
    assert.equal(suggestionGuide(model({ guideCode: 'x++;', applied: true })), null);
    assert.equal(suggestionGuide(model({ guideCode: 'x++;', loading: true })), null);
  });
});
