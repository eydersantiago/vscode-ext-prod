// Pruebas del cuadro «Dependencias» por lenguaje (C++, Python, Java, JS/TS, Ruby, C#) y errores clasicos.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { resolveFileDependencies } from '../file-dependencies';
import { indexFile } from './file-dependencies-fixtures';

describe('dependencias de un archivo C++ (0.0.36)', () => {
  const files = [
    indexFile('src/main.cpp', '#include "figura.h"\n#include "modelo/rectangulo.h"\nint main() { Figura* f; }', 'cpp'),
    indexFile('src/figura.h', 'class Figura {\npublic:\n  virtual double area() const = 0;\n};', 'cpp',
      '1: class Figura {\n2: public:\n3:   virtual double area() const = 0;'),
    indexFile('src/modelo/rectangulo.h', '#include "../figura.h"\nclass Rectangulo : public Figura {};', 'cpp', '2: class Rectangulo : public Figura {'),
    indexFile('src/circulo.h', 'class Circulo {};', 'cpp', '1: class Circulo {'),
    indexFile('README.md', '# Taller', 'markdown'),
  ];
  const main = [
    '#include <iostream>',
    '#include <conio.h>',
    '#include "figura.h"',
    '#include "modelo/rectangulo.h"',
    '#include "Circulo.h"',
    '#include "figuras.h"',
    '#include "lista.tpp"',
    '#include "../../fuera.h"',
    '#include "figura.h"',
    'int main() {',
    '  Figura* f = nullptr;',
    '  std::cout << f->area();',
    '}',
  ].join('\n');

  it('separa lo del proyecto, las bibliotecas y lo que no se encontro', () => {
    const deps = resolveFileDependencies({ activePath: 'src/main.cpp', language: 'cpp', text: main, files });
    assert.equal(deps.family, 'c');
    assert.deepEqual(deps.local.map((item) => [item.label, item.path, item.line]), [
      ['figura.h', 'src/figura.h', 3],
      ['modelo/rectangulo.h', 'src/modelo/rectangulo.h', 4],
      ['Circulo.h', 'src/circulo.h', 5],
    ], 'un #include repetido cuenta una vez');
    assert.deepEqual(deps.local[0].symbols, ['Figura', 'area()'], 'lo que usa de figura.h');
    assert.equal(deps.local[2].warning, 'Se llama «circulo.h»: en Linux las mayúsculas cuentan.');
    assert.deepEqual(deps.libraries.map((item) => item.label), ['iostream', 'conio.h']);
    assert.match(deps.libraries[0].description || '', /cin, cout/);
    assert.match(deps.libraries[1].warning || '', /en Linux no compila/);
    assert.deepEqual(deps.missing.map((item) => [item.label, item.line]), [['figuras.h', 6], ['lista.tpp', 7], ['../../fuera.h', 8]]);
    assert.equal(deps.missing[0].hint, '¿Quisiste decir «src/figura.h»?');
    assert.match(deps.missing[2].description || '', /sale de la carpeta abierta/);
    assert.deepEqual(deps.probes, ['figuras.h', 'lista.tpp'], 'se buscan en el disco antes de darlos por perdidos');
  });

  it('lo que encontro la busqueda en el disco pasa a ser del proyecto', () => {
    const deps = resolveFileDependencies({ activePath: 'src/main.cpp', language: 'cpp', text: main, files, extraPaths: ['src/lista.tpp'] });
    assert.ok(deps.local.some((item) => item.path === 'src/lista.tpp'));
    assert.ok(!deps.missing.some((item) => item.label === 'lista.tpp'));
  });

  it('«La usan»: los archivos que lo incluyen, con la linea del #include', () => {
    const deps = resolveFileDependencies({ activePath: 'src/figura.h', language: 'cpp', text: 'class Figura {};', files });
    assert.deepEqual(deps.dependents.map((item) => [item.label, item.path, item.line]), [
      ['main.cpp', 'src/main.cpp', 1],
      ['rectangulo.h', 'src/modelo/rectangulo.h', 1],
    ]);
    assert.deepEqual(deps.local, []);
  });

  it('«La usan» funciona aunque el indice no tenga el archivo activo (recien creado o proyecto grande)', () => {
    const deps = resolveFileDependencies({
      activePath: 'src/nuevo.h',
      language: 'cpp',
      text: 'class Nuevo {};',
      files: [indexFile('src/main.cpp', '#include "nuevo.h"', 'cpp')],
    });
    assert.deepEqual(deps.dependents.map((item) => item.path), ['src/main.cpp']);
  });

  it('un archivo tuyo con < > se encuentra, con el aviso de usar comillas', () => {
    const deps = resolveFileDependencies({ activePath: 'src/main.cpp', language: 'cpp', text: '#include <figura.h>\n#include <GL/glut.h>', files });
    assert.equal(deps.local[0].path, 'src/figura.h');
    assert.equal(deps.local[0].warning, 'Es tuyo: inclúyelo con comillas, #include "figura.h".');
    assert.deepEqual(deps.libraries.map((item) => [item.label, item.description]), [['GL/glut.h', 'gráficos (OpenGL)']]);
  });
});

describe('dependencias de un archivo Python (0.0.36)', () => {
  const files = [
    indexFile('tarea/main.py', 'from modelo.figura import Circulo\nimport utilidades', 'python'),
    indexFile('tarea/utilidades.py', 'def leer():\n    pass', 'python', '1: def leer():'),
    indexFile('tarea/ayuda.py', '', 'python'),
    indexFile('tarea/modelo/__init__.py', '', 'python'),
    indexFile('tarea/modelo/figura.py', 'class Circulo:\n    pass', 'python', '1: class Circulo:'),
  ];

  it('modulos del proyecto, de Python y externos; los errores de tipeo con su sugerencia', () => {
    const text = [
      'import math',
      'import numpy as np',
      'from modelo.figura import Circulo',
      'import utilidades',
      'from . import ayuda',
      'import maths',
      'import utilidad',
      'import paquete_raro',
      'utilidades.leer()',
    ].join('\n');
    const deps = resolveFileDependencies({ activePath: 'tarea/main.py', language: 'python', text, files });
    assert.deepEqual(deps.local.map((item) => [item.label, item.path, (item.symbols || []).join(',')]), [
      ['modelo.figura', 'tarea/modelo/figura.py', 'Circulo'],
      ['utilidades', 'tarea/utilidades.py', 'leer()'],
      ['.ayuda', 'tarea/ayuda.py', ''],
    ]);
    assert.deepEqual(deps.libraries.map((item) => [item.label, item.description]), [
      ['math', 'funciones matemáticas (sqrt, pi, floor)'],
      ['numpy', 'cálculo con arreglos (paquete externo)'],
      ['paquete_raro', 'paquete externo: si Python no lo encuentra, instálalo con pip'],
    ]);
    assert.deepEqual(deps.missing.map((item) => [item.label, item.hint]), [
      ['maths', '¿Quisiste decir «math»?'],
      ['utilidad', '¿Quisiste decir «tarea/utilidades.py»?'],
    ]);
    assert.ok(deps.probes.includes('paquete_raro.py'), 'un modulo desconocido se busca en el disco por si es tuyo');
  });

  it('«La usan» en Python', () => {
    const deps = resolveFileDependencies({ activePath: 'tarea/modelo/figura.py', language: 'python', text: 'class Circulo:\n    pass', files });
    assert.deepEqual(deps.dependents.map((item) => item.path), ['tarea/main.py']);
  });
});

describe('dependencias de un archivo Java (0.0.36)', () => {
  const files = [
    indexFile('src/App.java', 'public class App {\n  public static void main(String[] a) {\n    Utilidades.leer();\n  }\n}', 'java'),
    indexFile('src/Utilidades.java', 'public class Utilidades {}', 'java', '1: public class Utilidades {'),
    indexFile('src/Ventana.java', 'public class Ventana {}', 'java'),
    indexFile('src/modelo/Figura.java', 'package modelo;\npublic abstract class Figura {}', 'java', '2: public abstract class Figura {'),
    indexFile('src/modelo/Circulo.java', 'package modelo;\npublic class Circulo extends Figura {}', 'java'),
  ];

  it('bibliotecas, paquetes del proyecto (con comodin) y clases del mismo paquete sin import', () => {
    const text = [
      'import java.util.Scanner;',
      'import modelo.*;',
      'import vista.Ventana;',
      'import vista.Menu;',
      'public class App {',
      '  public static void main(String[] args) {',
      '    Circulo c = new Circulo();',
      '    Utilidades.leer();',
      '  }',
      '}',
    ].join('\n');
    const deps = resolveFileDependencies({ activePath: 'src/App.java', language: 'java', text, files });
    assert.deepEqual(deps.libraries.map((item) => [item.label, item.description]), [['java.util.Scanner', 'leer datos del teclado']]);
    assert.deepEqual(deps.local.map((item) => [item.label, item.path, item.line, !!item.implicit]), [
      ['modelo.Circulo', 'src/modelo/Circulo.java', 2, false],
      ['Utilidades', 'src/Utilidades.java', 8, true],
    ]);
    assert.deepEqual(deps.missing.map((item) => [item.label, item.hint || '']), [
      ['vista.Ventana', 'Está en «src/Ventana.java»: revisa su línea package o el import.'],
      ['vista.Menu', ''],
    ]);
    assert.deepEqual(deps.probes, ['Menu.java']);
  });

  it('«La usan»: tambien una clase del mismo paquete que la usa sin import', () => {
    const deps = resolveFileDependencies({ activePath: 'src/Utilidades.java', language: 'java', text: 'public class Utilidades {}', files });
    assert.deepEqual(deps.dependents.map((item) => [item.path, item.line, !!item.implicit]), [['src/App.java', 0, true]]);
  });

  it('con pom.xml, un paquete que no esta en el proyecto es una dependencia de Maven', () => {
    const deps = resolveFileDependencies({ activePath: 'src/App.java', language: 'java', text: 'import com.empresa.Cliente;', files: [...files, { path: 'pom.xml' }] });
    assert.deepEqual(deps.libraries.map((item) => item.description), ['dependencia del proyecto (Maven o Gradle)']);
  });
});

describe('dependencias de un archivo JS/TS (0.0.36)', () => {
  const files = [
    indexFile('src/util/formato.js', 'export function formato(x) { return x; }', 'javascript', '1: export function formato(x) {'),
    indexFile('src/componentes/boton.jsx', 'export default function Boton() {}', 'javascriptreact'),
    indexFile('src/estilos.css', 'body {}', 'css'),
    indexFile('src/modelo.ts', 'export class Modelo {}', 'typescript', '1: export class Modelo {'),
    indexFile('src/app.js', "import { formato } from './util/formato';\nimport './estilos.css';", 'javascript'),
  ];

  it('rutas relativas con o sin extension, paquetes de npm y modulos de Node', () => {
    const text = [
      "import fs from 'node:fs';",
      "import path from 'path';",
      "import { formato } from './util/formato';",
      "import Boton from './componentes/Boton';",
      "import { Modelo } from './modelo.js';",
      "import './estilos.css';",
      "const express = require('express');",
      "import nada from './no-existe';",
    ].join('\n');
    const deps = resolveFileDependencies({ activePath: 'src/app.js', language: 'javascript', text, files });
    assert.deepEqual(deps.local.map((item) => [item.label, item.path, (item.symbols || []).join(',')]), [
      ['./util/formato', 'src/util/formato.js', 'formato'],
      ['./componentes/Boton', 'src/componentes/boton.jsx', 'Boton'],
      ['./modelo.js', 'src/modelo.ts', 'Modelo'],
      ['./estilos.css', 'src/estilos.css', ''],
    ]);
    assert.match(deps.local[1].warning || '', /Se llama «boton\.jsx»/);
    assert.deepEqual(deps.libraries.map((item) => [item.label, item.description]), [
      ['node:fs', 'archivos (Node.js)'],
      ['path', 'rutas de archivos (Node.js)'],
      ['express', 'servidor web (paquete de npm)'],
    ]);
    assert.deepEqual(deps.missing.map((item) => item.label), ['./no-existe']);
    assert.deepEqual(deps.probes, ['no-existe.*']);
  });

  it('una hoja de estilos sabe quien la importa aunque no tenga imports propios', () => {
    const deps = resolveFileDependencies({ activePath: 'src/estilos.css', language: 'css', text: 'body {}', files });
    assert.equal(deps.family, 'none');
    assert.deepEqual(deps.dependents.map((item) => [item.path, item.line]), [['src/app.js', 2]]);
  });
});

describe('dependencias en Ruby y C# (0.0.36)', () => {
  it('Ruby: require_relative al proyecto y require a la biblioteca', () => {
    const files = [indexFile('lib/figura.rb', 'class Figura\nend', 'ruby', '1: class Figura')];
    const deps = resolveFileDependencies({
      activePath: 'main.rb',
      language: 'ruby',
      text: "require 'json'\nrequire_relative 'lib/figura'\nrequire_relative 'lib/nada'\nFigura.new",
      files,
    });
    assert.deepEqual(deps.local.map((item) => [item.path, (item.symbols || []).join(',')]), [['lib/figura.rb', 'Figura']]);
    assert.deepEqual(deps.libraries.map((item) => [item.label, item.description]), [['json', 'leer y escribir JSON']]);
    assert.deepEqual(deps.missing.map((item) => item.label), ['lib/nada']);
  });

  it('C#: using de .NET, espacios de nombres del proyecto y clases usadas sin using', () => {
    const files = [
      indexFile('Modelo/Figura.cs', 'namespace Taller.Modelo {\n  public class Figura {}\n}', 'csharp', '1: namespace Taller.Modelo {\n2:   public class Figura {'),
      indexFile('Servicios/Calculadora.cs', 'public class Calculadora {}', 'csharp'),
    ];
    const deps = resolveFileDependencies({
      activePath: 'Program.cs',
      language: 'csharp',
      text: 'using System;\nusing Taller.Modelo;\nclass Program {\n  static void Main() {\n    var c = new Calculadora();\n  }\n}',
      files,
    });
    assert.deepEqual(deps.libraries.map((item) => [item.label, item.description]), [['System', 'consola, Math y tipos básicos']]);
    assert.deepEqual(deps.local.map((item) => [item.label, item.path, item.line, !!item.implicit]), [
      ['Taller.Modelo', 'Modelo/Figura.cs', 2, false],
      ['Calculadora', 'Servicios/Calculadora.cs', 5, true],
    ]);
  });
});

describe('errores clasicos que el cuadro avisa (0.0.36)', () => {
  it('Python: un archivo propio con el nombre de un modulo de Python lo tapa', () => {
    const files = [indexFile('tarea/random.py', 'def numero():\n    return 4', 'python', '1: def numero():')];
    const deps = resolveFileDependencies({ activePath: 'tarea/main.py', language: 'python', text: 'import random\nprint(random.randint(1, 6))', files });
    assert.equal(deps.local[0].path, 'tarea/random.py');
    assert.equal(deps.local[0].warning, 'Tapa el módulo «random» de Python: si querías ese, cámbiale el nombre.');
    const own = resolveFileDependencies({ activePath: 'tarea/figura.py', language: 'python', text: 'import utilidades', files: [indexFile('tarea/utilidades.py', '', 'python')] });
    assert.equal(own.local[0].warning, undefined, 'un modulo propio con nombre propio no lleva aviso');
  });

  it('Python: turtle.py con «import turtle» se importa a si mismo', () => {
    const deps = resolveFileDependencies({ activePath: 'tarea/turtle.py', language: 'python', text: 'import turtle\nt = turtle.Turtle()', files: [indexFile('tarea/turtle.py', 'import turtle', 'python')] });
    assert.deepEqual(deps.libraries.map((item) => item.label), ['turtle']);
    assert.equal(deps.libraries[0].warning, '«import turtle» importa este mismo archivo (turtle.py), no la biblioteca: cámbiale el nombre.');
    assert.deepEqual(deps.local, []);
  });

  it('C++: incluir un .cpp y escribir un encabezado estandar con mayuscula', () => {
    const files = [indexFile('src/lista.cpp', 'int x;', 'cpp')];
    const deps = resolveFileDependencies({ activePath: 'src/main.cpp', language: 'cpp', text: '#include <Vector>\n#include "lista.cpp"', files });
    assert.equal(deps.local[0].warning, 'Incluir un .cpp suele dar «multiple definition»: incluye su .h.');
    assert.equal(deps.libraries[0].warning, 'En Linux se escribe en minúsculas: #include <vector>.');
  });

  it('C#: un espacio de nombres de archivo (namespace X;) tambien es del proyecto', () => {
    const files = [indexFile('Datos/Repositorio.cs', 'namespace Taller.Datos;\npublic class Repositorio {}', 'csharp')];
    assert.deepEqual(files[0].namespaces, ['Taller.Datos']);
    const deps = resolveFileDependencies({ activePath: 'Program.cs', language: 'csharp', text: 'using Taller.Datos;', files });
    assert.deepEqual(deps.local.map((item) => [item.label, item.path]), [['Taller.Datos', 'Datos/Repositorio.cs']]);
  });
});
