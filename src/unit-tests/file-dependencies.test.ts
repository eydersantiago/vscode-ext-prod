// Pruebas del cuadro «Dependencias»: lectura de los imports, estructura y resumen para el tutor.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { declaredNames, formatDependenciesForPrompt } from '../file-dependencies';
import { dependencyFamily, parseImports } from '../dependency-parse';
import { maskSource } from '../dependency-source-mask';

describe('dependencias: lectura de los imports (0.0.36)', () => {
  it('C++: #include con comillas y con < >, sin los comentados', () => {
    const imports = parseImports([
      '#include <iostream>',
      '#include "figura.h"',
      '// #include "viejo.h"',
      '/* #include "otro.h"',
      '   #include "tampoco.h" */',
      '  #  include   "modelo/rectangulo.h"  // comentario',
    ].join('\n'), 'c');
    assert.deepEqual(imports.map((item) => [item.specifier, item.kind, item.line]), [
      ['iostream', 'angle', 1],
      ['figura.h', 'quoted', 2],
      ['modelo/rectangulo.h', 'quoted', 6],
    ]);
  });

  it('Python: import, from ... import (en varias lineas) y relativos; no lo de un docstring', () => {
    const imports = parseImports([
      '"""Modulo de figuras.',
      'import os  <- esto es texto',
      '"""',
      'import math, sys as sistema',
      'from modelo.figura import Circulo, Cuadrado as C',
      'from . import ayuda',
      'from ..comun import (',
      '    leer,',
      '    escribir,',
      ')',
      'def f():',
      '    import random  # dentro de una funcion tambien cuenta',
    ].join('\n'), 'python');
    assert.deepEqual(imports.map((item) => [item.specifier, item.kind, item.line, item.names.join(',')]), [
      ['math', 'module', 4, ''],
      ['sys', 'module', 4, ''],
      ['modelo.figura', 'module', 5, 'Circulo,Cuadrado'],
      ['.', 'relative', 6, 'ayuda'],
      ['..comun', 'relative', 7, 'leer,escribir'],
      ['random', 'module', 12, ''],
    ]);
  });

  it('Java: clases, comodines e import static', () => {
    const imports = parseImports('package app;\nimport java.util.Scanner;\nimport modelo.*;\nimport static util.Mat.cuadrado;\nimport static java.lang.Math.*;', 'java');
    assert.deepEqual(imports.map((item) => [item.specifier, item.kind, item.names.join(',')]), [
      ['java.util.Scanner', 'module', ''],
      ['modelo', 'wildcard', ''],
      ['util.Mat', 'module', 'cuadrado'],
      ['java.lang.Math', 'module', ''],
    ]);
  });

  it('JS/TS: import (tambien en varias lineas), export from, require e import(); no lo comentado ni las URL', () => {
    const imports = parseImports([
      "import fs from 'fs';",
      'import {',
      '  formato,',
      '  type Opciones,',
      "} from './util/formato';",
      "// import viejo from './viejo';",
      "const url = 'http://ejemplo.com/a'; const { leer } = require('./io');",
      "export * from './tipos';",
      "import './estilos.css';",
      "const pagina = await import('./pagina.js');",
    ].join('\n'), 'js');
    assert.deepEqual(imports.map((item) => [item.specifier, item.kind, item.line, item.names.join(',')]), [
      ['fs', 'module', 1, 'fs'],
      ['./util/formato', 'relative', 5, 'formato,Opciones'],
      ['./io', 'relative', 7, 'leer'],
      ['./tipos', 'relative', 8, ''],
      ['./estilos.css', 'relative', 9, ''],
      ['./pagina.js', 'relative', 10, ''],
    ]);
  });

  it('los comentarios se borran sin mover las lineas', () => {
    const text = 'a = 1 # nota\n"""doc\nimport os\n"""\nb = "x#y"';
    const masked = maskSource(text, 'python', false);
    assert.equal(masked.split('\n').length, text.split('\n').length);
    assert.equal(masked.length, text.length);
    assert.match(masked, /b = "x#y"/, 'un # dentro de una cadena no es comentario');
    assert.doesNotMatch(masked, /import os|nota/);
  });
});

describe('estructura y resumen para el tutor (0.0.36)', () => {
  it('saca clases y funciones de la estructura, sin destructores ni operadores', () => {
    const names = declaredNames('1: class Figura {\n3:   virtual double area() const = 0;\n4:   virtual ~Figura() {}\n5:   bool operator==(const Figura& o) const;\n9: int main() {\n12: def calcular(self):');
    assert.deepEqual([...names.entries()], [['Figura', 'type'], ['area', 'function'], ['calcular', 'function']]);
  });

  it('la linea del resumen lleva lo del proyecto, las bibliotecas y quien lo usa, no lo que falta', () => {
    const line = formatDependenciesForPrompt({
      family: 'c',
      local: [{ label: 'figura.h', line: 2, path: 'src/figura.h', symbols: ['Figura', 'area()'] }],
      libraries: [{ label: 'iostream', line: 1 }, { label: 'vector', line: 3 }],
      missing: [{ label: 'lista.tpp', line: 4 }],
      dependents: [{ label: 'main.cpp', line: 1, path: 'src/main.cpp' }],
      probes: [], expectedPaths: [],
    });
    assert.equal(line, 'Dependencias del archivo: usa del proyecto src/figura.h (Figura, area()); bibliotecas iostream, vector; lo usan src/main.cpp.');
    assert.equal(formatDependenciesForPrompt({ family: 'c', local: [], libraries: [], missing: [{ label: 'x.h', line: 1 }], dependents: [], probes: [], expectedPaths: [] }), '');
    assert.equal(formatDependenciesForPrompt(null), '');
  });

  it('familias por lenguaje o extension', () => {
    assert.equal(dependencyFamily('cpp', 'a.h'), 'c');
    assert.equal(dependencyFamily('plaintext', 'lista.tpp'), 'c');
    assert.equal(dependencyFamily('typescriptreact', 'x.tsx'), 'js');
    assert.equal(dependencyFamily('', 'App.java'), 'java');
    assert.equal(dependencyFamily('markdown', 'README.md'), 'none');
    assert.equal(dependencyFamily('json', 'datos.json'), 'none');
  });
});

describe('resumen para el tutor: paquetes por su nombre (0.0.36)', () => {
  it('«usa del proyecto modelo.*», no el primer archivo del paquete', () => {
    const line = formatDependenciesForPrompt({
      family: 'java',
      local: [{ label: 'modelo.*', line: 2, path: 'src/modelo/Figura.java', description: '2 clase(s) de tu proyecto' }],
      libraries: [{ label: 'java.util.Scanner', line: 1 }],
      missing: [],
      dependents: [],
      probes: [],
      expectedPaths: [],
    });
    assert.equal(line, 'Dependencias del archivo: usa del proyecto modelo.*; bibliotecas java.util.Scanner.');
  });
});

describe('JS: una division no se confunde con una expresion regular (0.0.36)', () => {
  it('a / b y una ruta con / en una cadena no tapan los imports de abajo', () => {
    const text = [
      "const mitad = total / 2 / 3; const ruta = 'a/b/c';",
      "const k = (x) / y; return /'/.test(z);",
      "import { f } from './f';",
    ].join('\n');
    assert.deepEqual(parseImports(text, 'js').map((item) => [item.specifier, item.line]), [['./f', 3]]);
  });
});
