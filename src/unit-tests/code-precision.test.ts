import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { convertIndentStyle, deepestIndentBelow, indentUnitFromOptions, insertTargetIndent, opensBlock, placeInsertedCode, reindentCode, stripLineGutters } from '../code-reindent';
import {
  ELISION_EXPANDED_NOTE,
  ELISION_UNUSABLE_REASON,
  UNBALANCED_REASON,
  bracketBalance,
  expandElisions,
  extractSuggestionCode,
  isElisionLine,
  prepareSuggestionCode,
  resolveSuggestionModes,
} from '../suggestion-code';

// Revision de precision del 21/10/2026 (0.0.35): sangria, margen numerado, resumenes "..." y
// llaves sin cerrar en el codigo que propone el tutor.

const ORIGINAL = [
  '  double area() const {',
  '    if (base < 0) {',
  '      return 0;',
  '    }',
  '    double a = base * altura;',
  '    cout << a;',
  '    return a;',
  '  }',
].join('\n');

describe('sangria del codigo propuesto (0.0.35)', () => {
  it('convierte 4 espacios del modelo a la unidad y la sangria del archivo', () => {
    const fromModel = 'if (x > 0) {\n    total += x;\n}';
    assert.equal(reindentCode(fromModel, '  ', '  '), '  if (x > 0) {\n    total += x;\n  }');
    assert.equal(reindentCode(fromModel, '\t', '\t'), '\tif (x > 0) {\n\t\ttotal += x;\n\t}');
  });

  it('quita la sangria comun aunque el modelo la haya traido de mas', () => {
    const fromModel = '        double a = base * altura;\n        return a;';
    assert.equal(reindentCode(fromModel, '    ', '    '), '    double a = base * altura;\n    return a;');
  });

  it('una linea alineada bajo un parentesis no cambia la unidad del bloque (segunda revision)', () => {
    const fromModel = 'if x:\n    r = sumar(a,\n              b)\n    print(r)';
    assert.equal(reindentCode(fromModel, '    ', '    '), '    if x:\n        r = sumar(a,\n                  b)\n        print(r)');
  });

  it('respeta una linea de continuacion alineada a mano', () => {
    const fromModel = 'int suma = a +\n           b;\nreturn suma;';
    assert.equal(reindentCode(fromModel, '  ', '  '), '  int suma = a +\n             b;\n  return suma;');
  });

  it('la unidad sale de las opciones del editor', () => {
    assert.equal(indentUnitFromOptions(true, 2), '  ');
    assert.equal(indentUnitFromOptions(false, 4), '\t');
    assert.equal(indentUnitFromOptions(undefined, 'auto'), '    ');
  });

  it('al insertar debajo de una linea que abre bloque, un nivel mas', () => {
    assert.equal(opensBlock('  if (x > 0) {'), true);
    assert.equal(opensBlock('def area(self):  # calcula'), true);
    assert.equal(opensBlock('public:'), true);
    assert.equal(opensBlock('  cout << "http://x";'), false, 'un // dentro de una cadena no es comentario');
    assert.equal(opensBlock('  std::'), false);
    assert.equal(insertTargetIndent('  if (x > 0) {', '  ', 'total += x;'), '    ');
    assert.equal(insertTargetIndent('  if (x > 0) {', '  ', '} else {'), '  ', 'si el codigo empieza cerrando, sin nivel extra');
    assert.equal(insertTargetIndent('    total += x;', '  ', 'cout << total;'), '    ');
  });

  it('quita el margen numerado si el modelo lo copio en todas las lineas', () => {
    assert.equal(stripLineGutters('  16>| double a = 1;\n  17 |   return a;'), 'double a = 1;\n  return a;');
    assert.equal(stripLineGutters('16| x = 1;\nreturn x;'), '16| x = 1;\nreturn x;', 'si no lo traen todas, no se toca');
    assert.equal(stripLineGutters('a | b;'), 'a | b;');
  });
});

describe('resumenes "..." del modelo (0.0.35)', () => {
  it('reconoce las lineas que resumen codigo y no la sintaxis con puntos', () => {
    assert.equal(isElisionLine('    // ...'), true);
    assert.equal(isElisionLine('# ... resto igual'), true);
    assert.equal(isElisionLine('...'), true);
    assert.equal(isElisionLine('// resto del codigo igual'), true);
    assert.equal(isElisionLine('// (sin cambios)'), true);
    assert.equal(isElisionLine('template <typename... Args>'), false);
    assert.equal(isElisionLine('...args'), false);
    assert.equal(isElisionLine('// valida el resto de la entrada'), false);
    assert.equal(isElisionLine('cout << "...";'), false);
    assert.equal(isElisionLine('...(cond ? [a] : []),'), false, 'propagacion de JS');
    assert.equal(isElisionLine('...[1, 2]'), false);
    assert.equal(isElisionLine('... // resto igual'), true);
  });

  it('completa el resumen del final con las lineas del bloque original', () => {
    const code = [
      'double area() const {',
      '  if (base < 0 || altura < 0) {',
      '    return 0;',
      '  }',
      '  // ... resto igual',
      '}',
    ].join('\n');
    const expanded = expandElisions(code, ORIGINAL);
    assert.ok(expanded);
    assert.match(expanded!, /base < 0 \|\| altura < 0/);
    assert.match(expanded!, /double a = base \* altura;/);
    assert.match(expanded!, /cout << a;/);
    assert.match(expanded!, /return a;/);
    assert.equal(expanded!.split('\n').filter((line) => line.trim() === '}').length, 2, 'cierra el if y la funcion');
  });

  it('un cierre suelto despues del resumen se alinea con el final del bloque, no con el primer "}"', () => {
    const expanded = expandElisions('double area() const {\n  // ...\n}', ORIGINAL);
    assert.ok(expanded);
    assert.match(expanded!, /cout << a;/, 'no se pierde lo que va despues del primer "}"');
    assert.match(expanded!, /return a;/);
  });

  it('si las lineas de alrededor no estan en el bloque, no se puede completar', () => {
    assert.equal(expandElisions('void otra() {\n  // ...\n  imprimir();\n}', ORIGINAL), null);
  });

  it('si el modelo cambio la linea de justo antes del resumen, no se completa (revision independiente)', () => {
    const block = 'int x = 0;\nx = x + 1;\ncout << x;\nreturn x;';
    assert.equal(expandElisions('int x = 0;\nx = x + 2;\n// ...', block), null, 'si no, volvia la linea original x = x + 1');
    assert.equal(expandElisions('int x = 0;\nx = x + 2;\n// ...\nreturn x;', block), null);
    const ok = expandElisions('int x = 0;\nx = x + 1;\n// ...\nreturn x;', block);
    assert.equal(ok, 'int x = 0;\nx = x + 1;\ncout << x;\nreturn x;');
  });

  it('si la linea de despues del resumen se repite en el bloque, no se completa (revision independiente)', () => {
    const menu = [
      'cout << "1. Sumar";',
      'cin >> op;',
      'if (op == 1) sumar();',
      'cout << "2. Restar";',
      'cin >> op;',
      'if (op == 2) restar();',
    ].join('\n');
    assert.equal(expandElisions('cout << "1. Sumar";\n// ...\ncin >> op;\nif (op == 2) restar();', menu), null);
  });

  it('las lineas traidas del original quedan en la sangria del modelo (revision independiente)', () => {
    const original = [
      '    def resumen(self):',
      '        total = 0',
      '        for n in self.notas:',
      '            total += n',
      '        promedio = total / len(self.notas)',
      '        return promedio',
    ].join('\n');
    const model = [
      'def resumen(self):',
      '    total = 0',
      '    # ... resto igual',
      '    promedio = total / len(self.notas)',
      '    return round(promedio, 2)',
    ].join('\n');
    const expanded = expandElisions(model, original);
    assert.equal(expanded, [
      'def resumen(self):',
      '    total = 0',
      '    for n in self.notas:',
      '        total += n',
      '    promedio = total / len(self.notas)',
      '    return round(promedio, 2)',
    ].join('\n'));
    // Y al aplicarlo sobre el bloque (sangria 4) queda Python valido.
    assert.equal(reindentCode(expanded!, '    ', '    ').split('\n')[3], '            total += n');
  });

  it('una linea alineada bajo un parentesis no dobla la sangria de las lineas traidas (segunda revision)', () => {
    const original = [
      '    def total(self):',
      '        resultado = sumar(self.a,',
      '                          self.b)',
      '        if resultado > 0:',
      '            print(resultado)',
      '        return resultado',
    ].join('\n');
    const expanded = expandElisions('def total(self):\n    # ... resto igual\n    return resultado', original);
    assert.equal(expanded, [
      'def total(self):',
      '    resultado = sumar(self.a,',
      '                      self.b)',
      '    if resultado > 0:',
      '        print(resultado)',
      '    return resultado',
    ].join('\n'));
  });

  it('una linea cambiada dentro de un if, su "}" y el resumen se completan (segunda revision)', () => {
    const block = 'void f() {\n    if (a) {\n        x();\n    }\n    y();\n    z();\n}';
    const expanded = expandElisions('void f() {\n    if (a) {\n        x2();\n    }\n    // ...\n    z();\n}', block);
    assert.equal(expanded, 'void f() {\n    if (a) {\n        x2();\n    }\n    y();\n    z();\n}');
  });

  it('prepareSuggestionCode completa en un reemplazo y avisa; sin anclas no se aplica', () => {
    const ready = prepareSuggestionCode('double area() const {\n  // ...\n  return a;\n}', { selection: ORIGINAL, mode: 'replace', language: 'cpp' });
    assert.equal(ready.unusable, false);
    assert.deepEqual(ready.notes, [ELISION_EXPANDED_NOTE]);
    assert.match(ready.code, /double a = base \* altura;/);

    const lost = prepareSuggestionCode('void otra() {\n  // ...\n  imprimir();\n}', { selection: ORIGINAL, mode: 'replace', language: 'cpp' });
    assert.equal(lost.unusable, true);
    assert.equal(lost.unusableReason, ELISION_UNUSABLE_REASON);
  });
});

describe('codigo para insertar (revision independiente, 0.0.35)', () => {
  it('Python: un "return" escrito al nivel de la funcion no se mete en el ciclo de arriba', () => {
    const placed = placeInsertedCode('    prom = total / len(notas)\n    return prom', {
      unit: '    ', targetIndent: '        ', maxIndent: '        ', semantic: true,
    });
    assert.equal(placed, '    prom = total / len(notas)\n    return prom');
  });

  it('Python: codigo de nivel superior al final del archivo queda al margen', () => {
    const placed = placeInsertedCode('notas = [3, 4, 5]\nprint(promedio(notas))', {
      unit: '    ', targetIndent: '', maxIndent: '    ', semantic: true,
    });
    assert.equal(placed, 'notas = [3, 4, 5]\nprint(promedio(notas))');
  });

  it('Python: un fragmento que anida y vuelve conserva sus niveles', () => {
    const placed = placeInsertedCode('        if n > 10:\n            mayores += 1\n    return total', {
      unit: '    ', targetIndent: '        ', maxIndent: '        ', semantic: true,
    });
    assert.equal(placed, '        if n > 10:\n            mayores += 1\n    return total');
  });

  it('Python: una sangria mas profunda que la valida se lleva al lugar; la unidad se convierte', () => {
    assert.equal(placeInsertedCode('            x = 1', { unit: '    ', targetIndent: '    ', maxIndent: '    ', semantic: true }), '    x = 1');
    assert.equal(placeInsertedCode('    if x:\n        y = 1', { unit: '  ', targetIndent: '  ', maxIndent: '  ', semantic: true }), '  if x:\n    y = 1');
    assert.equal(convertIndentStyle('    a\n        b', '\t'), '\ta\n\t\tb');
  });

  it('con llaves manda el lugar: el fragmento se lleva a la sangria de donde se inserta', () => {
    assert.equal(placeInsertedCode('    cout << total;', { unit: '    ', targetIndent: '        ', maxIndent: '        ', semantic: false }), '        cout << total;');
    assert.equal(placeInsertedCode('if (x) {\n  y++;\n}', { unit: '    ', targetIndent: '    ', maxIndent: '    ', semantic: false }), '    if (x) {\n        y++;\n    }');
    assert.equal(deepestIndentBelow('    for (int i = 0; i < n; i++) {', '    '), '        ');
    assert.equal(deepestIndentBelow('    total += x;', '    '), '    ');
  });
});

describe('margen numerado antes de decidir (revision independiente, 0.0.35)', () => {
  it('un TODO con margen sigue sin ser codigo y un bloque con margen se reconoce como version del bloque', () => {
    assert.equal(extractSuggestionCode('Aplicar: insert\n```cpp\n  12>|   // TODO: completa\n```'), '');
    const selection = 'double a = base * altura;\ncout << a;\nreturn a;';
    const answer = 'Aplicar: insert\n```cpp\n  12>| double a = base * altura / 2;\n  13>| cout << a;\n  14>| return a;\n```';
    const code = extractSuggestionCode(answer);
    assert.equal(code, 'double a = base * altura / 2;\ncout << a;\nreturn a;');
    assert.equal(resolveSuggestionModes({ focusText: answer, code, selection }).completionMode, 'replace', 'conserva el bloque: no se inserta duplicado');
  });
});

describe('llaves y parentesis (0.0.35)', () => {
  it('no cuenta los que van en cadenas, caracteres ni comentarios', () => {
    assert.deepEqual(bracketBalance('if (x) { cout << "}"; } // {', 'cpp'), { paren: 0, bracket: 0, brace: 0, reliable: true });
    assert.deepEqual(bracketBalance("char c = '{';", 'cpp'), { paren: 0, bracket: 0, brace: 0, reliable: true });
    assert.deepEqual(bracketBalance('print("(")  # )', 'python'), { paren: 0, bracket: 0, brace: 0, reliable: true });
    assert.equal(bracketBalance('if (x) {', 'cpp').brace, 1);
    assert.equal(bracketBalance('x', 'plaintext').reliable, false);
  });

  it('una version del bloque que deja llaves abiertas no se aplica con un clic', () => {
    const broken = '  double area() const {\n    if (base < 0) {\n      return 0;\n    double a = base * altura;\n    return a;\n  }';
    const result = prepareSuggestionCode(broken, { selection: ORIGINAL, mode: 'replace', language: 'cpp' });
    assert.equal(result.unusable, true);
    assert.equal(result.unusableReason, UNBALANCED_REASON);
    const fine = prepareSuggestionCode(ORIGINAL.replace('cout << a;', 'cout << a << endl;'), { selection: ORIGINAL, mode: 'replace', language: 'cpp' });
    assert.equal(fine.unusable, false);
    assert.deepEqual(fine.notes, []);
  });

  it('si el bloque seleccionado ya estaba incompleto, su version tampoco se bloquea', () => {
    const partial = '  double area() const {\n    return base * altura;';
    const result = prepareSuggestionCode('  double area() const {\n    return base * altura / 2;', { selection: partial, mode: 'replace', language: 'cpp' });
    assert.equal(result.unusable, false);
  });

  it('al insertar solo avisa', () => {
    const result = prepareSuggestionCode('if (total > 0) {\n  cout << total;', { mode: 'insert', language: 'cpp' });
    assert.equal(result.unusable, false);
    assert.equal(result.notes.length, 1);
  });
});
