import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildCodeOutline,
  buildNumberedWindow,
  formatOtherFilesLine,
  formatRelatedDeclarations,
  selectRelatedFiles,
  sliceAroundLine,
} from '../prompt-context';

// Revision de precision del 21/10/2026 (0.0.35): el codigo que acompana cada pedido al tutor.

const FILE_300 = Array.from({ length: 300 }, (_, index) => `int v${index + 1} = ${index + 1};`).join('\n');

describe('ventana numerada alrededor del foco (0.0.35)', () => {
  it('centra la ventana en el foco aunque este en la linea 150 (antes: los primeros 7200 caracteres)', () => {
    const window = buildNumberedWindow(FILE_300, { focusStart: 150, focusEnd: 151, maxChars: 6000 });
    assert.equal(window.totalLines, 300);
    assert.ok(window.startLine < 150 && window.endLine > 151);
    assert.ok(150 - window.startLine <= 60 + 30, 'no mas de lo necesario antes del foco');
    assert.match(window.text, /^150>\| int v150 = 150;$/m);
    assert.match(window.text, /^151>\| int v151 = 151;$/m);
    assert.match(window.text, /^149 \| int v149 = 149;$/m);
    assert.ok(window.text.length <= 6000);
    assert.ok(window.endLine - window.startLine + 1 <= 160, 'tope de lineas aunque sobre espacio');
  });

  it('un archivo corto va entero; sin foco, desde el comienzo', () => {
    const small = 'int main() {\n  return 0;\n}\n';
    const window = buildNumberedWindow(small, { focusStart: 2, focusEnd: 2, maxChars: 6000 });
    assert.equal(window.text, '1 | int main() {\n2>|   return 0;\n3 | }\n4 |', 'la ultima linea vacia tambien cuenta (VS Code la numera)');
    const head = buildNumberedWindow(FILE_300, { maxChars: 400 });
    assert.equal(head.startLine, 1);
    assert.doesNotMatch(head.text, />\|/, 'sin foco no hay marcas');
  });

  it('el cursor en la linea vacia del final se marca a ella, no a la anterior (revision independiente)', () => {
    const window = buildNumberedWindow('a = 1\nb = 2\n', { focusStart: 3, focusEnd: 3, maxChars: 6000 });
    assert.equal(window.text, '1 | a = 1\n2 | b = 2\n3>|');
  });

  it('con un recorte del archivo numera con las lineas reales y no marca un foco que no esta', () => {
    const big = Array.from({ length: 2000 }, (_, index) => `linea_${index + 1} = ${index + 1}`).join('\n');
    const slice = sliceAroundLine(big, 900, 3000);
    assert.ok(slice.text.length <= 3000);
    assert.ok(slice.firstLine < 900 && slice.firstLine > 700, 'centrado en el foco');
    const window = buildNumberedWindow(slice.text, { firstLine: slice.firstLine, focusStart: 900, focusEnd: 900, maxChars: 2000 });
    assert.match(window.text, /^900>\| linea_900 = 900$/m);
    assert.ok(window.startLine >= slice.firstLine);
    const outside = buildNumberedWindow(slice.text, { firstLine: slice.firstLine, focusStart: 5, focusEnd: 5, maxChars: 2000 });
    assert.doesNotMatch(outside.text, />\|/, 'el foco fuera del recorte no se marca en otra linea');
    assert.deepEqual(sliceAroundLine('corto', 1, 3000), { text: 'corto', firstLine: 1 });
  });

  it('respeta el tope de caracteres aunque el foco sea largo', () => {
    const long = Array.from({ length: 50 }, (_, index) => `linea_${index} = "${'x'.repeat(100)}";`).join('\n');
    const window = buildNumberedWindow(long, { focusStart: 1, focusEnd: 50, maxChars: 1000 });
    assert.ok(window.text.length <= 1000);
    assert.equal(window.startLine, 1);
  });
});

const CPP = `#include <iostream>
#include "figura.h"
using namespace std;

class Rectangulo : public Figura {
  double base, altura;
public:
  Rectangulo(double b, double a) : base(b), altura(a) {}
  double area() const override;
  virtual ~Rectangulo() {}
};

double Rectangulo::area() const {
  if (base < 0) {
    return 0;
  }
  return base * altura;
}

int main() {
  Rectangulo r(2, 3);
  cout << r.area() << endl;
  auto f = [](int x) { return x; };
  return 0;
}`;

describe('estructura del archivo (0.0.35)', () => {
  it('lista clases y firmas con su numero de linea, no las llamadas ni el flujo', () => {
    const outline = buildCodeOutline(CPP, 'cpp');
    assert.match(outline, /^2: #include "figura\.h"$/m);
    assert.match(outline, /^5: class Rectangulo : public Figura \{$/m);
    assert.match(outline, /^8:   Rectangulo\(double b, double a\) : base\(b\), altura\(a\) \{\}$/m);
    assert.match(outline, /^9:   double area\(\) const override;$/m);
    assert.match(outline, /^13: double Rectangulo::area\(\) const \{$/m);
    assert.match(outline, /^20: int main\(\) \{$/m);
    assert.doesNotMatch(outline, /Rectangulo r\(2, 3\)/, 'construir un objeto no es una firma');
    assert.doesNotMatch(outline, /cout|if \(|return|\[\]/);
  });

  it('omite las lineas que ya van en la ventana y respeta el tope', () => {
    const outline = buildCodeOutline(CPP, 'cpp', { exclude: [1, 12] });
    assert.doesNotMatch(outline, /^5:/m);
    assert.match(outline, /^13:/m);
    const tight = buildCodeOutline(CPP, 'cpp', { maxChars: 80 });
    assert.match(tight, /declaracion\(es\) mas/);
  });

  it('en Python y Ruby toma clases, funciones e imports; en un encabezado, tambien atributos', () => {
    const py = buildCodeOutline('import math\n\nclass Circulo(Figura):\n    def area(self):\n        return math.pi * self.r ** 2\n', 'python');
    assert.equal(py, '1: import math\n3: class Circulo(Figura):\n4:     def area(self):');
    const rb = buildCodeOutline('class Perro < Animal\n  attr_reader :nombre\n  def ladrar\n    puts "guau"\n  end\nend', 'ruby');
    assert.equal(rb, '1: class Perro < Animal\n2:   attr_reader :nombre\n3:   def ladrar');
    const header = buildCodeOutline('class Figura {\nprotected:\n  double base;\n  int lados = 4;\npublic:\n  virtual double area() const = 0;\n};', 'cpp', { members: true });
    assert.match(header, /^3:   double base;$/m);
    assert.match(header, /^4:   int lados = 4;$/m);
    assert.match(header, /^6:   virtual double area\(\) const = 0;$/m);
  });
});

describe('archivos relacionados (0.0.35)', () => {
  const files = [
    { path: 'src/rectangulo.cpp', language: 'cpp', lines: 25, outline: '13: double Rectangulo::area() const {' },
    { path: 'src/rectangulo.h', language: 'cpp', lines: 12, outline: '3: class Rectangulo : public Figura {\n5:   double base;' },
    { path: 'src/figura.h', language: 'cpp', lines: 10, outline: '1: class Figura {\n4:   virtual double area() const = 0;' },
    { path: 'src/circulo.cpp', language: 'cpp', lines: 30, outline: '2: class Circulo {' },
    { path: 'README.md', language: 'markdown', lines: 5, outline: '' },
  ];

  it('primero el .h del mismo nombre, luego lo que incluye, luego las clases que usa', () => {
    const related = selectRelatedFiles('src/rectangulo.cpp', '#include "figura.h"\nclass Rectangulo : public Figura {};', files);
    assert.deepEqual(related.map((file) => file.path), ['src/rectangulo.h', 'src/figura.h']);
    const byType = selectRelatedFiles('src/main.cpp', 'int main() { Circulo c; }', files);
    assert.deepEqual(byType.map((file) => file.path), ['src/circulo.cpp']);
    assert.deepEqual(selectRelatedFiles('src/main.cpp', 'int main() {}', files), []);
    const js = [{ path: 'src/util/formato.js', language: 'javascript', lines: 20, outline: '1: export function formato(x) {' }];
    assert.deepEqual(selectRelatedFiles('src/app.js', "import fmt from './util/formato';\nfmt(1);", js).map((file) => file.path), ['src/util/formato.js'], 'la ruta del import, no el nombre que se le da');
    const java = [{ path: 'src/modelo/Figura.java', language: 'java', lines: 30, outline: '3: public abstract class Figura {' }];
    assert.deepEqual(selectRelatedFiles('src/App.java', 'import modelo.Figura;\npublic class App {}', java).map((file) => file.path), ['src/modelo/Figura.java'], 'import de Java con ";"');
  });

  it('formatea las declaraciones con tope y la lista corta de los demas archivos', () => {
    const text = formatRelatedDeclarations([files[1], files[2]], 1500);
    assert.match(text, /^Declaraciones de archivos relacionados/);
    assert.match(text, /src\/figura\.h:\n  1: class Figura \{/);
    assert.equal(formatRelatedDeclarations([], 1500), '');
    const line = formatOtherFilesLine(files, 'src/rectangulo.cpp', 2);
    assert.equal(line, 'Otros archivos del proyecto: src/rectangulo.h (cpp, 12 lineas), src/figura.h (cpp, 10 lineas) y 2 mas.');
    assert.equal(formatOtherFilesLine(files, 'src/nuevo.cpp', 4), 'Otros archivos del proyecto: src/rectangulo.cpp (cpp, 25 lineas), src/rectangulo.h (cpp, 12 lineas), src/figura.h (cpp, 10 lineas), src/circulo.cpp (cpp, 30 lineas) y 1 mas.', 'la cuenta no resta el archivo activo si no esta en el indice');
  });
});
