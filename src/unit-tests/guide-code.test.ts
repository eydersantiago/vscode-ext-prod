import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  CODE_APPLICATION_REASON_CODES,
  ELISION_EXPANDED_NOTE,
  ELISION_GUIDE_REASON,
  GUIDE_CODE_LABEL,
  POLICY_BLOCKED_REASON,
  POLICY_CUT_NOTE,
  POLICY_CUT_REASON,
  UNBALANCED_REASON,
  codeCutNote,
  extractSuggestionCode,
  guideForPolicy,
  isElisionLine,
  isPolicyCutLine,
  normalizeCodeCutSummary,
  normalizeCodeTruncation,
  policyCutReason,
  policyTruncation,
  prepareSuggestionCode,
  resolveSuggestionModes,
  stripCutNoteAfterFence,
  stripPolicyCutLines,
  toSuggestionCodeFields,
  unwrapEmphasisLine,
} from '../suggestion-code';
import type { CodeCutSummary, CodeTruncation } from '../suggestion-code';
import { resolveDisplayedCode } from '../suggestion-phase';
import { buildSelectionWidgetText, selectionWidgetActionLinks, selectionWidgetCode, selectionWidgetShowsTitleActions } from '../selection-widget-text';
import type { SelectionWidgetModel } from '../selection-widget-text';
import { buildFileViewState, EMPTY_MATERIAL_STATE, suggestionGuide } from '../file-view-model';
import type { ActiveSuggestionModel, SuggestionCodeApplication } from '../types';

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

/** Lo que mando el backend anterior: 5 lineas y su marca de recorte (limitCodeBlocks). */
const LEGACY_CUT_ANSWER = ['1) Resumen:', '- Falta validar el retiro.', '', '```cpp', ...CUT_LINES, '// ... recortado por la politica del docente: completa el resto tu', '```'].join('\n');

/** Lo mismo con el backend nuevo: sin marca en el codigo (truncation y cut van en code_application). */
const NEW_CUT_ANSWER = ['1) Resumen:', '- Falta validar el retiro.', '', '```cpp', ...CUT_LINES, '```', '', '_El código se recortó a 5 de 12 líneas._'].join('\n');

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

function prepareFromAnswer(
  answer: string,
  selection: string,
  requestedAction: 'insert' | 'replace' | '' = '',
  signal: { truncation?: CodeTruncation; cut?: CodeCutSummary | null } = {},
) {
  const modes = resolveSuggestionModes({ focusText: answer, code: extractSuggestionCode(answer), requestedAction, selection });
  const prepared = prepareSuggestionCode(modes.completionText, { selection, mode: modes.completionMode, language: 'cpp', ...signal });
  return { modes, prepared, fields: toSuggestionCodeFields(prepared, modes.completionMode) };
}

function codeApplication(patch: Partial<SuggestionCodeApplication> = {}): SuggestionCodeApplication {
  return { allowed: true, maxLines: 5, remaining: null, requireConfirmation: false, countsAsHint: false, reason: '', reasonCode: 'ok', truncation: '', ...patch };
}

describe('recorte del docente con code_application (0.0.38)', () => {
  it('lee truncation y cut del contrato y descarta lo demas', () => {
    assert.equal(normalizeCodeTruncation('guide'), 'guide');
    assert.equal(normalizeCodeTruncation('applicable'), 'applicable');
    assert.equal(normalizeCodeTruncation('otra'), '');
    assert.equal(normalizeCodeTruncation(undefined), '');
    assert.deepEqual(normalizeCodeCutSummary({ kind: 'prefix', shown: 5, total: 12, clean: true }), { kind: 'prefix', shown: 5, total: 12, clean: true });
    assert.deepEqual(normalizeCodeCutSummary({ shown: 3.7, total: 9 }), { kind: 'prefix', shown: 3, total: 9, clean: false });
    assert.equal(normalizeCodeCutSummary({ shown: 'x', total: 9 }), null);
    assert.equal(normalizeCodeCutSummary(null), null);
  });

  it('guide sale de truncation o, sin el campo, del reasonCode tooLarge', () => {
    assert.equal(policyTruncation(codeApplication({ truncation: 'guide' })), 'guide');
    assert.equal(policyTruncation(codeApplication({ allowed: false, reasonCode: CODE_APPLICATION_REASON_CODES.tooLarge })), 'guide');
    assert.equal(policyTruncation(codeApplication({ truncation: 'applicable' })), 'applicable');
    assert.equal(policyTruncation(codeApplication()), '');
    assert.equal(policyTruncation(null), '');
  });

  it('el caso del piloto con el backend nuevo: guia con cuantas lineas se muestran', () => {
    const cut: CodeCutSummary = { kind: 'prefix', shown: 5, total: 12, clean: true };
    const { prepared, fields } = prepareFromAnswer(NEW_CUT_ANSWER, MAIN_SELECTION, 'replace', { truncation: 'guide', cut });
    assert.equal(prepared.guideOnly?.cause, 'policy_cut');
    assert.equal(prepared.guideOnly?.reason, policyCutReason(cut));
    assert.match(prepared.guideOnly?.reason || '', /El tutor muestra 5 de 12 líneas/);
    assert.equal(fields.completionText, '', 'nada lo aplica');
    assert.deepEqual(fields.guide, { code: CUT_LINES.join('\n'), cause: 'policy_cut', reason: policyCutReason(cut) });
  });

  it('applicable: el trozo cerrado se puede aplicar, con el aviso de cuanto trae', () => {
    const answer = 'Aplicar: insert\n```cpp\nif (cantidad <= 0) {\n    return false;\n}\n```';
    const prefix = prepareFromAnswer(answer, 'saldo -= cantidad;', '', { truncation: 'applicable', cut: { kind: 'prefix', shown: 3, total: 8, clean: true } });
    assert.equal(prefix.prepared.guideOnly, null);
    assert.deepEqual(prefix.prepared.notes, ['El tutor muestra 3 de 8 líneas: revisa qué falta y complétalo tú.']);
    assert.equal(prefix.fields.completionMode, 'insert');
    assert.equal(codeCutNote({ kind: 'partial', shown: 2, total: 6, clean: true }), 'Se aplican 2 de 6 cambios; el resto de tus líneas queda igual.');
    assert.equal(codeCutNote(null), POLICY_CUT_NOTE);
  });

  it('reemplazo parcial aplicable (cut.kind partial): se aplica con su aviso', () => {
    const answer = 'Aplicar: replace\n```cpp\nint main(){\n    Banco banco;\n    if (monto > 0) banco.depositar(monto);\n}\n```';
    const { prepared, fields } = prepareFromAnswer(answer, 'int main(){\n    Banco banco;\n    banco.depositar(monto);\n}', 'replace', { truncation: 'applicable', cut: { kind: 'partial', shown: 1, total: 3, clean: true } });
    assert.equal(prepared.guideOnly, null);
    assert.deepEqual(prepared.notes, ['Se aplican 1 de 3 cambios; el resto de tus líneas queda igual.']);
    assert.equal(fields.completionMode, 'replace');
  });

  it('el motivo de la guia sigue el tipo de recorte', () => {
    assert.match(policyCutReason({ kind: 'prefix', shown: 5, total: 12, clean: false }), /^El tutor muestra 5 de 12 líneas/);
    assert.match(policyCutReason({ kind: 'partial', shown: 2, total: 6, clean: true }), /^El tutor propone 2 de 6 cambios/);
    assert.equal(policyCutReason(null), POLICY_CUT_REASON);
  });

  it('si el docente ademas no deja aplicar por otra razon, la guia dice esa razon', () => {
    const guide = { code: 'x++;', reason: POLICY_CUT_REASON, cause: 'policy_cut' as const };
    const disabled = guideForPolicy(guide, { allowed: false, reasonCode: CODE_APPLICATION_REASON_CODES.disabled, reason: 'Tu docente desactivó la aplicación.' });
    assert.deepEqual(disabled, { code: 'x++;', cause: 'policy_blocked', reason: 'Tu docente desactivó la aplicación.' });
    assert.equal(guideForPolicy(guide, { allowed: false, reasonCode: CODE_APPLICATION_REASON_CODES.tooLarge, reason: 'pasaba de 5' }), guide, 'el tope de lineas ya esta dicho');
    assert.equal(guideForPolicy(guide, { allowed: true, reasonCode: 'ok' }), guide);
    assert.equal(guideForPolicy(null, { allowed: false, reasonCode: 'code_application_disabled' }), null);
  });
});

describe('notas del backend fuera del bloque (0.0.38)', () => {
  it('la nota en cursiva despues del bloque recortado no se repite como texto de la sugerencia', () => {
    const output = '1) Resumen:\n- Falta validar el retiro.\n\n```cpp\nint main(){\n}\n```\n\n_El tutor muestra 5 de 12 lineas: el resto lo escribes tu._\n\n2) Sugerencias:\n- Valida el monto.';
    const stripped = stripCutNoteAfterFence(output);
    assert.doesNotMatch(stripped, /El tutor muestra 5 de 12/);
    assert.match(stripped, /```cpp\nint main\(\)\{\n\}\n```/, 'el codigo queda igual');
    assert.match(stripped, /2\) Sugerencias:\n- Valida el monto\./);
    assert.equal(extractSuggestionCode(stripped), extractSuggestionCode(output));
    assert.equal(stripCutNoteAfterFence('```cpp\nx++;\n```\nTexto normal.'), '```cpp\nx++;\n```\nTexto normal.', 'solo una linea en cursiva');
    assert.equal(stripCutNoteAfterFence('sin bloque\n_nota_'), 'sin bloque\n_nota_');
  });

  it('una linea en cursiva se lee como texto', () => {
    assert.equal(unwrapEmphasisLine('_El tutor muestra 5 de 12 lineas._'), 'El tutor muestra 5 de 12 lineas.');
    assert.equal(unwrapEmphasisLine('*(codigo omitido: en esta etapa la ayuda es solo una pista)*'), '(codigo omitido: en esta etapa la ayuda es solo una pista)');
    assert.equal(unwrapEmphasisLine('usa_snake_case en las variables'), 'usa_snake_case en las variables');
    assert.equal(unwrapEmphasisLine('__init__'), '__init__', 'no es cursiva');
    assert.equal(unwrapEmphasisLine('x'), 'x');
  });
});

describe('marca de recorte del backend anterior (compatibilidad, 0.0.38)', () => {
  it('se reconoce con y sin tildes, y no es un resumen del modelo', () => {
    assert.equal(isPolicyCutLine('// ... recortado por la politica del docente: completa el resto tu'), true);
    assert.equal(isPolicyCutLine('    // ... recortado por la política del docente: completa el resto tú'), true);
    assert.equal(isPolicyCutLine('# ... recortado por la politica del docente: completa el resto tu'), true);
    assert.equal(isPolicyCutLine('... recortado por el límite del docente'), true);
    assert.equal(isPolicyCutLine('cout << "recortado por la politica del docente";'), false, 'una cadena no es la marca');
    assert.equal(isPolicyCutLine('// ...'), false);
    assert.equal(isElisionLine('// ... recortado por la politica del docente: completa el resto tu'), false);
    assert.equal(isElisionLine('// ...'), true, 'los resumenes del modelo se siguen reconociendo');
    assert.deepEqual(stripPolicyCutLines('a();\n// ... recortado por la politica del docente: completa el resto tu'), { code: 'a();', cut: true });
    assert.deepEqual(stripPolicyCutLines('a();\nb();'), { code: 'a();\nb();', cut: false });
  });

  it('el caso exacto del piloto: la version de main cortada se ve como guia, sin aplicar', () => {
    const { modes, prepared, fields } = prepareFromAnswer(LEGACY_CUT_ANSWER, MAIN_SELECTION, 'replace');
    assert.equal(modes.completionMode, 'replace');
    assert.deepEqual(prepared.guideOnly, { cause: 'policy_cut', reason: POLICY_CUT_REASON });
    assert.doesNotMatch(prepared.code, /recortado/, 'la marca no se muestra');
    assert.match(prepared.code, /Cuenta\* c = banco\.abrirCuenta\("1", 1000\);/);
    assert.equal(fields.completionText, '');
    assert.equal(fields.completionMode, '');
    assert.equal(fields.guide?.code, prepared.code, 'el codigo no se pierde');

    const text = buildSelectionWidgetText(widget({ guide: fields.guide, codeApplicationAllowed: false, applicationNote: BACKEND_NOTE }));
    assert.match(text, /Código de guía \(no se aplica con un clic\)/);
    assert.match(text, /```cpp\nint main\(\)\{\n {4}Banco banco;/);
    assert.match(text, /Tu docente limita cuántas líneas escribe el tutor/);
    assert.doesNotMatch(text, /resumió parte de tu bloque/);
    assert.doesNotMatch(text, /pasaba de 5 lineas/, 'la causa policy_cut ya lo explica: la nota del backend no se repite');
    assert.doesNotMatch(text, /applySuggestionCompletion/, 'sin aplicar ni pedir codigo: el docente no deja');
    assert.doesNotMatch(text, /recortado por la politica/);
  });

  it('con un backend sin truncation pero con reasonCode tooLarge, el codigo para insertar tambien es guia', () => {
    const answer = 'Aplicar: insert\n```cpp\nif (cantidad <= 0) {\n    return false;\n}\n// ... recortado por la politica del docente: completa el resto tu\n```';
    const truncation = policyTruncation(codeApplication({ allowed: false, reasonCode: 'code_application_too_large' }));
    const { prepared } = prepareFromAnswer(answer, 'saldo -= cantidad;', '', { truncation });
    assert.equal(prepared.guideOnly?.cause, 'policy_cut');
  });

  it('sin ninguna señal, un codigo para insertar cortado que cierra sus llaves se puede insertar', () => {
    const answer = 'Aplicar: insert\n```cpp\nif (cantidad <= 0) {\n    return false;\n}\n// ... recortado por la politica del docente: completa el resto tu\n```';
    const { prepared, fields } = prepareFromAnswer(answer, 'saldo -= cantidad;');
    assert.equal(prepared.guideOnly, null);
    assert.deepEqual(prepared.notes, [POLICY_CUT_NOTE]);
    assert.equal(fields.completionMode, 'insert');
    assert.equal(fields.completionText, 'if (cantidad <= 0) {\n    return false;\n}');
    assert.equal(fields.guide, null);
  });

  it('cortado a mitad de un bloque: solo guia; y un bloque que solo traia la marca no es codigo', () => {
    const answer = 'Aplicar: insert\n```cpp\nif (cantidad <= 0) {\n    cout << "monto invalido";\n// ... recortado por la politica del docente: completa el resto tu\n```';
    const { prepared, fields } = prepareFromAnswer(answer, 'saldo -= cantidad;');
    assert.deepEqual(prepared.guideOnly, { cause: 'policy_cut', reason: POLICY_CUT_REASON });
    assert.match(fields.guide?.code || '', /monto invalido/);
    const empty = prepareSuggestionCode('// ... recortado por la politica del docente: completa el resto tu', { mode: 'insert', language: 'cpp' });
    assert.equal(empty.code, '');
    assert.equal(empty.guideOnly, null);
  });
});

describe('que codigo se ve: una sola regla (0.0.38)', () => {
  const GUIDE = { code: 'int main(){\n    Banco banco;', reason: POLICY_CUT_REASON, cause: 'policy_cut' as const };

  it('aplicar, guia de la politica, guia preparada o nada', () => {
    const base = { source: 'backend' as const };
    assert.deepEqual(resolveDisplayedCode({ ...base, completionText: 'x++;\n', completionMode: 'insert' }), { kind: 'apply', code: 'x++;', mode: 'insert' });
    assert.deepEqual(
      resolveDisplayedCode({ ...base, completionText: 'x++;', completionMode: 'insert', codeApplication: { allowed: false, reason: '' } }),
      { kind: 'guide', code: 'x++;', reason: POLICY_BLOCKED_REASON, cause: 'policy_blocked' },
    );
    assert.deepEqual(resolveDisplayedCode({ ...base, guide: GUIDE }), { kind: 'guide', ...GUIDE });
    assert.deepEqual(resolveDisplayedCode({ ...base }), { kind: 'none' });
    assert.deepEqual(resolveDisplayedCode({ ...base, guide: GUIDE, applied: true }), { kind: 'none' }, 'aplicada');
    assert.deepEqual(resolveDisplayedCode({ ...base, guide: GUIDE, loading: true }), { kind: 'none' }, 'cargando');
    assert.deepEqual(resolveDisplayedCode({ ...base, guide: GUIDE, blocked: true }), { kind: 'none' }, 'bloqueada: solo el mensaje del tutor');
  });

  it('la ventana: guia con su motivo y, si la politica deja, pedir otra version', () => {
    const model = widget({ guide: GUIDE });
    assert.deepEqual(selectionWidgetCode(model), { kind: 'guide', ...GUIDE });
    assert.equal(selectionWidgetShowsTitleActions(model), true);
    const links = selectionWidgetActionLinks(model).map((link) => decodeURIComponent(link));
    assert.ok(!links.some((link) => link.includes('$(check)')), 'la guia no se aplica con un clic');
    assert.ok(links.some((link) => link.includes('Proponer una mejora')));
    const text = buildSelectionWidgetText(model);
    assert.match(text, /Código de guía/);
    assert.match(text, /Banco banco;/);
    assert.match(text, /\$\(info\) _Tu docente limita/);
  });

  it('la ventana con el docente sin permitir aplicar: el codigo de la accion como guia, el motivo una sola vez', () => {
    const model = widget({ completionText: 'if (x) {\n  y();\n}', completionMode: 'insert', codeApplicationAllowed: false, applicationNote: 'Tu docente no permite aplicar código aquí.' });
    const shown = selectionWidgetCode(model);
    assert.equal(shown.kind, 'guide');
    assert.equal(shown.kind === 'guide' && shown.cause, 'policy_blocked');
    const text = buildSelectionWidgetText(model);
    assert.equal((text.match(/Tu docente no permite aplicar código aquí/g) || []).length, 1);
    assert.doesNotMatch(text, /Código para insertar debajo/);
  });

  it('una guia por resumen «...» con el docente sin permitir aplicar: los dos motivos', () => {
    const text = buildSelectionWidgetText(widget({
      guide: { code: 'void otra() {\n  // ...\n}', reason: ELISION_GUIDE_REASON, cause: 'elision' },
      codeApplicationAllowed: false,
      applicationNote: 'Tu docente desactivó la aplicación de código.',
    }));
    assert.match(text, /Úsalo como guía o pide la versión completa/);
    assert.match(text, /Tu docente desactivó la aplicación de código/);
  });

  it('un resumen «...» que se puede completar se sigue completando y aplicando', () => {
    const selection = 'int x = 0;\nx = x + 1;\ncout << x;\nreturn x;';
    const prepared = prepareSuggestionCode('int x = 0;\nx = x + 1;\n// ...\nreturn x;', { selection, mode: 'replace', language: 'cpp' });
    assert.equal(prepared.guideOnly, null);
    assert.deepEqual(prepared.notes, [ELISION_EXPANDED_NOTE]);
    const fields = toSuggestionCodeFields(prepared, 'replace');
    assert.equal(fields.completionText, 'int x = 0;\nx = x + 1;\ncout << x;\nreturn x;');
    assert.equal(fields.guide, null);
  });

  it('llaves sin cerrar: guia con su causa', () => {
    const prepared = prepareSuggestionCode('void f() {\n  a();\n  if (x) {\n', { selection: 'void f() {\n  a();\n}', mode: 'replace', language: 'cpp' });
    assert.deepEqual(prepared.guideOnly, { cause: 'unbalanced', reason: UNBALANCED_REASON });
    assert.match(toSuggestionCodeFields(prepared, 'replace').guide?.code || '', /if \(x\) \{/);
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

  it('lleva el codigo, el motivo, la causa y el rotulo junto a la sugerencia de ahora', () => {
    const guide = { code: 'int main(){\n    Banco banco;', reason: POLICY_CUT_REASON, cause: 'policy_cut' as const };
    const state = buildFileViewState(model({ guide }), null, false, EMPTY_MATERIAL_STATE);
    assert.deepEqual(state.suggestion?.guide, { ...guide, label: GUIDE_CODE_LABEL, language: 'cpp' });
  });

  it('con el docente sin permitir aplicar, el codigo de la accion va como guia con su motivo', () => {
    const guide = suggestionGuide(model({ completionText: 'x++;', completionMode: 'insert', codeApplication: codeApplication({ allowed: false, reason: BACKEND_NOTE }) }));
    assert.deepEqual(guide, { code: 'x++;', reason: BACKEND_NOTE, cause: 'policy_blocked', label: GUIDE_CODE_LABEL, language: 'cpp' });
  });

  it('a lo sumo 40 lineas; sin guia, aplicada o cargando: nada', () => {
    const long = Array.from({ length: 50 }, (_, index) => `x${index}++;`).join('\n');
    const guide = suggestionGuide(model({ guide: { code: long, reason: 'r', cause: 'elision' } }));
    assert.equal(guide?.code.split('\n').length, 41);
    assert.match(guide?.code || '', /…$/);
    assert.equal(suggestionGuide(model({ completionText: 'x++;', completionMode: 'insert' })), null, 'se aplica desde la ventana');
    assert.equal(suggestionGuide(model({ guide: { code: 'x++;', reason: 'r', cause: 'elision' }, applied: true })), null);
    assert.equal(suggestionGuide(model({ guide: { code: 'x++;', reason: 'r', cause: 'elision' }, loading: true })), null);
  });
});
