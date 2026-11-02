import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CODE_APPLICATION_REASON_CODES, normalizeSuggestionCodeApplication, POLICY_BLOCKED_REASON } from '../code-application';
import type { CodeCutPolicy, SuggestionCodeApplication } from '../code-application';
import {
  ELISION_EXPANDED_NOTE,
  ELISION_GUIDE_REASON,
  INCOMPLETE_REPLY_REASON,
  POLICY_CUT_NOTE,
  POLICY_CUT_REASON,
  UNBALANCED_REASON,
  codeCutNote,
  extractSuggestionCode,
  isElisionLine,
  isPolicyCutLine,
  policyCutReason,
  prepareSuggestionCode,
  resolveSuggestionModes,
  stripPolicyCutLines,
  toSuggestionCodeFields,
} from '../suggestion-code';
import { GUIDE_CODE_LABEL } from '../suggestion-guide';
import type { SuggestionGuide } from '../suggestion-guide';
import { resolveDisplayedCode } from '../suggestion-phase';
import { buildSelectionWidgetText, selectionWidgetActionLinks, selectionWidgetCode, selectionWidgetShowsTitleActions } from '../selection-widget-text';
import type { SelectionWidgetModel } from '../selection-widget-text';
import { toSelectionWidgetModel } from '../selection-widget-model';
import { buildFileViewState, EMPTY_MATERIAL_STATE, suggestionGuide } from '../file-view-model';
import type { ActiveSuggestionModel } from '../types';

// 0.0.38 (piloto del 30/10/2026): la ventana de la seleccion de `int main(){ ... }` solo mostro
// «El tutor resumió parte de tu bloque con «...»...» y «El codigo sugerido pasaba de 5 lineas y
// se recortó: usalo como guia.», sin ningun codigo. El backend corto el codigo a 5 lineas y le
// agrego «// ... recortado por la politica del docente: completa el resto tu»; la extension lo
// tomo por un resumen del modelo, no lo pudo completar y escondio el codigo. El backend nuevo
// dice el recorte en code_application (truncation, cut) y ya no escribe la marca en el codigo.

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

const CUT_LINES = [
  'int main(){',
  '    Banco banco;',
  '    Cliente ana("1", "Ana", "300");',
  '    banco.agregarCliente(ana);',
  '    Cuenta* c = banco.abrirCuenta("1", 1000);',
];

/** Lo que mandaba el backend desplegado: 5 lineas y su marca de recorte (limitCodeBlocks). */
const LEGACY_CUT_ANSWER = ['1) Resumen:', '- Falta validar el retiro.', '', '```cpp', ...CUT_LINES, '// ... recortado por la politica del docente: completa el resto tu', '```'].join('\n');

/** Lo mismo con el backend nuevo: sin marca en el codigo (truncation y cut van en code_application). */
const NEW_CUT_ANSWER = ['1) Resumen:', '- Falta validar el retiro.', '', '```cpp', ...CUT_LINES, '```', '', '_El tutor muestra 5 de 12 lineas: el resto lo escribes tu._'].join('\n');

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

/** code_application como lo deja normalizeSuggestionCodeApplication (con lo que falte, el contrato). */
function policy(patch: Record<string, unknown> = {}): SuggestionCodeApplication {
  return normalizeSuggestionCodeApplication({
    allowed: true, maxLines: 5, remaining: null, requireConfirmation: false, countsAsHint: false,
    reason: '', reasonCode: 'ok', truncation: 'none', cut: null, ...patch,
  }) as SuggestionCodeApplication;
}

function prepareFromAnswer(answer: string, selection: string, requestedAction: 'insert' | 'replace' | '' = '', cutPolicy: CodeCutPolicy | null = null) {
  const modes = resolveSuggestionModes({ focusText: answer, code: extractSuggestionCode(answer), requestedAction, selection });
  const prepared = prepareSuggestionCode(modes.completionText, { selection, mode: modes.completionMode, language: 'cpp', policy: cutPolicy });
  return { modes, prepared, fields: toSuggestionCodeFields(prepared, modes.completionMode) };
}

describe('recorte del docente con code_application (0.0.38)', () => {
  it('el caso del piloto con el backend nuevo: guia con cuantas lineas se muestran', () => {
    const cut = policy({ allowed: false, reasonCode: 'code_application_too_large', truncation: 'guide', cut: { kind: 'prefix', linesShown: 5, linesTotal: 12, endsCleanly: false } });
    const { prepared, fields } = prepareFromAnswer(NEW_CUT_ANSWER, MAIN_SELECTION, 'replace', cut);
    assert.equal(prepared.guideOnly?.cause, 'policy_cut');
    assert.match(prepared.guideOnly?.reason || '', /^El tutor muestra 5 de 12 líneas: tu docente limita cuántas escribe/);
    assert.equal(fields.completionText, '', 'nada lo aplica');
    assert.equal(fields.guide?.code, CUT_LINES.join('\n'));
  });

  it('respuesta cortada a mitad del bloque: guia con su propio texto, nunca como limite del docente', () => {
    const cut = policy({ allowed: false, reasonCode: CODE_APPLICATION_REASON_CODES.incompleteReply, truncation: 'guide', cut: { kind: 'prefix', linesShown: 4, linesTotal: 4, endsCleanly: true } });
    const { prepared } = prepareFromAnswer(NEW_CUT_ANSWER, MAIN_SELECTION, 'replace', cut);
    assert.deepEqual(prepared.guideOnly, { cause: 'incomplete_reply', reason: INCOMPLETE_REPLY_REASON });
    assert.doesNotMatch(INCOMPLETE_REPLY_REASON, /docente/);
    const shown = resolveDisplayedCode({ source: 'backend', guide: { code: 'x++;', ...prepared.guideOnly! }, codeApplication: cut });
    assert.equal(shown.kind === 'guide' && shown.cause, 'incomplete_reply', 'el motivo de la politica no lo tapa');
    const text = buildSelectionWidgetText(widget({ guide: { code: 'x++;', ...prepared.guideOnly! }, codeApplication: { ...cut, reason: 'La respuesta del tutor llego cortada.' }, applicationNote: 'La respuesta del tutor llego cortada.' }));
    assert.match(text, /La respuesta del tutor llegó cortada: úsala como guía/);
    assert.doesNotMatch(text, /llego cortada\./, 'la nota del backend no se repite');
  });

  it('applicable: se aplica, con el aviso segun cut.kind (prefix o partial)', () => {
    const answer = 'Aplicar: insert\n```cpp\nif (cantidad <= 0) {\n    return false;\n}\n```';
    const prefix = prepareFromAnswer(answer, 'saldo -= cantidad;', '', policy({ truncation: 'applicable', cut: { kind: 'prefix', linesShown: 3, linesTotal: 8, endsCleanly: true } }));
    assert.equal(prefix.prepared.guideOnly, null);
    assert.deepEqual(prefix.prepared.notes, ['El tutor muestra 3 de 8 líneas: revisa qué falta y complétalo tú.']);
    assert.equal(prefix.fields.completionMode, 'insert');

    const replace = 'Aplicar: replace\n```cpp\nint main(){\n    Banco banco;\n    if (monto > 0) banco.depositar(monto);\n}\n```';
    const partial = prepareFromAnswer(replace, 'int main(){\n    Banco banco;\n    banco.depositar(monto);\n}', 'replace', policy({ truncation: 'applicable', cut: { kind: 'partial', changesShown: 1, changesTotal: 3 } }));
    assert.equal(partial.prepared.guideOnly, null);
    assert.deepEqual(partial.prepared.notes, ['Se aplican 1 de 3 cambios; el resto de tus líneas queda igual.']);
    assert.equal(partial.fields.completionMode, 'replace');
    assert.equal(codeCutNote(null), POLICY_CUT_NOTE);
  });

  it('el motivo de la guia sigue el tipo de recorte', () => {
    assert.match(policyCutReason({ kind: 'prefix', linesShown: 5, linesTotal: 12, endsCleanly: false }), /^El tutor muestra 5 de 12 líneas/);
    assert.match(policyCutReason({ kind: 'partial', changesShown: 2, changesTotal: 6 }), /^El tutor propone 2 de 6 cambios/);
    assert.equal(policyCutReason(null), POLICY_CUT_REASON);
  });

  it('truncation none: el codigo se aplica como siempre aunque traiga lineas parecidas a la marca', () => {
    const { prepared } = prepareFromAnswer('Aplicar: insert\n```cpp\nx++;\n```', 'y++;', '', policy());
    assert.equal(prepared.guideOnly, null);
    assert.deepEqual(prepared.notes, []);
  });
});

describe('marca de recorte del backend desplegado (compatibilidad hasta la 0.0.40)', () => {
  it('se reconoce con y sin tildes, y no es un resumen del modelo', () => {
    assert.equal(isPolicyCutLine('// ... recortado por la politica del docente: completa el resto tu'), true);
    assert.equal(isPolicyCutLine('    // ... recortado por la política del docente: completa el resto tú'), true);
    assert.equal(isPolicyCutLine('# ... recortado por la politica del docente: completa el resto tu'), true);
    assert.equal(isPolicyCutLine('cout << "recortado por la politica del docente";'), false, 'una cadena no es la marca');
    assert.equal(isPolicyCutLine('// ...'), false);
    assert.equal(isElisionLine('// ... recortado por la politica del docente: completa el resto tu'), false);
    assert.equal(isElisionLine('// ...'), true, 'los resumenes del modelo se siguen reconociendo');
    assert.deepEqual(stripPolicyCutLines('a();\n// ... recortado por la politica del docente: completa el resto tu'), { code: 'a();', cut: true });
  });

  it('el caso exacto del piloto (respuesta en la cache del backend desplegado): guia sin aplicar', () => {
    const legacy = normalizeSuggestionCodeApplication({ allowed: false, maxLines: 5, reason: BACKEND_NOTE });
    assert.equal(legacy?.truncation, null, 'sin truncation: no se sabe');
    const { modes, prepared, fields } = prepareFromAnswer(LEGACY_CUT_ANSWER, MAIN_SELECTION, 'replace', legacy);
    assert.equal(modes.completionMode, 'replace');
    assert.deepEqual(prepared.guideOnly, { cause: 'policy_cut', reason: POLICY_CUT_REASON });
    assert.doesNotMatch(prepared.code, /recortado/, 'la marca no se muestra');
    assert.equal(fields.completionText, '');
    assert.equal(fields.guide?.code, CUT_LINES.join('\n'), 'el codigo no se pierde');

    const text = buildSelectionWidgetText(widget({ guide: fields.guide, codeApplication: legacy, applicationNote: BACKEND_NOTE }));
    assert.match(text, /Código de guía \(no se aplica con un clic\)/);
    assert.match(text, /```cpp\nint main\(\)\{\n {4}Banco banco;/);
    assert.match(text, /Tu docente limita cuántas líneas escribe el tutor/);
    assert.doesNotMatch(text, /resumió parte de tu bloque/);
    assert.doesNotMatch(text, /pasaba de 5 lineas/, 'la causa policy_cut ya lo explica: la nota del backend no se repite');
    assert.doesNotMatch(text, /applySuggestionCompletion/);
    assert.doesNotMatch(text, /recortado por la politica/);
  });

  it('sin truncation pero con reasonCode tooLarge: guia tambien para insertar', () => {
    const answer = 'Aplicar: insert\n```cpp\nif (cantidad <= 0) {\n    return false;\n}\n// ... recortado por la politica del docente: completa el resto tu\n```';
    const { prepared } = prepareFromAnswer(answer, 'saldo -= cantidad;', '', normalizeSuggestionCodeApplication({ allowed: false, reasonCode: 'code_application_too_large' }));
    assert.equal(prepared.guideOnly?.cause, 'policy_cut');
  });

  it('sin ninguna señal: un codigo para insertar que cierra sus llaves se inserta; cortado a medias, guia', () => {
    const closed = prepareFromAnswer('Aplicar: insert\n```cpp\nif (cantidad <= 0) {\n    return false;\n}\n// ... recortado por la politica del docente: completa el resto tu\n```', 'saldo -= cantidad;');
    assert.equal(closed.prepared.guideOnly, null);
    assert.deepEqual(closed.prepared.notes, [POLICY_CUT_NOTE]);
    assert.equal(closed.fields.completionText, 'if (cantidad <= 0) {\n    return false;\n}');
    const open = prepareFromAnswer('Aplicar: insert\n```cpp\nif (cantidad <= 0) {\n    cout << "monto invalido";\n// ... recortado por la politica del docente: completa el resto tu\n```', 'saldo -= cantidad;');
    assert.deepEqual(open.prepared.guideOnly, { cause: 'policy_cut', reason: POLICY_CUT_REASON });
    const empty = prepareSuggestionCode('// ... recortado por la politica del docente: completa el resto tu', { mode: 'insert', language: 'cpp' });
    assert.equal(empty.code, '');
    assert.equal(empty.guideOnly, null);
  });
});

describe('que codigo se ve: una sola regla (0.0.38)', () => {
  const GUIDE: SuggestionGuide = { code: 'int main(){\n    Banco banco;', reason: POLICY_CUT_REASON, cause: 'policy_cut' };
  const disabled = { allowed: false, reason: 'Tu docente desactivó la aplicación de código.', reasonCode: CODE_APPLICATION_REASON_CODES.disabled };

  it('aplicar, guia de la politica, guia preparada o nada', () => {
    const base = { source: 'backend' as const };
    assert.deepEqual(resolveDisplayedCode({ ...base, completionText: 'x++;\n', completionMode: 'insert' }), { kind: 'apply', code: 'x++;', mode: 'insert' });
    assert.deepEqual(resolveDisplayedCode({ ...base, completionText: 'x++;', applyMode: 'insert' }), { kind: 'apply', code: 'x++;', mode: 'insert' }, 'sin completionMode (historial): producedMode');
    assert.deepEqual(
      resolveDisplayedCode({ ...base, completionText: 'x++;', completionMode: 'insert', codeApplication: { allowed: false, reason: '' } }),
      { kind: 'guide', code: 'x++;', reason: POLICY_BLOCKED_REASON, cause: 'policy_blocked' },
    );
    assert.deepEqual(resolveDisplayedCode({ ...base, guide: GUIDE }), { kind: 'guide', ...GUIDE });
    assert.deepEqual(resolveDisplayedCode({ ...base }), { kind: 'none' });
    assert.deepEqual(resolveDisplayedCode({ ...base, guide: GUIDE, applied: true }), { kind: 'none' });
    assert.deepEqual(resolveDisplayedCode({ ...base, guide: GUIDE, loading: true }), { kind: 'none' });
    assert.deepEqual(resolveDisplayedCode({ ...base, guide: GUIDE, blocked: true }), { kind: 'none' }, 'bloqueada: solo el mensaje del tutor');
  });

  it('un recorte con la aplicacion ya negada por otra razon dice esa razon (policy_blocked)', () => {
    assert.deepEqual(resolveDisplayedCode({ source: 'backend', guide: GUIDE, codeApplication: disabled }), { kind: 'guide', code: GUIDE.code, reason: disabled.reason, cause: 'policy_blocked' });
    const tooLarge = { allowed: false, reason: BACKEND_NOTE, reasonCode: CODE_APPLICATION_REASON_CODES.tooLarge };
    assert.deepEqual(resolveDisplayedCode({ source: 'backend', guide: GUIDE, codeApplication: tooLarge }), { kind: 'guide', ...GUIDE }, 'el tope de lineas ya esta dicho');
    const elision: SuggestionGuide = { code: 'f();', reason: ELISION_GUIDE_REASON, cause: 'elision' };
    assert.deepEqual(resolveDisplayedCode({ source: 'backend', guide: elision, codeApplication: disabled }), { kind: 'guide', ...elision }, 'el resumen «...» es otra causa');
  });

  it('la ventana: guia con su motivo y, si la politica deja, pedir otra version', () => {
    const model = widget({ guide: GUIDE });
    assert.deepEqual(selectionWidgetCode(model), { kind: 'guide', ...GUIDE });
    assert.equal(selectionWidgetShowsTitleActions(model), true);
    const links = selectionWidgetActionLinks(model).map((link) => decodeURIComponent(link));
    assert.ok(!links.some((link) => link.includes('$(check)')), 'la guia no se aplica con un clic');
    assert.ok(links.some((link) => link.includes('Proponer una mejora')));
    assert.match(buildSelectionWidgetText(model), /\$\(info\) _Tu docente limita/);
  });

  it('la ventana con el docente sin permitir aplicar: el codigo de la accion como guia, el motivo una sola vez', () => {
    const model = widget({ completionText: 'if (x) {\n  y();\n}', completionMode: 'insert', codeApplication: disabled, applicationNote: disabled.reason });
    const shown = selectionWidgetCode(model);
    assert.equal(shown.kind === 'guide' && shown.cause, 'policy_blocked');
    const text = buildSelectionWidgetText(model);
    assert.equal((text.match(/Tu docente desactivó la aplicación de código/g) || []).length, 1);
    assert.doesNotMatch(text, /Código para insertar debajo/);
  });

  it('una guia por resumen «...» con el docente sin permitir aplicar: los dos motivos', () => {
    const text = buildSelectionWidgetText(widget({ guide: { code: 'void otra() {\n  // ...\n}', reason: ELISION_GUIDE_REASON, cause: 'elision' }, codeApplication: disabled, applicationNote: disabled.reason }));
    assert.match(text, /Úsalo como guía o pide la versión completa/);
    assert.match(text, /Tu docente desactivó la aplicación de código/);
  });

  it('resumen «...» que se puede completar: se aplica; llaves sin cerrar: guia', () => {
    const selection = 'int x = 0;\nx = x + 1;\ncout << x;\nreturn x;';
    const expanded = prepareSuggestionCode('int x = 0;\nx = x + 1;\n// ...\nreturn x;', { selection, mode: 'replace', language: 'cpp' });
    assert.equal(expanded.guideOnly, null);
    assert.deepEqual(expanded.notes, [ELISION_EXPANDED_NOTE]);
    const broken = prepareSuggestionCode('void f() {\n  a();\n  if (x) {\n', { selection: 'void f() {\n  a();\n}', mode: 'replace', language: 'cpp' });
    assert.deepEqual(broken.guideOnly, { cause: 'unbalanced', reason: UNBALANCED_REASON });
  });

  it('sin codigo de guia, sigue el mensaje de siempre', () => {
    assert.deepEqual(selectionWidgetCode(widget()), { kind: 'none' });
    assert.match(buildSelectionWidgetText(widget()), /El tutor no escribió código para este bloque/);
  });
});

describe('la ventana y la vista «Este archivo» muestran lo mismo del mismo modelo (0.0.38)', () => {
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

  const cases: Array<[string, Partial<ActiveSuggestionModel>]> = [
    ['recortado (guia)', { guide: { code: 'int main(){', reason: POLICY_CUT_REASON, cause: 'policy_cut' } }],
    ['recortado con la aplicacion desactivada', { guide: { code: 'int main(){', reason: POLICY_CUT_REASON, cause: 'policy_cut' }, codeApplication: policy({ allowed: false, reason: 'Desactivada.', reasonCode: 'code_application_disabled', truncation: 'guide' }) }],
    ['respuesta cortada', { guide: { code: 'int main(){', reason: INCOMPLETE_REPLY_REASON, cause: 'incomplete_reply' }, codeApplication: policy({ allowed: false, reasonCode: 'code_application_incomplete_reply', truncation: 'guide' }) }],
    ['codigo de la accion sin permiso', { completionText: 'x++;', completionMode: 'insert', codeApplication: policy({ allowed: false, reason: BACKEND_NOTE, reasonCode: 'code_application_disabled' }) }],
    ['codigo de la accion sin completionMode (historial)', { completionText: 'x++;', completionMode: undefined, applyMode: 'insert', codeApplication: policy({ allowed: false, reason: BACKEND_NOTE, reasonCode: 'code_application_disabled' }) }],
    ['codigo para aplicar', { completionText: 'x++;', completionMode: 'insert' }],
    ['sin codigo', {}],
  ];

  for (const [label, patch] of cases) {
    it(label, () => {
      const active = model(patch);
      const inWidget = selectionWidgetCode(toSelectionWidgetModel(active)!);
      const inView = suggestionGuide(active);
      if (inWidget.kind === 'guide') {
        assert.deepEqual(inView, { code: inWidget.code, reason: inWidget.reason, cause: inWidget.cause, label: GUIDE_CODE_LABEL, language: 'cpp' });
      } else {
        assert.equal(inView, null, 'la vista solo muestra guias: lo que se aplica esta en la ventana');
      }
    });
  }

  it('la vista lleva a lo sumo 40 lineas y el rotulo en su estado', () => {
    const long = Array.from({ length: 50 }, (_, index) => `x${index}++;`).join('\n');
    const guide = suggestionGuide(model({ guide: { code: long, reason: 'r', cause: 'elision' } }));
    assert.equal(guide?.code.split('\n').length, 41);
    assert.match(guide?.code || '', /…$/);
    const state = buildFileViewState(model({ guide: { code: 'x++;', reason: 'r', cause: 'elision' } }), null, false, EMPTY_MATERIAL_STATE);
    assert.equal(state.suggestion?.guide?.label, GUIDE_CODE_LABEL);
  });
});

describe('la ventana lleva la explicacion en vivo solo mientras espera (0.0.39)', () => {
  function active(patch: Partial<ActiveSuggestionModel> = {}): ActiveSuggestionModel {
    return {
      uriString: 'file:///repo/src/main.cpp', filePath: 'src/main.cpp', fileName: 'main.cpp', language: 'cpp',
      repoFullName: '', title: '', summary: '', fileOverview: '', lineSummary: 'Falta validar el retiro.',
      suggestions: [], fileSuggestions: [], lineSuggestions: [], nextSteps: [], chips: [], source: 'backend',
      backendError: '', ragSources: [], ragCourseCode: '', updatedAt: '', line: 10, column: 1,
      selectionLineCount: 3, selectionOriginalLineCount: 3, selectionTruncated: false, selectionRangeKey: '10-12',
      fileSummaryCacheKey: 'k', metricId: 'm', completionText: '', completionMode: '', applyMode: 'replace', triggerKind: 'cursor',
      ...patch,
    } as ActiveSuggestionModel;
  }

  it('cargando o pidiendo codigo: partialText pasa a la ventana; lista, no (va explanationText)', () => {
    assert.equal(toSelectionWidgetModel(active({ loading: true, partialText: 'en vivo' }))?.partialText, 'en vivo');
    assert.equal(toSelectionWidgetModel(active({ pendingMode: 'insert', partialText: 'en vivo' }))?.partialText, 'en vivo');
    const ready = toSelectionWidgetModel(active({ partialText: 'viejo', explanationText: 'completa' }));
    assert.equal(ready?.partialText, '', 'un texto en vivo viejo no se mezcla con la respuesta lista');
    assert.equal(ready?.explanationText, 'completa');
  });
});
