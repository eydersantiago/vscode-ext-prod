import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  actionModeFromText,
  analyzedBlockMatches,
  explicitActionMode,
  extractFirstCodeFence,
  extractSuggestionCode,
  isPlaceholderCode,
  producedMode,
  isSignificantCodeLine,
  replacementDropsMostOfSelection,
  resolveSuggestionModes,
  retainedSelectionFraction,
  suggestionReadyForMode,
} from '../suggestion-code';

// Reunion del 20/10/2026: la sugerencia solo agregaba «// TODO: ...» y «Modificar
// seleccion» cambiaba el bloque por un fragmento escrito para insertar.

const IMPROVED = [
  'double calcularArea(double base, double altura) {',
  '  return base * altura / 2.0;',
  '}',
].join('\n');

function answer(applyLine: string, code: string, language = 'cpp') {
  return ['1) Resumen:', '- Calcula el area.', '', `4) Accion: ${applyLine}`, `\`\`\`${language}`, code, '```'].join('\n');
}

describe('codigo de la sugerencia (0.0.34)', () => {
  it('un bloque de puros comentarios o marcadores no es codigo', () => {
    assert.equal(isPlaceholderCode('// TODO: valida el monto'), true);
    assert.equal(isPlaceholderCode('    # TODO: completar\n    pass'), true);
    assert.equal(isPlaceholderCode('/* revisar */\n...'), true);
    assert.equal(isPlaceholderCode(''), true);
    assert.equal(isPlaceholderCode('#include <vector>'), false, 'una directiva del preprocesador es codigo');
    assert.equal(isPlaceholderCode('// paso 1\nint total = 0;'), false);
    assert.equal(isPlaceholderCode('*p = 5;'), false, 'una desreferencia no es un comentario');
    assert.equal(isPlaceholderCode('// TODO: lee el dato\ncin >> dato;'), false, 'un TODO con codigo real se acepta');
  });

  it('el codigo sale solo del bloque del tutor, nunca de un TODO', () => {
    assert.equal(extractSuggestionCode(answer('Aplicar: replace', IMPROVED)), IMPROVED);
    assert.equal(extractSuggestionCode(answer('Aplicar: insert', '// TODO: imprime el area')), '');
    assert.equal(extractSuggestionCode('1) Resumen:\n- Sin bloque de codigo.'), '');
    assert.equal(extractFirstCodeFence('```c++\nint x = 1;\n```'), 'int x = 1;');
  });

  it('la accion sale de la linea Aplicar, o del pedido del estudiante, antes que de los verbos', () => {
    assert.equal(explicitActionMode('4) Accion: Aplicar: `replace`'), 'replace');
    assert.equal(explicitActionMode('Aplicar: insert'), 'insert');
    assert.equal(explicitActionMode('Corrige el bloque'), '');
    assert.equal(actionModeFromText('Corrige el bloque'), 'replace');
    assert.equal(actionModeFromText('insert_after_line'), 'insert');

    const replaced = resolveSuggestionModes({ focusText: answer('Aplicar: replace', IMPROVED), code: IMPROVED });
    assert.deepEqual(replaced, { applyMode: 'replace', completionMode: 'replace', completionText: IMPROVED });

    const noLine = resolveSuggestionModes({ focusText: '1) Resumen:\n- Mejora el bloque.', code: IMPROVED, requestedAction: 'replace' });
    assert.equal(noLine.applyMode, 'replace', 'sin linea Aplicar manda el pedido del estudiante');

    const deleted = resolveSuggestionModes({ focusText: answer('Aplicar: delete', IMPROVED), code: IMPROVED });
    assert.deepEqual(deleted, { applyMode: 'delete', completionMode: '', completionText: '' }, 'eliminar no usa codigo');

    const noCode = resolveSuggestionModes({ focusText: 'Aplicar: replace', code: '' });
    assert.deepEqual(noCode, { applyMode: 'replace', completionMode: '', completionText: '' });
  });

  it('si la linea Aplicar contradice el pedido, decide el contenido (revision del 20/10)', () => {
    const original = ['double calcularArea(double base, double altura) {', '  return base * altura;', '}'].join('\n');
    const snippet = '  cout << "Area: " << area << endl;';
    // La llave de cierre no cuenta: 2 lineas significativas y 1 queda igual.
    assert.equal(retainedSelectionFraction(original, IMPROVED), 1 / 2);
    assert.equal(retainedSelectionFraction(original, snippet), 0);
    assert.equal(retainedSelectionFraction('', IMPROVED), 0);

    // Pidio mejorar, el modelo dijo insert y mando el bloque completo: es la version mejorada.
    const full = resolveSuggestionModes({ focusText: answer('Aplicar: insert', IMPROVED), code: IMPROVED, requestedAction: 'replace', selection: original });
    assert.deepEqual(full, { applyMode: 'replace', completionMode: 'replace', completionText: IMPROVED });
    // Pidio mejorar y llego un fragmento de una linea: no se ofrece como «version mejorada» del bloque.
    const piece = resolveSuggestionModes({ focusText: answer('Aplicar: insert', snippet), code: snippet, requestedAction: 'replace', selection: original });
    assert.equal(piece.completionMode, 'insert');
    // Pidio continuar y el modelo dijo replace con un fragmento: es para insertar.
    const cont = resolveSuggestionModes({ focusText: answer('Aplicar: replace', snippet), code: snippet, requestedAction: 'insert', selection: original });
    assert.equal(cont.completionMode, 'insert');
    // Sin pedido: un «insert» que ya trae el bloque lo duplicaria, asi que es un reemplazo.
    const dup = resolveSuggestionModes({ focusText: answer('Aplicar: insert', `${original}\ncout << area;`), code: `${original}\ncout << area;`, selection: original });
    assert.equal(dup.completionMode, 'replace');
    // Sin seleccion no hay con que comparar: manda la linea.
    const cursor = resolveSuggestionModes({ focusText: answer('Aplicar: insert', IMPROVED), code: IMPROVED, selection: '' });
    assert.equal(cursor.completionMode, 'insert');
    // «Aplicar: delete» con el bloque mejorado cuando se pidio mejorar: es la version mejorada.
    const deleteLine = resolveSuggestionModes({ focusText: answer('Aplicar: delete', IMPROVED), code: IMPROVED, requestedAction: 'replace', selection: original });
    assert.equal(deleteLine.completionMode, 'replace');
    // Las llaves y palabras sueltas no cuentan (segunda revision): un metodo nuevo que termina en }
    // no «conserva» un bloque de dos lineas que termina igual, y un else no es una version del if.
    const tail = '  return total;\n}';
    const newMethod = 'int doble(int x) {\n  return 2 * x;\n}';
    assert.equal(resolveSuggestionModes({ focusText: answer('Aplicar: insert', newMethod), code: newMethod, requestedAction: 'insert', selection: tail }).completionMode, 'insert');
    const elseBranch = '} else {\n  y = 0;\n}';
    assert.equal(resolveSuggestionModes({ focusText: answer('Aplicar: insert', elseBranch), code: elseBranch, selection: 'if (x > 0) {\n}' }).completionMode, 'insert');
    assert.equal(isSignificantCodeLine('}'), false);
    assert.equal(isSignificantCodeLine('} else {'), false);
    assert.equal(isSignificantCodeLine('});'), false);
    assert.equal(isSignificantCodeLine('return total;'), true);
  });

  it('el bloque que vio el tutor tiene que seguir igual para aplicar sobre el', () => {
    const block = ['  int suma = 0;', '  for (int i = 0; i < n; i++) {', '    suma += v[i];', '  }'];
    assert.equal(analyzedBlockMatches(block, block.join('\n')), true);
    assert.equal(analyzedBlockMatches(block, `${block.join('\n')}\n`), true, 'la seleccion que termina al inicio de la linea siguiente');
    assert.equal(analyzedBlockMatches(block, ['suma = 0;', ...block.slice(1)].join('\n')), true, 'la seleccion empezo a mitad de linea');
    assert.equal(analyzedBlockMatches(block, block.slice(0, 2).join('\n')), true, 'el texto llego recortado por caracteres');
    const edited = [...block];
    edited[2] = '    suma -= v[i];';
    assert.equal(analyzedBlockMatches(edited, block.join('\n')), false, 'el estudiante cambio una linea');
    assert.equal(analyzedBlockMatches(block.slice(0, 2), block.join('\n')), false, 'el documento tiene menos lineas');
    assert.equal(analyzedBlockMatches(block, '   '), false);
  });

  it('solo se aplica con un clic la accion para la que se escribio el codigo', () => {
    const insertCode = { completionText: 'cout << area;', completionMode: 'insert' as const, applyMode: 'insert' as const };
    assert.equal(suggestionReadyForMode(insertCode, 'insert'), true);
    assert.equal(suggestionReadyForMode(insertCode, 'replace'), false, 'Modificar pide su propio codigo');
    assert.equal(suggestionReadyForMode(insertCode, 'delete'), true);
    assert.equal(suggestionReadyForMode({ completionText: '', completionMode: '', applyMode: 'replace' }, 'replace'), false);
    // Modelos guardados antes de la 0.0.34 (sin completionMode): el codigo era de la accion recomendada.
    assert.equal(producedMode({ completionText: 'x = 1;', applyMode: 'replace' }), 'replace');
    assert.equal(producedMode({ completionText: 'x = 1;', applyMode: 'delete' }), '');
  });

  it('avisa si la version mejorada se lleva mas de la mitad del bloque', () => {
    const selection = ['int suma = 0;', 'for (int i = 0; i < n; i++) {', '  suma += v[i];', '}', 'cout << suma;'].join('\n');
    const improved = selection.replace('cout << suma;', 'cout << "Suma: " << suma << endl;');
    assert.equal(replacementDropsMostOfSelection(selection, improved), false);
    assert.equal(replacementDropsMostOfSelection(selection, 'cout << suma;'), true, 'un fragmento suelto no es el bloque completo');
    assert.equal(replacementDropsMostOfSelection('a;\nb;', 'c;'), true, 'desde 2 lineas avisa (segunda revision)');
    assert.equal(replacementDropsMostOfSelection('a;', 'c;'), false, 'una sola linea no avisa');
  });
});
