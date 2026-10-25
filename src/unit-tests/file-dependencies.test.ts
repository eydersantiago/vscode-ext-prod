import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  collectNamespaces,
  collectTypeReferences,
  declaredNames,
  dependencyFamily,
  formatDependenciesForPrompt,
  maskSource,
  parseImports,
  resolveFileDependencies,
} from '../file-dependencies';
import type { DependencyIndexFile } from '../file-dependencies';

// Cuadro «Dependencias» de la vista «Este archivo» (0.0.36, pedido del 25/10/2026).

function indexFile(path: string, text: string, language: string, outline = ''): DependencyIndexFile {
  const family = dependencyFamily(language, path);
  return {
    path,
    language,
    outline,
    imports: parseImports(text, family),
    typeRefs: collectTypeReferences(text, family),
    namespaces: collectNamespaces(text, family),
  };
}

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
    assert.deepEqual(deps.libraries.map((item) => [item.label, item.description]), [['GL/glut.h', 'biblioteca del sistema o externa']]);
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

describe('revision independiente del cuadro (0.0.36)', () => {
  it('un paquete instalado en un virtualenv no es «de tu proyecto» ni «tapa» nada', () => {
    const files = [
      indexFile('.venv/lib/python3.11/site-packages/numpy/__init__.py', '', 'python'),
      indexFile('venv/Lib/site-packages/six.py', '', 'python'),
      indexFile('main.py', 'import numpy', 'python'),
    ];
    const deps = resolveFileDependencies({ activePath: 'main.py', language: 'python', text: 'import numpy\nimport six', files });
    assert.deepEqual(deps.local, []);
    assert.deepEqual(deps.libraries.map((item) => [item.label, item.warning]), [['numpy', undefined], ['six', undefined]]);
  });

  it('C++: un .h que solo esta en otra carpeta no se encuentra (y dice donde esta)', () => {
    const files = [indexFile('taller1/figura.h', 'class Figura {};', 'cpp', '1: class Figura {')];
    const deps = resolveFileDependencies({ activePath: 'taller2/main.cpp', language: 'cpp', text: '#include "figura.h"', files });
    assert.deepEqual(deps.local, []);
    assert.equal(deps.missing[0].hint, 'Está en «taller1/figura.h»: escribe #include "../taller1/figura.h".');
    assert.deepEqual(deps.expectedPaths, ['taller2/figura.h'], 'primero se mira junto al archivo en el disco');
    const prompt = formatDependenciesForPrompt(deps);
    assert.doesNotMatch(prompt, /taller1/, 'el tutor no recibe un archivo que el compilador no ve');
  });

  it('C++: include/ de la carpeta o de una de arriba vale; una carpeta de arriba, con aviso', () => {
    const files = [
      indexFile('proyecto/include/lista.h', '', 'cpp'),
      indexFile('proyecto/comun.h', '', 'cpp'),
    ];
    const deps = resolveFileDependencies({ activePath: 'proyecto/src/main.cpp', language: 'cpp', text: '#include "lista.h"\n#include "comun.h"', files });
    assert.deepEqual(deps.local.map((item) => [item.path, item.warning]), [
      ['proyecto/include/lista.h', undefined],
      ['proyecto/comun.h', 'Está en una carpeta de arriba: escribe #include "../comun.h" o compila con -I.'],
    ]);
  });

  it('Python: un modulo de otra carpeta no se importa; la raiz y src/ si', () => {
    const files = [
      indexFile('tarea1/utilidades.py', 'def leer(): pass', 'python', '1: def leer():'),
      indexFile('comun.py', '', 'python'),
      indexFile('src/datos.py', '', 'python'),
    ];
    const deps = resolveFileDependencies({ activePath: 'tarea2/main.py', language: 'python', text: 'import utilidades\nimport comun\nimport datos', files });
    assert.deepEqual(deps.local.map((item) => item.path), ['comun.py', 'src/datos.py']);
    assert.deepEqual(deps.missing.map((item) => [item.label, item.hint]), [['utilidades', 'Está en «tarea1/utilidades.py»: Python solo lo encuentra junto al archivo que ejecutas.']]);
  });

  it('Python: un paquete sin __init__.py (una carpeta) es del proyecto', () => {
    const files = [indexFile('tarea/modelo/figura.py', '', 'python')];
    const deps = resolveFileDependencies({ activePath: 'tarea/main.py', language: 'python', text: 'import modelo', files });
    assert.deepEqual(deps.local.map((item) => [item.label, item.path, item.description]), [['modelo', 'tarea/modelo/figura.py', 'paquete de tu proyecto (carpeta)']]);
  });

  it('Ruby: require de un archivo de la misma carpeta pide require_relative; lib/ vale', () => {
    const files = [indexFile('figura.rb', '', 'ruby'), indexFile('lib/util.rb', '', 'ruby'), indexFile('otra/cosa.rb', '', 'ruby')];
    const deps = resolveFileDependencies({ activePath: 'main.rb', language: 'ruby', text: "require 'figura'\nrequire 'util'\nrequire 'cosa'", files });
    assert.deepEqual(deps.local.map((item) => [item.path, item.warning]), [
      ['figura.rb', "require no busca en esta carpeta: usa require_relative 'figura'."],
      ['lib/util.rb', undefined],
    ]);
    assert.deepEqual(deps.libraries.map((item) => item.label), ['cosa'], 'en otra carpeta: una gema, no un archivo tuyo');
  });

  it('JS: nada dentro de cadenas, plantillas o expresiones regulares cuenta como import', () => {
    const text = [
      "const plantilla = `",
      "import x from './no-existe';",
      "const y = require('lodash');",
      "`;",
      'console.log("usa require(\'fs\') o import(\'./plugin\')");',
      "const limpio = s.replace(/^\\/*/, '');",
      "const otro = /['\"]/.test(s);",
      "import fs from 'fs';",
      "import { util } from './util';",
    ].join('\n');
    const imports = parseImports(text, 'js');
    assert.deepEqual(imports.map((item) => [item.specifier, item.line]), [['fs', 8], ['./util', 9]]);
  });

  it('JS: sin extension escrita solo valen modulos de codigo; una hoja de estilos se importa con su extension', () => {
    const files = [indexFile('src/util.css', '', 'css'), indexFile('src/estilos.css', '', 'css')];
    const deps = resolveFileDependencies({ activePath: 'src/app.js', language: 'javascript', text: "import { f } from './util';\nimport './estilos.css';", files });
    assert.deepEqual(deps.local.map((item) => item.path), ['src/estilos.css']);
    assert.deepEqual(deps.missing.map((item) => item.label), ['./util']);
  });

  it('barras de Windows en una ruta: se encuentra, pero avisa que en Linux no funciona', () => {
    const files = [indexFile('src/modelo/figura.h', '', 'cpp'), indexFile('src/util/formato.js', '', 'javascript')];
    const cpp = resolveFileDependencies({ activePath: 'src/main.cpp', language: 'cpp', text: '#include "modelo\\figura.h"', files });
    assert.equal(cpp.local[0].warning, 'En Linux usa / en la ruta: #include "modelo/figura.h".');
    const js = resolveFileDependencies({ activePath: 'src/app.js', language: 'javascript', text: "import f from '.\\\\util\\\\formato';", files });
    assert.equal(js.local[0].path, 'src/util/formato.js');
    assert.equal(js.local[0].warning, "En Linux usa / en la ruta: './util/formato'.");
  });

  it('el «¿Quisiste decir?» de un .h no apunta a un .cpp', () => {
    const files = [indexFile('src/lista.cpp', '', 'cpp'), indexFile('src/listas.h', '', 'cpp')];
    const deps = resolveFileDependencies({ activePath: 'src/main.cpp', language: 'cpp', text: '#include "lista.h"', files });
    assert.equal(deps.missing[0].hint, '¿Quisiste decir «src/listas.h»?');
  });

  it('C/C++: comentario que sigue con \\, #if 0, cadenas crudas y separadores de digitos', () => {
    const text = [
      '// comentario que sigue \\',
      '#include "fantasma1.h"',
      '#if 0',
      '#include "fantasma2.h"',
      '#else',
      '#include "real1.h"',
      '#endif',
      'const char* s = R"(',
      '#include "fantasma3.h"',
      ')";',
      'int millon = 1\'000\'000; /* comentario',
      '#include "fantasma4.h" */',
      '#include "real2.h"',
    ].join('\n');
    assert.deepEqual(parseImports(text, 'c').map((item) => [item.specifier, item.line]), [['real1.h', 6], ['real2.h', 13]]);
  });

  it('Python: un ";" dentro de una cadena no parte la linea; Java lee todos los imports de una linea', () => {
    assert.deepEqual(parseImports('print("paso 1; import os, sys")\nx = 1; import json', 'python').map((item) => item.specifier), ['json']);
    assert.deepEqual(parseImports('import java.util.Scanner; import java.util.ArrayList;\nclass A {}', 'java').map((item) => [item.specifier, item.line]), [
      ['java.util.Scanner', 1],
      ['java.util.ArrayList', 1],
    ]);
  });

  it('el mismo archivo escrito de dos formas va una vez', () => {
    const files = [indexFile('src/figura.h', '', 'cpp')];
    const deps = resolveFileDependencies({ activePath: 'src/main.cpp', language: 'cpp', text: '#include "figura.h"\n#include "./figura.h"\n#include "../src/figura.h"', files });
    assert.deepEqual(deps.local.map((item) => [item.label, item.line]), [['figura.h', 1]]);
  });

  it('C#: espacios de nombres anidados; Java: el mismo paquete en otra carpeta de fuentes', () => {
    assert.deepEqual(collectNamespaces('namespace Taller {\n  namespace Modelo {\n    class Figura {}\n  }\n}\nnamespace Otro.Cosa { }', 'csharp'), ['Taller', 'Taller.Modelo', 'Otro.Cosa']);
    const javaFiles = [
      { ...indexFile('src/main/java/com/uni/Figura.java', 'package com.uni;\npublic class Figura {}', 'java'), javaPackage: 'com.uni' },
      { ...indexFile('src/test/java/com/uni/FiguraTest.java', 'package com.uni;\nclass FiguraTest { Figura f; }', 'java'), javaPackage: 'com.uni' },
    ];
    const test = resolveFileDependencies({ activePath: 'src/test/java/com/uni/FiguraTest.java', language: 'java', text: 'package com.uni;\nclass FiguraTest { Figura f; }', files: javaFiles });
    assert.deepEqual(test.local.map((item) => [item.path, !!item.implicit]), [['src/main/java/com/uni/Figura.java', true]]);
    const figura = resolveFileDependencies({ activePath: 'src/main/java/com/uni/Figura.java', language: 'java', text: 'package com.uni;\npublic class Figura {}', files: javaFiles });
    assert.deepEqual(figura.dependents.map((item) => item.path), ['src/test/java/com/uni/FiguraTest.java']);
  });

  it('un modulo de Python que no se encontro queda marcado como supuesto', () => {
    const deps = resolveFileDependencies({ activePath: 'main.py', language: 'python', text: 'import paquete_raro\nimport math', files: [] });
    assert.deepEqual(deps.libraries.map((item) => [item.label, !!item.guessed]), [['paquete_raro', true], ['math', false]]);
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

