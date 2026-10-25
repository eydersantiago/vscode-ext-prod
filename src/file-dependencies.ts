// ADACEEN (VS Code): dependencias del archivo activo (0.0.36), sin importar vscode.
//
// Pedido del 25/10/2026: «que muestre un cuadro con las dependencias del archivo». La vista
// «Este archivo» muestra lo que usa el archivo activo (#include, import, require, using),
// separado en:
//   - lo que es del proyecto (se abre con un clic), con las clases y funciones que usa de ahi;
//   - las bibliotecas, con una linea de para que sirven;
//   - lo que no se encontro (el error mas comun: el nombre o la carpeta no coinciden), con el
//     archivo de nombre parecido si lo hay;
//   - los archivos del proyecto que lo usan a el.
// No compila nada: lee el texto (sin comentarios) y resuelve las rutas contra el indice del
// proyecto que ya arma la extension (workspace-index.ts). Se prueba con node:test.

export type DependencyFamily = 'c' | 'python' | 'java' | 'js' | 'ruby' | 'csharp' | 'none';

/**
 * quoted / angle: #include "x" y #include <x>. module: import a.b, using X, require 'x'.
 * relative: from .x import y, './x', require_relative. wildcard: import a.b.*; (Java).
 */
export type ImportKind = 'quoted' | 'angle' | 'module' | 'relative' | 'wildcard';

export type ParsedImport = {
  /** Como esta escrito: "figura.h", "iostream", "modelo.Figura", "./util/formato", "..utils". */
  specifier: string;
  /** Linea del archivo (1-based). */
  line: number;
  kind: ImportKind;
  /** Nombres que trae: from x import a, b / import { a } from './x' / import static ...C.m. */
  names: string[];
};

export type FileDependencyItem = {
  /** Lo que se muestra: el import tal cual (o el nombre del archivo en «La usan»). */
  label: string;
  /** Linea del import en el archivo (0: sin import, por ejemplo una clase del mismo paquete). */
  line: number;
  /** Ruta relativa del archivo del proyecto (en «Usa de tu proyecto» y «La usan»). */
  path?: string;
  description?: string;
  /** Clases y funciones de ese archivo que usa el activo. */
  symbols?: string[];
  /** Algo que conviene revisar aunque se haya encontrado (mayusculas, conio.h en Linux...). */
  warning?: string;
  /** «¿Quisiste decir ...?» en lo que no se encontro. */
  hint?: string;
  /** Sin import: clase del mismo paquete (Java) o del mismo proyecto (C#). */
  implicit?: boolean;
  /** Biblioteca supuesta (un modulo de Python que no se encontro en el proyecto). */
  guessed?: boolean;
};

export type FileDependencies = {
  family: DependencyFamily;
  local: FileDependencyItem[];
  libraries: FileDependencyItem[];
  missing: FileDependencyItem[];
  dependents: FileDependencyItem[];
  /**
   * Nombres de archivo a buscar en el disco antes de dar algo por no encontrado: el indice
   * tiene a lo sumo 90 archivos y solo algunas extensiones (un .tpp o un .hh no estan).
   */
  probes: string[];
  /** Rutas exactas donde deberia estar lo no encontrado (se comprueban antes de buscar por nombre). */
  expectedPaths: string[];
};

/** Entrada del indice del proyecto que sirve para resolver (workspace-index.ts). */
export type DependencyIndexFile = {
  path: string;
  language?: string;
  outline?: string;
  imports?: ParsedImport[];
  /** Nombres con mayuscula que usa el archivo (Java y C#: clases del mismo paquete sin import). */
  typeRefs?: string[];
  /** C#: espacios de nombres que declara (tambien los de archivo, `namespace X;`). */
  namespaces?: string[];
  /** Java: su linea package (las clases del mismo paquete se usan sin import, en cualquier carpeta). */
  javaPackage?: string;
};

export type DependencyInput = {
  /** Ruta relativa del archivo activo, con "/". */
  activePath: string;
  language: string;
  text: string;
  files: DependencyIndexFile[];
  /** Rutas que existen aunque no esten en el indice (lo que encontro la busqueda en el disco). */
  extraPaths?: string[];
  /**
   * Archivos de compilacion o de proyecto de la carpeta (CMakeLists.txt, Makefile, pom.xml,
   * build.gradle, pyproject.toml...): el indice no los tiene (no son codigo) y dicen donde
   * empieza cada proyecto.
   */
  buildFiles?: string[];
};

/** Lo que se lee de un archivo largo: los imports van arriba. */
const MAX_PARSE_CHARS = 200_000;
const MAX_ITEMS_PER_GROUP = 40;
const MAX_PROBES = 8;
const MAX_SYMBOLS = 4;
const MAX_TYPE_REFS = 500;

// ---------------------------------------------------------------------------------------------
// Bibliotecas conocidas: una linea de para que sirven (lo que un estudiante necesita saber).

const C_HEADERS: Record<string, string> = {
  iostream: 'entrada y salida por consola (cin, cout)',
  fstream: 'leer y escribir archivos',
  sstream: 'convertir texto con flujos (stringstream)',
  iomanip: 'formato de la salida (setw, setprecision)',
  istream: 'flujos de entrada',
  ostream: 'flujos de salida',
  string: 'cadenas de texto (std::string)',
  string_view: 'vistas de cadenas sin copiarlas',
  vector: 'arreglos que crecen (std::vector)',
  array: 'arreglos de tamaño fijo (std::array)',
  list: 'listas enlazadas (std::list)',
  forward_list: 'listas enlazadas simples',
  deque: 'colas dobles (std::deque)',
  map: 'diccionarios clave-valor ordenados (std::map)',
  unordered_map: 'diccionarios clave-valor con tabla hash',
  set: 'conjuntos ordenados (std::set)',
  unordered_set: 'conjuntos con tabla hash',
  stack: 'pilas (std::stack)',
  queue: 'colas y colas de prioridad',
  algorithm: 'ordenar, buscar y recorrer (sort, find, max)',
  numeric: 'sumas y acumulados (accumulate)',
  cmath: 'funciones matemáticas (sqrt, pow, sin)',
  'math.h': 'funciones matemáticas (sqrt, pow, sin)',
  cstdlib: 'utilidades generales (rand, exit, abs)',
  'stdlib.h': 'utilidades generales (rand, exit, malloc)',
  cstdio: 'entrada y salida al estilo C (printf, scanf)',
  'stdio.h': 'entrada y salida al estilo C (printf, scanf)',
  cstring: 'cadenas al estilo C (strlen, strcpy)',
  'string.h': 'cadenas al estilo C (strlen, strcpy)',
  ctime: 'fecha y hora (time)',
  'time.h': 'fecha y hora (time)',
  chrono: 'medir el tiempo',
  random: 'números aleatorios',
  memory: 'punteros inteligentes (unique_ptr, shared_ptr)',
  utility: 'pares e intercambios (pair, swap, move)',
  functional: 'funciones como valores (std::function)',
  iterator: 'iteradores',
  limits: 'límites de los tipos numéricos',
  climits: 'límites de los enteros (INT_MAX)',
  'limits.h': 'límites de los enteros (INT_MAX)',
  cfloat: 'límites de los decimales',
  exception: 'excepciones',
  stdexcept: 'excepciones estándar (runtime_error)',
  cassert: 'comprobaciones con assert',
  'assert.h': 'comprobaciones con assert',
  cctype: 'clasificar caracteres (isdigit, toupper)',
  'ctype.h': 'clasificar caracteres (isdigit, toupper)',
  cstdint: 'enteros de tamaño fijo (int32_t)',
  'stdint.h': 'enteros de tamaño fijo (int32_t)',
  'stdbool.h': 'el tipo bool en C',
  cstddef: 'tipos básicos (size_t, nullptr_t)',
  'stddef.h': 'tipos básicos (size_t)',
  tuple: 'tuplas',
  optional: 'valores que pueden faltar (std::optional)',
  variant: 'uniones seguras (std::variant)',
  thread: 'hilos de ejecución',
  mutex: 'exclusión mutua entre hilos',
  atomic: 'variables atómicas',
  bitset: 'conjuntos de bits',
  complex: 'números complejos',
  locale: 'configuración regional',
  clocale: 'configuración regional (setlocale)',
  'locale.h': 'configuración regional (setlocale)',
  typeinfo: 'información de tipos (typeid)',
  initializer_list: 'listas de inicialización',
  filesystem: 'carpetas y rutas de archivos',
  regex: 'expresiones regulares',
  'bits/stdc++.h': 'todas las bibliotecas estándar (solo GCC)',
  'unistd.h': 'llamadas del sistema POSIX (sleep, fork)',
  'pthread.h': 'hilos POSIX',
  'conio.h': 'consola de Windows (getch, clrscr)',
  'windows.h': 'funciones de Windows (Sleep, system)',
  'iostream.h': 'versión antigua de iostream',
};

const C_HEADER_WARNINGS: Record<string, string> = {
  'conio.h': 'Solo existe en Windows (Dev-C++): en Linux no compila.',
  'windows.h': 'Solo existe en Windows: en Linux no compila.',
  'iostream.h': 'Ya no existe: usa #include <iostream>.',
};

/**
 * Bibliotecas de C/C++ instaladas que se incluyen tambien con comillas (`#include "gtest/gtest.h"`
 * como en los ejemplos de GoogleTest, `#include "json.hpp"` con -I/usr/include/nlohmann en la VM
 * de editores): no son archivos que falten en el proyecto.
 */
const C_LIBRARY_HEADERS: Record<string, string> = {
  'json.hpp': 'JSON (nlohmann/json)',
  'catch.hpp': 'pruebas (Catch2)',
  'doctest.h': 'pruebas (doctest)',
  'sqlite3.h': 'base de datos SQLite',
  'raylib.h': 'juegos y gráficos (raylib)',
  'sdl.h': 'juegos y gráficos (SDL)',
  'curl.h': 'peticiones HTTP (libcurl)',
};
const C_LIBRARY_PREFIXES: Array<[string, string]> = [
  ['gtest/', 'pruebas (GoogleTest)'],
  ['gmock/', 'objetos simulados para pruebas (GoogleMock)'],
  ['nlohmann/', 'JSON (nlohmann/json)'],
  ['catch2/', 'pruebas (Catch2)'],
  ['doctest/', 'pruebas (doctest)'],
  ['curl/', 'peticiones HTTP (libcurl)'],
  ['boost/', 'biblioteca Boost'],
  ['sfml/', 'gráficos y juegos (SFML)'],
  ['sdl2/', 'juegos y gráficos (SDL)'],
  ['gl/', 'gráficos (OpenGL)'],
  ['glfw/', 'ventanas para OpenGL (GLFW)'],
  ['glm/', 'matemática para gráficos (GLM)'],
  ['eigen3/', 'álgebra lineal (Eigen)'],
  ['eigen/', 'álgebra lineal (Eigen)'],
  ['fmt/', 'formato de texto (fmt)'],
  ['spdlog/', 'mensajes de registro (spdlog)'],
  ['opencv2/', 'visión por computador (OpenCV)'],
  ['mysql/', 'base de datos MySQL'],
];

function cLibraryDescription(spec: string) {
  const lower = spec.toLowerCase();
  if (C_LIBRARY_HEADERS[lower]) {
    return C_LIBRARY_HEADERS[lower];
  }
  const prefix = C_LIBRARY_PREFIXES.find(([start]) => lower.startsWith(start));
  return prefix ? prefix[1] : '';
}

/** Modulos de la biblioteca estandar de Python (nombre de primer nivel). */
const PY_STDLIB = new Set([
  '__future__', 'abc', 'argparse', 'array', 'ast', 'asyncio', 'base64', 'bisect', 'builtins', 'calendar',
  'cmath', 'codecs', 'collections', 'colorsys', 'concurrent', 'configparser', 'contextlib', 'copy', 'cProfile',
  'csv', 'ctypes', 'curses', 'dataclasses', 'datetime', 'decimal', 'difflib', 'dis', 'doctest', 'email', 'enum',
  'errno', 'fileinput', 'fnmatch', 'fractions', 'functools', 'gc', 'getpass', 'gettext', 'glob', 'graphlib',
  'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'importlib', 'inspect', 'io', 'ipaddress', 'itertools',
  'json', 'keyword', 'linecache', 'locale', 'logging', 'lzma', 'math', 'mimetypes', 'msvcrt', 'multiprocessing',
  'numbers', 'operator', 'os', 'pathlib', 'pdb', 'pickle', 'platform', 'pprint', 'profile', 'queue', 'random',
  're', 'sched', 'secrets', 'select', 'shelve', 'shlex', 'shutil', 'signal', 'smtplib', 'socket',
  'socketserver', 'sqlite3', 'ssl', 'stat', 'statistics', 'string', 'struct', 'subprocess', 'sys', 'tempfile',
  'textwrap', 'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize', 'tomllib', 'trace', 'traceback',
  'turtle', 'types', 'typing', 'unicodedata', 'unittest', 'urllib', 'uuid', 'venv', 'warnings', 'wave',
  'weakref', 'webbrowser', 'winsound', 'xml', 'zipfile', 'zlib', 'zoneinfo',
]);

const PY_DESCRIPTIONS: Record<string, string> = {
  math: 'funciones matemáticas (sqrt, pi, floor)',
  random: 'números aleatorios',
  os: 'archivos, carpetas y variables del sistema',
  'os.path': 'rutas de archivos',
  sys: 'datos del intérprete (argv, exit)',
  time: 'pausas y medición del tiempo',
  datetime: 'fechas y horas',
  json: 'leer y escribir JSON',
  re: 'expresiones regulares',
  collections: 'estructuras extra (deque, Counter, defaultdict)',
  itertools: 'combinaciones y recorridos de iterables',
  functools: 'herramientas para funciones (reduce, lru_cache)',
  typing: 'anotaciones de tipos',
  dataclasses: 'clases de datos con @dataclass',
  abc: 'clases abstractas (ABC, abstractmethod)',
  enum: 'enumeraciones',
  csv: 'leer y escribir archivos CSV',
  pathlib: 'rutas de archivos',
  statistics: 'promedio, mediana y desviación',
  string: 'constantes y utilidades de texto',
  copy: 'copias de objetos (copy, deepcopy)',
  unittest: 'pruebas unitarias',
  turtle: 'dibujos con la tortuga',
  tkinter: 'ventanas, botones y formularios',
  sqlite3: 'base de datos SQLite',
  socket: 'conexiones de red',
  threading: 'hilos de ejecución',
  subprocess: 'ejecutar otros programas',
  argparse: 'argumentos de la línea de comandos',
  logging: 'mensajes de registro (logs)',
  pickle: 'guardar objetos en archivos',
  heapq: 'colas de prioridad (montículos)',
  bisect: 'búsqueda binaria en listas ordenadas',
  decimal: 'decimales exactos',
  fractions: 'fracciones',
  uuid: 'identificadores únicos',
  hashlib: 'hashes (sha256, md5)',
  urllib: 'direcciones web y descargas',
  io: 'flujos de entrada y salida',
  shutil: 'copiar y mover archivos',
  glob: 'buscar archivos por patrón',
  timeit: 'medir cuánto tarda un código',
  operator: 'operadores como funciones',
  queue: 'colas seguras entre hilos',
  asyncio: 'programación asíncrona',
  secrets: 'valores aleatorios seguros',
  __future__: 'funciones de versiones nuevas de Python',
  msvcrt: 'consola de Windows (getch)',
  winsound: 'sonidos de Windows',
};

const PY_WARNINGS: Record<string, string> = {
  msvcrt: 'Solo existe en Windows: en Linux falla.',
  winsound: 'Solo existe en Windows: en Linux falla.',
};

const PY_THIRD_PARTY: Record<string, string> = {
  numpy: 'cálculo con arreglos (paquete externo)',
  pandas: 'tablas de datos (paquete externo)',
  matplotlib: 'gráficas (paquete externo)',
  seaborn: 'gráficas estadísticas (paquete externo)',
  scipy: 'cálculo científico (paquete externo)',
  sklearn: 'aprendizaje automático (scikit-learn)',
  requests: 'peticiones HTTP (paquete externo)',
  flask: 'aplicaciones web (paquete externo)',
  django: 'aplicaciones web (paquete externo)',
  fastapi: 'APIs web (paquete externo)',
  pygame: 'juegos 2D (paquete externo)',
  PIL: 'imágenes (Pillow)',
  cv2: 'visión por computador (OpenCV)',
  pytest: 'pruebas (paquete externo)',
  tensorflow: 'redes neuronales (paquete externo)',
  torch: 'redes neuronales (PyTorch)',
  bs4: 'leer HTML (BeautifulSoup)',
  sympy: 'matemática simbólica (paquete externo)',
  openpyxl: 'archivos de Excel (paquete externo)',
};

const JAVA_CLASSES: Record<string, string> = {
  'java.util.Scanner': 'leer datos del teclado',
  'java.util.ArrayList': 'lista que crece',
  'java.util.List': 'listas (interfaz)',
  'java.util.LinkedList': 'listas enlazadas',
  'java.util.HashMap': 'diccionario clave-valor',
  'java.util.Map': 'diccionarios (interfaz)',
  'java.util.TreeMap': 'diccionario ordenado',
  'java.util.HashSet': 'conjunto sin repetidos',
  'java.util.Set': 'conjuntos (interfaz)',
  'java.util.Random': 'números aleatorios',
  'java.util.Arrays': 'utilidades para arreglos (sort, toString)',
  'java.util.Collections': 'utilidades para colecciones (sort, max)',
  'java.util.Iterator': 'recorrer colecciones',
  'java.util.Stack': 'pilas',
  'java.util.Queue': 'colas (interfaz)',
  'java.util.Optional': 'valores que pueden faltar',
  'java.io.File': 'archivos y carpetas',
  'java.io.BufferedReader': 'leer texto línea por línea',
  'java.io.FileReader': 'leer archivos de texto',
  'java.io.FileWriter': 'escribir archivos de texto',
  'java.io.PrintWriter': 'escribir texto con formato',
  'java.io.IOException': 'errores de entrada y salida',
  'java.io.Serializable': 'guardar objetos (serialización)',
  'java.lang.Math': 'funciones matemáticas',
  'java.time.LocalDate': 'fechas',
  'java.time.LocalDateTime': 'fechas con hora',
  'java.text.DecimalFormat': 'formato de números',
  'javax.swing.JOptionPane': 'cuadros de diálogo',
  'javax.swing.JFrame': 'ventanas (Swing)',
};

const JAVA_PACKAGES: Record<string, string> = {
  'java.util': 'colecciones, Scanner y utilidades',
  'java.util.function': 'interfaces funcionales (lambdas)',
  'java.util.stream': 'procesar colecciones con flujos',
  'java.io': 'archivos y flujos de datos',
  'java.nio.file': 'rutas y archivos',
  'java.time': 'fechas y horas',
  'java.text': 'formato de números y fechas',
  'java.math': 'números grandes (BigInteger, BigDecimal)',
  'java.net': 'conexiones de red',
  'java.sql': 'bases de datos (JDBC)',
  'java.awt': 'gráficos y ventanas (AWT)',
  'java.awt.event': 'eventos de ventanas (AWT)',
  'javax.swing': 'ventanas y botones (Swing)',
  'java.lang': 'clases básicas de Java',
  javafx: 'ventanas (JavaFX)',
  'org.junit': 'pruebas (JUnit)',
};

const JAVA_STD_PREFIX = /^(?:java|javax|jdk|sun|org\.w3c|org\.xml|org\.ietf)\./;
const JAVA_THIRD_PARTY_PREFIX = /^(?:javafx|org\.junit|junit|org\.springframework|org\.apache|com\.google|org\.mockito|org\.hamcrest|org\.slf4j|lombok|com\.fasterxml|kotlin|org\.jetbrains|io\.reactivex|org\.json)(?:\.|$)/;

const NODE_BUILTINS: Record<string, string> = {
  fs: 'archivos', 'fs/promises': 'archivos (con promesas)', path: 'rutas de archivos', http: 'servidor y peticiones HTTP',
  https: 'peticiones HTTPS', os: 'datos del sistema operativo', events: 'eventos (EventEmitter)', util: 'utilidades de Node.js',
  crypto: 'cifrado y hashes', readline: 'leer líneas de la consola', 'readline/promises': 'leer líneas de la consola',
  child_process: 'ejecutar otros programas', url: 'direcciones web', assert: 'comprobaciones', stream: 'flujos de datos',
  buffer: 'datos binarios', process: 'el proceso actual', net: 'conexiones de red', zlib: 'compresión', timers: 'temporizadores',
  worker_threads: 'hilos', test: 'pruebas (node:test)', querystring: 'parámetros de una dirección web', dns: 'nombres de dominio',
  cluster: 'varios procesos', vm: 'ejecutar código aparte', perf_hooks: 'medir el rendimiento', string_decoder: 'decodificar texto',
  module: 'módulos de Node.js', tty: 'la terminal', dgram: 'mensajes UDP', async_hooks: 'seguimiento de tareas asíncronas',
  console: 'la consola',
};

const NPM_KNOWN: Record<string, string> = {
  react: 'interfaces con componentes (paquete de npm)',
  'react-dom': 'React en el navegador (paquete de npm)',
  vue: 'interfaces con componentes (paquete de npm)',
  express: 'servidor web (paquete de npm)',
  axios: 'peticiones HTTP (paquete de npm)',
  lodash: 'utilidades para datos (paquete de npm)',
  jest: 'pruebas (paquete de npm)',
  vitest: 'pruebas (paquete de npm)',
  mocha: 'pruebas (paquete de npm)',
  chai: 'comprobaciones para pruebas (paquete de npm)',
  dotenv: 'variables de entorno desde .env (paquete de npm)',
  mongoose: 'base de datos MongoDB (paquete de npm)',
  vscode: 'API de extensiones de VS Code',
  'prompt-sync': 'leer datos de la consola (paquete de npm)',
  chalk: 'colores en la consola (paquete de npm)',
  jquery: 'manipular la página (paquete de npm)',
  typescript: 'compilador de TypeScript (paquete de npm)',
};

const RUBY_STD: Record<string, string> = {
  json: 'leer y escribir JSON', date: 'fechas', time: 'horas y fechas', set: 'conjuntos', csv: 'archivos CSV',
  securerandom: 'valores aleatorios seguros', 'net/http': 'peticiones HTTP', fileutils: 'copiar y mover archivos',
  'minitest/autorun': 'pruebas (Minitest)', minitest: 'pruebas (Minitest)', rspec: 'pruebas (RSpec)', yaml: 'leer y escribir YAML',
  digest: 'hashes', benchmark: 'medir tiempos', pp: 'imprimir objetos legibles', 'open-uri': 'abrir direcciones web',
};

const CS_NAMESPACES: Record<string, string> = {
  System: 'consola, Math y tipos básicos',
  'System.Collections.Generic': 'listas y diccionarios (List, Dictionary)',
  'System.Collections': 'colecciones',
  'System.Linq': 'consultas sobre colecciones (LINQ)',
  'System.IO': 'archivos y carpetas',
  'System.Text': 'StringBuilder y codificación de texto',
  'System.Text.RegularExpressions': 'expresiones regulares',
  'System.Threading': 'hilos',
  'System.Threading.Tasks': 'tareas asíncronas (Task)',
  'System.Net.Http': 'peticiones HTTP',
  'System.Windows.Forms': 'ventanas (Windows Forms)',
  'System.Drawing': 'gráficos y colores',
  'System.Diagnostics': 'depuración y procesos',
  'System.Globalization': 'formato regional',
  'System.Data': 'datos y bases de datos',
};

// ---------------------------------------------------------------------------------------------
// Lenguaje

const C_EXTENSIONS = /\.(?:c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|inl|ipp|tpp|txx|ino)$/i;

/** Familia del archivo por el lenguaje de VS Code o, si no se sabe, por la extension. */
export function dependencyFamily(language: string, filePath = ''): DependencyFamily {
  const clean = String(language || '').toLowerCase();
  const path = String(filePath || '').toLowerCase();
  if (/^(?:c|cpp|cuda-cpp|objective-c|objective-cpp|arduino)$/.test(clean) || (!clean && C_EXTENSIONS.test(path))) {
    return 'c';
  }
  if (clean === 'python' || clean === 'py' || /\.pyw?$/.test(path)) {
    return 'python';
  }
  if (clean === 'java' || /\.java$/.test(path)) {
    return 'java';
  }
  if (/^(?:javascript|typescript|javascriptreact|typescriptreact|js|ts|jsx|tsx|vue|svelte)$/.test(clean) || /\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(path)) {
    return 'js';
  }
  if (clean === 'ruby' || clean === 'rb' || /\.rb$/.test(path)) {
    return 'ruby';
  }
  if (clean === 'csharp' || clean === 'cs' || /\.cs$/.test(path)) {
    return 'csharp';
  }
  if (C_EXTENSIONS.test(path)) {
    return 'c';
  }
  return 'none';
}

// ---------------------------------------------------------------------------------------------
// Texto sin comentarios (y, si se pide, sin el contenido de las cadenas)

/**
 * Antes de un `/` que abre una expresion regular de JS (no una division). Sin `)`, `]` ni `}`:
 * despues de ellos suele ser una division (`(a + b) / 2`, `${x}/${y}` en una plantilla). Sin `<`:
 * en JSX `</p>` cierra una etiqueta, no abre una expresion regular (se comia el resto de la linea).
 */
const JS_REGEX_PREVIOUS = /[(,=:[!&|?{;+\-*%>~^]/;
const JS_REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await', 'throw', 'delete', 'new', 'instanceof']);
const C_RAW_PREFIXES = new Set(['R', 'u8R', 'uR', 'UR', 'LR']);

/**
 * El texto con los comentarios en blanco (mismo largo, mismos saltos de linea: los numeros de
 * linea no cambian). Con `maskStrings`, tambien el contenido de las cadenas. Siempre se borran
 * las cadenas de triple comilla de Python (un docstring no declara imports), las cadenas crudas
 * de C++ (`R"(...)"`) y el contenido de las expresiones regulares de JS (una comilla o un `//`
 * adentro confundian lo que seguia). En las plantillas de JS el codigo de `${ ... }` sigue
 * siendo codigo, tambien con plantillas anidadas (revisiones independientes del 25/10/2026).
 */
export function maskSource(text: string, family: DependencyFamily, maskStrings: boolean) {
  const source = String(text || '');
  if (family === 'none') {
    return source;
  }
  const out: string[] = [];
  const blank = (ch: string) => (ch === '\n' ? '\n' : ' ');
  const n = source.length;
  const hashComments = family === 'python' || family === 'ruby';
  let i = 0;
  let lineStart = true;
  // JS: el ultimo caracter con algo y la ultima palabra (sin pegar palabras de lineas distintas),
  // para distinguir /regex/ de una division.
  let previous = '';
  let previousWord = '';
  let spaceSincePrevious = false;
  // JS: plantillas abiertas y, dentro de ellas, expresiones ${ } con su profundidad de llaves.
  const templates: Array<{ kind: 'template' } | { kind: 'expression'; depth: number }> = [];
  const top = () => templates[templates.length - 1];
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    const context = family === 'js' ? top() : undefined;
    if (context?.kind === 'template') {
      // Texto de una plantilla: hasta la comilla invertida o el proximo ${.
      if (ch === '\\' && i + 1 < n) {
        out.push(maskStrings ? blank(ch) : ch, maskStrings ? blank(source[i + 1]) : source[i + 1]);
        i += 2;
        continue;
      }
      if (ch === '`') {
        out.push(ch);
        templates.pop();
        previous = '`';
        previousWord = '';
        spaceSincePrevious = false;
        i += 1;
        continue;
      }
      if (ch === '$' && next === '{') {
        out.push('$', '{');
        templates.push({ kind: 'expression', depth: 0 });
        previous = '{';
        previousWord = '';
        spaceSincePrevious = false;
        i += 2;
        continue;
      }
      out.push(maskStrings ? blank(ch) : ch);
      i += 1;
      continue;
    }
    if (family === 'ruby' && lineStart && source.startsWith('=begin', i)) {
      const end = source.indexOf('\n=end', i);
      const stop = end < 0 ? n : end + 5;
      for (; i < stop; i += 1) {
        out.push(blank(source[i]));
      }
      continue;
    }
    if (hashComments ? ch === '#' : ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') {
        out.push(' ');
        i += 1;
        // En C, una \ al final del comentario lo sigue en la linea de abajo.
        if (family === 'c' && source[i] === '\n' && (source[i - 1] === '\\' || (source[i - 1] === '\r' && source[i - 2] === '\\'))) {
          out.push('\n');
          i += 1;
        }
      }
      continue;
    }
    if (!hashComments && ch === '/' && next === '*') {
      out.push(' ', ' ');
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out.push(blank(source[i]));
        i += 1;
      }
      if (i < n) {
        out.push(' ', ' ');
        i += 2;
      }
      continue;
    }
    if (family === 'python' && (source.startsWith('"""', i) || source.startsWith("'''", i))) {
      const quote = source.slice(i, i + 3);
      const end = source.indexOf(quote, i + 3);
      const stop = end < 0 ? n : end + 3;
      for (; i < stop; i += 1) {
        out.push(blank(source[i]));
      }
      continue;
    }
    if (family === 'c' && ch === '"' && i > 0 && source[i - 1] === 'R') {
      // Cadena cruda de C++: R"delim( ... )delim" (puede tener saltos de linea y comillas).
      let wordStart = i - 1;
      while (wordStart > 0 && /\w/.test(source[wordStart - 1])) {
        wordStart -= 1;
      }
      const open = source.indexOf('(', i + 1);
      const delimiter = open > i ? source.slice(i + 1, open) : '';
      if (C_RAW_PREFIXES.has(source.slice(wordStart, i)) && open > i && open - i <= 17 && !/[\s\\)"]/.test(delimiter)) {
        const end = source.indexOf(`)${delimiter}"`, open + 1);
        const stop = end < 0 ? n : end + delimiter.length + 2;
        out.push('"');
        for (i += 1; i < stop - 1; i += 1) {
          out.push(blank(source[i]));
        }
        if (i < n) {
          out.push('"');
          i += 1;
        }
        lineStart = false;
        continue;
      }
    }
    if (family === 'c' && ch === "'" && i > 0 && /[0-9]/.test(source[i - 1]) && /[0-9A-Fa-f]/.test(next || '')) {
      out.push(ch); // separador de digitos de C++14 (1'000'000), no un caracter
      i += 1;
      continue;
    }
    if (family === 'js') {
      if (ch === '`') {
        out.push(ch);
        templates.push({ kind: 'template' });
        i += 1;
        lineStart = false;
        continue;
      }
      if (context?.kind === 'expression') {
        if (ch === '{') {
          context.depth += 1;
        } else if (ch === '}') {
          if (context.depth === 0) {
            out.push(ch); // fin del ${ }: vuelve el texto de la plantilla
            templates.pop();
            i += 1;
            continue;
          }
          context.depth -= 1;
        }
      }
      if (ch === '/' && (previous === '' || JS_REGEX_PREVIOUS.test(previous) || JS_REGEX_KEYWORDS.has(previousWord))) {
        // Expresion regular: su contenido se borra (una comilla o un // adentro no son codigo).
        out.push('/');
        i += 1;
        let inClass = false;
        while (i < n && source[i] !== '\n') {
          const current = source[i];
          if (current === '\\' && i + 1 < n && source[i + 1] !== '\n') {
            out.push(' ', ' ');
            i += 2;
            continue;
          }
          if (current === '/' && !inClass) {
            break;
          }
          if (current === '[') {
            inClass = true;
          } else if (current === ']') {
            inClass = false;
          }
          out.push(' ');
          i += 1;
        }
        if (i < n && source[i] === '/') {
          out.push('/');
          i += 1;
        }
        previous = 'a';
        previousWord = '';
        spaceSincePrevious = false;
        lineStart = false;
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      out.push(ch);
      i += 1;
      while (i < n && source[i] !== ch) {
        if (source[i] === '\n') {
          break; // cadena sin cerrar: termina en el salto de linea
        }
        if (source[i] === '\\' && i + 1 < n && source[i + 1] !== '\n') {
          out.push(maskStrings ? ' ' : source[i], maskStrings ? ' ' : source[i + 1]);
          i += 2;
          continue;
        }
        out.push(maskStrings ? blank(source[i]) : source[i]);
        i += 1;
      }
      if (i < n && source[i] === ch) {
        out.push(ch);
        i += 1;
      }
      previous = ch;
      previousWord = '';
      spaceSincePrevious = false;
      lineStart = false;
      continue;
    }
    out.push(ch);
    lineStart = ch === '\n';
    if (/\s/.test(ch)) {
      spaceSincePrevious = true;
    } else {
      const wordChar = /[\w$]/.test(ch);
      previousWord = wordChar ? (/[\w$]/.test(previous) && !spaceSincePrevious ? previousWord + ch : ch) : '';
      previous = ch;
      spaceSincePrevious = false;
    }
    i += 1;
  }
  return out.join('');
}

function lineStartsOf(text: string) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

/** Linea (1-based) de una posicion del texto. */
function lineOfIndex(starts: number[], index: number) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low + 1;
}

// ---------------------------------------------------------------------------------------------
// Lectura de los imports

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** #include (sin los de un bloque #if 0 ... #endif). */
function parseC(lines: string[]): ParsedImport[] {
  const out: ParsedImport[] = [];
  // Por cada #if abierto: ¿esa rama esta apagada? Solo se sabe de #if 0 / #if false.
  const disabled: boolean[] = [];
  lines.forEach((line, index) => {
    const directive = /^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)$/.exec(line);
    if (directive) {
      const kind = directive[1];
      if (kind === 'if' || kind === 'ifdef' || kind === 'ifndef') {
        disabled.push(kind === 'if' && /^\s*(?:0|false)\s*$/.test(directive[2]));
      } else if (kind === 'endif') {
        disabled.pop();
      } else if (disabled.length) {
        disabled[disabled.length - 1] = false; // #else / #elif de un #if 0: esa rama si cuenta
      }
      return;
    }
    if (disabled.some(Boolean)) {
      return;
    }
    const match = /^\s*#\s*include\s*(?:"([^"\n]+)"|<([^>\n]+)>)/.exec(line);
    if (match) {
      const quoted = match[1] !== undefined;
      out.push({ specifier: (quoted ? match[1] : match[2]).trim(), line: index + 1, kind: quoted ? 'quoted' : 'angle', names: [] });
    }
  });
  return out;
}

/** Python, sobre el texto sin cadenas: `print("paso 1; import os")` no es un import. */
function parsePython(lines: string[]): ParsedImport[] {
  const out: ParsedImport[] = [];
  const joinContinued = (start: number, first: string, untilParen: boolean) => {
    let text = first;
    let index = start;
    while (index + 1 < lines.length && index - start < 50) {
      if (untilParen ? !text.includes(')') : /\\\s*$/.test(text)) {
        text = `${text.replace(/\\\s*$/, ' ')} ${lines[index + 1]}`;
        index += 1;
      } else {
        break;
      }
    }
    return text;
  };
  for (let index = 0; index < lines.length; index += 1) {
    for (const statement of lines[index].split(';')) {
      const plain = /^\s*import\s+(.+)$/.exec(statement);
      if (plain) {
        const rest = joinContinued(index, plain[1], false);
        for (const part of rest.split(',')) {
          const name = /^\s*([A-Za-z_][\w.]*)(?:\s+as\s+[A-Za-z_]\w*)?\s*$/.exec(part);
          if (name) {
            out.push({ specifier: name[1].replace(/\.+$/, ''), line: index + 1, kind: 'module', names: [] });
          }
        }
        continue;
      }
      const from = /^\s*from\s+(\.+[\w.]*|[A-Za-z_][\w.]*)\s+import\s+(.*)$/.exec(statement);
      if (from) {
        const rest = joinContinued(index, from[2], from[2].trim().startsWith('('));
        const names = rest
          .replace(/[()\\]/g, ' ')
          .split(',')
          .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
          .filter((name) => name === '*' || IDENTIFIER.test(name));
        out.push({ specifier: from[1], line: index + 1, kind: from[1].startsWith('.') ? 'relative' : 'module', names });
      }
    }
  }
  return out;
}

// Java y C#: todos los de la linea (`import a.B; import c.D;`), sobre el texto sin cadenas.
const JAVA_IMPORT = /(?<=^|;)[ \t]*import\s+(static\s+)?([A-Za-z_][\w.]*?)(\.\*)?\s*;/gmd;
const CSHARP_USING = /(?<=^|;)[ \t]*(?:global\s+)?using\s+(?:static\s+)?(?:[A-Za-z_]\w*\s*=\s*)?([A-Za-z_][\w.]*)\s*;/gmd;

function parseJava(code: string): ParsedImport[] {
  const starts = lineStartsOf(code);
  const out: ParsedImport[] = [];
  for (const match of code.matchAll(JAVA_IMPORT)) {
    let specifier = match[2];
    const wildcard = !!match[3];
    const line = lineOfIndex(starts, match.indices?.[2]?.[0] ?? match.index ?? 0);
    const names: string[] = [];
    if (match[1]) {
      // import static a.b.Clase.metodo; -> la clase a.b.Clase (con .* tambien es la clase).
      if (!wildcard && specifier.includes('.')) {
        names.push(specifier.slice(specifier.lastIndexOf('.') + 1));
        specifier = specifier.slice(0, specifier.lastIndexOf('.'));
      }
      out.push({ specifier, line, kind: 'module', names });
      continue;
    }
    out.push({ specifier, line, kind: wildcard ? 'wildcard' : 'module', names });
  }
  return out;
}

function parseCSharp(code: string): ParsedImport[] {
  const starts = lineStartsOf(code);
  return [...code.matchAll(CSHARP_USING)].map((match) => ({
    specifier: match[1],
    line: lineOfIndex(starts, match.indices?.[1]?.[0] ?? match.index ?? 0),
    kind: 'module' as const,
    names: [],
  }));
}

function parseRuby(lines: string[]): ParsedImport[] {
  const out: ParsedImport[] = [];
  lines.forEach((line, index) => {
    const match = /^\s*(require_relative|require|load)\s*\(?\s*(['"])([^'"\n]+)\2/.exec(line);
    if (match) {
      out.push({ specifier: match[3], line: index + 1, kind: match[1] === 'require' ? 'module' : 'relative', names: [] });
    }
  });
  return out;
}

/** Comienzo de una sentencia import o export (al inicio, o despues de ; } o un salto de linea). */
const JS_STATEMENT_START = /(?:^|[;\n}])[ \t]*(import|export)\b/g;
const JS_REQUIRE = /(?<![\w$.])require\s*\(\s*(['"])([^'"\n]*)\1\s*\)/gd;
const JS_DYNAMIC = /(?<![\w$.])import\s*\(\s*(['"])([^'"\n]*)\1\s*\)/gd;
/** `const { a, b } = ` o `const x = ` justo antes de un require (se mira un trozo corto). */
const JS_REQUIRE_TARGET = /(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*$/;

function jsClauseNames(clause: string) {
  const text = clause.trim().replace(/^type\s+/, '');
  const names: string[] = [];
  const first = /^([\w$]+)/.exec(text);
  if (first) {
    names.push(first[1]); // import Figura from './figura'
  }
  const named = /\{([^}]*)\}/.exec(text);
  if (named) {
    for (const part of named[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (IDENTIFIER.test(name) && name !== 'default') {
        names.push(name);
      }
    }
  }
  return names;
}

/**
 * JS/TS: las sentencias se leen en el texto sin cadenas ni plantillas (un `require('x')` dentro
 * de un texto no cuenta) y la ruta se toma del original en la misma posicion. Las llaves de un
 * import se saltan con el indice de la proxima `}` (lineal: antes, miles de `import {` sin
 * cerrar tardaban segundos, y un tope de largo perdia listas largas de export).
 */
function parseJs(masked: string, original: string): ParsedImport[] {
  const starts = lineStartsOf(masked);
  const found: Array<ParsedImport & { index: number }> = [];
  const add = (from: number, to: number, names: string[]) => {
    const specifier = original.slice(from, to).trim();
    if (!specifier) {
      return;
    }
    const kind: ImportKind = /^(?:\.{1,2}(?:[/\\]|$)|\/)/.test(specifier) ? 'relative' : 'module';
    found.push({ specifier, line: lineOfIndex(starts, from), kind, names, index: from });
  };
  const nextClose = new Int32Array(masked.length + 1).fill(-1);
  for (let index = masked.length - 1, close = -1; index >= 0; index -= 1) {
    if (masked[index] === '}') {
      close = index;
    }
    nextClose[index] = close;
  }
  const isSpace = (ch: string | undefined) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
  const quotedAt = (at: number) => {
    const quote = masked[at];
    if (quote !== '"' && quote !== "'") {
      return null;
    }
    const end = masked.indexOf(quote, at + 1);
    return end > at && !masked.slice(at + 1, end).includes('\n') ? { from: at + 1, to: end } : null;
  };
  for (const match of masked.matchAll(JS_STATEMENT_START)) {
    let k = (match.index || 0) + match[0].length;
    const skip = () => {
      while (k < masked.length && isSpace(masked[k])) {
        k += 1;
      }
    };
    const word = () => {
      const found = /^[\w$]+/.exec(masked.slice(k, k + 200));
      return found ? found[0] : '';
    };
    skip();
    if (match[1] === 'import') {
      const bare = quotedAt(k); // import './estilos.css'
      if (bare) {
        add(bare.from, bare.to, []);
        continue;
      }
    }
    const clauseStart = k;
    if (word() === 'type' && isSpace(masked[k + 4])) {
      k += 4;
      skip();
    }
    const first = word();
    if (first && first !== 'from') {
      k += first.length;
      skip();
      if (masked[k] === ',') {
        k += 1;
        skip();
      }
    }
    if (masked[k] === '*') {
      k += 1;
      skip();
      if (word() === 'as') {
        k += 2;
        skip();
        k += word().length;
        skip();
      }
    } else if (masked[k] === '{') {
      const close = nextClose[k];
      if (close < 0) {
        continue;
      }
      k = close + 1;
      skip();
    }
    const clauseEnd = k;
    if (word() !== 'from') {
      continue;
    }
    k += 4;
    skip();
    const target = quotedAt(k);
    if (target) {
      add(target.from, target.to, jsClauseNames(masked.slice(clauseStart, clauseEnd)));
    }
  }
  for (const match of masked.matchAll(JS_REQUIRE)) {
    const range = match.indices?.[2];
    if (!range) {
      continue;
    }
    const start = match.index || 0;
    const declaration = JS_REQUIRE_TARGET.exec(masked.slice(Math.max(0, start - 300), start));
    add(range[0], range[1], declaration ? jsClauseNames(declaration[1]) : []);
  }
  for (const match of masked.matchAll(JS_DYNAMIC)) {
    const range = match.indices?.[2];
    if (range) {
      add(range[0], range[1], []);
    }
  }
  return found.sort((left, right) => left.index - right.index).map(({ index: _index, ...rest }) => rest);
}

/** Los imports del archivo, en orden, con su linea. */
export function parseImports(text: string, family: DependencyFamily): ParsedImport[] {
  if (family === 'none') {
    return [];
  }
  const original = String(text || '').slice(0, MAX_PARSE_CHARS);
  switch (family) {
    case 'js':
      return parseJs(maskSource(original, family, true), original);
    case 'c':
      return parseC(maskSource(original, family, false).split('\n'));
    case 'python':
      return parsePython(maskSource(original, family, true).split('\n'));
    case 'java':
      return parseJava(maskSource(original, family, true));
    case 'csharp':
      return parseCSharp(maskSource(original, family, true));
    case 'ruby':
      return parseRuby(maskSource(original, family, false).split('\n'));
    default:
      return [];
  }
}

/** Lineas que declaran imports, paquete o espacio de nombres: nombrar algo ahi no es usarlo. */
const DECLARATION_LINES: Partial<Record<DependencyFamily, RegExp>> = {
  java: /^[ \t]*(?:import|package)\b[^\n]*/gm,
  csharp: /^[ \t]*(?:(?:global[ \t]+)?using\b[^;\n(]*;|namespace\b[^\n{;]*)/gm,
  python: /^[ \t]*(?:import|from)\b[^\n]*/gm,
  ruby: /^[ \t]*(?:require|require_relative|load)\b[^\n]*/gm,
  c: /^[ \t]*#[ \t]*include\b[^\n]*/gm,
};

/** El codigo sin comentarios, sin el contenido de las cadenas y sin las lineas de import. */
export function codeOnly(text: string, family: DependencyFamily) {
  const masked = maskSource(String(text || '').slice(0, MAX_PARSE_CHARS), family, true);
  const declarations = DECLARATION_LINES[family];
  return declarations ? masked.replace(declarations, (line) => ' '.repeat(line.length)) : masked;
}

/** Identificadores del codigo (sin comentarios ni cadenas), para ver que clases y funciones usa. */
export function collectIdentifiers(text: string, family: DependencyFamily) {
  return new Set(codeOnly(text, family).match(/[A-Za-z_$][\w$]*/g) || []);
}

/** Nombres con mayuscula (Java y C#): las clases que usa un archivo sin importarlas. */
export function collectTypeReferences(text: string, family: DependencyFamily) {
  if (family !== 'java' && family !== 'csharp') {
    return [];
  }
  const code = codeOnly(text, family);
  const names = new Set<string>();
  for (const match of code.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)) {
    names.add(match[0]);
    if (names.size >= MAX_TYPE_REFS) {
      break;
    }
  }
  return [...names];
}

/**
 * C#: los espacios de nombres que declara el archivo, tambien los anidados
 * (`namespace A { namespace B {` declara A y A.B) y los de archivo (`namespace X;`).
 */
export function collectNamespaces(text: string, family: DependencyFamily) {
  if (family !== 'csharp') {
    return [];
  }
  const code = maskSource(String(text || '').slice(0, MAX_PARSE_CHARS), family, true);
  const names = new Set<string>();
  const stack: Array<{ name: string; depth: number }> = [];
  let depth = 0;
  for (const match of code.matchAll(/\bnamespace\s+([A-Za-z_][\w.]*)\s*([{;])|[{}]/g)) {
    if (match[1]) {
      names.add([...stack.map((item) => item.name), match[1]].join('.'));
      if (match[2] === '{') {
        depth += 1;
        stack.push({ name: match[1], depth });
      } else {
        stack.push({ name: match[1], depth: -1 }); // de archivo: vale hasta el final
      }
    } else if (match[0] === '{') {
      depth += 1;
    } else {
      while (stack.length && stack[stack.length - 1].depth === depth) {
        stack.pop();
      }
      depth = Math.max(0, depth - 1);
    }
    if (names.size >= 20) {
      break;
    }
  }
  return [...names];
}

/** Java: el paquete del archivo (`package com.uni.modelo;`), o '' en el paquete por defecto. */
export function collectJavaPackage(text: string, family: DependencyFamily) {
  if (family !== 'java') {
    return '';
  }
  const match = /^[ \t]*package\s+([A-Za-z_][\w.]*)\s*;/m.exec(maskSource(String(text || '').slice(0, 20_000), family, true));
  return match ? match[1] : '';
}

// ---------------------------------------------------------------------------------------------
// Rutas

function normalizePath(path: string) {
  return String(path || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function dirnameOf(path: string) {
  const clean = normalizePath(path);
  const index = clean.lastIndexOf('/');
  return index >= 0 ? clean.slice(0, index) : '';
}

function basenameOf(path: string) {
  const clean = normalizePath(path);
  return clean.slice(clean.lastIndexOf('/') + 1);
}

function stemOf(path: string) {
  return basenameOf(path).replace(/\.[^.]+$/, '');
}

/** dir + rel con "." y ".."; null si sale de la carpeta abierta. */
function joinPath(dir: string, rel: string): string | null {
  const parts = normalizePath(dir).split('/').filter(Boolean);
  for (const segment of String(rel || '').replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (!parts.length) {
        return null;
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

function sharedPrefix(left: string, right: string) {
  const a = left.split('/').filter(Boolean);
  const b = right.split('/').filter(Boolean);
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) {
    count += 1;
  }
  return count;
}

/** Distancia de edicion (Levenshtein) con tope: mas alla de `max` devuelve max + 1. */
function editDistance(left: string, right: string, max: number) {
  if (Math.abs(left.length - right.length) > max) {
    return max + 1;
  }
  let previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      best = Math.min(best, current[j]);
    }
    if (best > max) {
      return max + 1;
    }
    previous = current;
  }
  return previous[right.length];
}

type Found = { path: string; caseMismatch: boolean };

/** Carpetas de paquetes instalados: lo que hay ahi nunca es «de tu proyecto». */
const THIRD_PARTY_SEGMENT = /(?:^|\/)(?:site-packages|dist-packages|node_modules|__pycache__|\.git|\.venv|venv)\//;

/** ¿La ruta es de un paquete instalado (un .py de .venv abierto con F12)? Se trata como de afuera. */
export function isThirdPartyPath(path: string) {
  return THIRD_PARTY_SEGMENT.test(normalizePath(path));
}

/** Ruta de `fromDir` a `target` ("../include/figura.h"). */
function relativeFrom(fromDir: string, target: string) {
  const from = normalizePath(fromDir).split('/').filter(Boolean);
  const to = normalizePath(target).split('/').filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) {
    common += 1;
  }
  return [...Array.from({ length: from.length - common }, () => '..'), ...to.slice(common)].join('/');
}

/** Las carpetas de `dir` hacia arriba: "a/b" -> ["a/b", "a", ""]. */
function ancestorsOf(dir: string) {
  const parts = normalizePath(dir).split('/').filter(Boolean);
  const out: string[] = [];
  for (let length = parts.length; length >= 0; length -= 1) {
    out.push(parts.slice(0, length).join('/'));
  }
  return out;
}

/** Los archivos del proyecto (indice mas lo que encontro la busqueda en el disco). */
class ProjectFiles {
  private readonly exact = new Set<string>();
  private readonly lower = new Map<string, string>();
  private readonly byBase = new Map<string, string[]>();
  readonly entries = new Map<string, DependencyIndexFile>();
  readonly paths: string[] = [];
  readonly hasJavaBuild: boolean;
  /** C#: espacio de nombres -> archivos que lo declaran. */
  readonly namespaces = new Map<string, string[]>();
  /** Java: paquete -> archivos. */
  readonly javaPackages = new Map<string, string[]>();
  /** Carpetas con un archivo de compilacion de C/C++ (CMakeLists.txt, Makefile...). */
  readonly cProjectDirs = new Set<string>();

  constructor(files: DependencyIndexFile[], extraPaths: string[], buildFiles: string[] = []) {
    const add = (raw: string) => {
      const path = normalizePath(raw);
      if (!path || this.exact.has(path) || THIRD_PARTY_SEGMENT.test(path)) {
        return false;
      }
      this.exact.add(path);
      this.paths.push(path);
      if (!this.lower.has(path.toLowerCase())) {
        this.lower.set(path.toLowerCase(), path);
      }
      const base = basenameOf(path).toLowerCase();
      const list = this.byBase.get(base) || [];
      list.push(path);
      this.byBase.set(base, list);
      return true;
    };
    for (const file of files) {
      const path = normalizePath(file.path);
      if (add(file.path) && !this.entries.has(path)) {
        this.entries.set(path, file);
      }
    }
    extraPaths.forEach(add);
    const known = [...this.paths, ...buildFiles.map(normalizePath)];
    this.hasJavaBuild = known.some((path) => /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/i.test(path));
    for (const path of known) {
      if (/(?:^|\/)(?:CMakeLists\.txt|[Mm]akefile|GNUmakefile|meson\.build|build\.ninja|compile_commands\.json|[^/]+\.vcxproj)$/.test(path)) {
        this.cProjectDirs.add(dirnameOf(path));
      }
    }
    for (const [path, file] of this.entries) {
      // Del indice (0.0.36) o, si no viene, de la estructura ("3: namespace Taller.Modelo {").
      const declared = file.namespaces
        || [...String(file.outline || '').matchAll(/^\d+:\s*namespace\s+([A-Za-z_][\w.]*)/gm)].map((match) => match[1]);
      for (const name of declared) {
        const list = this.namespaces.get(name) || [];
        list.push(path);
        this.namespaces.set(name, list);
      }
      if (file.javaPackage) {
        const list = this.javaPackages.get(file.javaPackage) || [];
        list.push(path);
        this.javaPackages.set(file.javaPackage, list);
      }
    }
  }

  find(path: string | null): Found | null {
    if (!path) {
      return null;
    }
    if (this.exact.has(path)) {
      return { path, caseMismatch: false };
    }
    const loose = this.lower.get(path.toLowerCase());
    return loose ? { path: loose, caseMismatch: true } : null;
  }

  /** El primero que exista de una lista de rutas (primero igual, despues sin mirar mayusculas). */
  findFirst(paths: Array<string | null>): Found | null {
    const clean = paths.filter((path): path is string => !!path);
    for (const path of clean) {
      if (this.exact.has(path)) {
        return { path, caseMismatch: false };
      }
    }
    for (const path of clean) {
      const found = this.find(path);
      if (found) {
        return found;
      }
    }
    return null;
  }

  /** Un archivo cuya ruta termina en `suffix` ("modelo/Figura.java"), el mas cercano a `nearDir`. */
  findSuffix(suffix: string, nearDir: string): Found | null {
    const clean = normalizePath(suffix);
    if (!clean) {
      return null;
    }
    const candidates = this.byBase.get(basenameOf(clean).toLowerCase()) || [];
    const exact = candidates.filter((path) => path === clean || path.endsWith(`/${clean}`));
    if (exact.length) {
      return { path: this.nearest(exact, nearDir), caseMismatch: false };
    }
    const lowerSuffix = clean.toLowerCase();
    const loose = candidates.filter((path) => path.toLowerCase() === lowerSuffix || path.toLowerCase().endsWith(`/${lowerSuffix}`));
    return loose.length ? { path: this.nearest(loose, nearDir), caseMismatch: true } : null;
  }

  /** De varias rutas, la mas cercana a `nearDir` (mas carpetas en comun, despues la mas corta). */
  nearest(list: string[], nearDir: string) {
    return [...list].sort((left, right) =>
      sharedPrefix(dirnameOf(right), nearDir) - sharedPrefix(dirnameOf(left), nearDir)
      || left.split('/').length - right.split('/').length
      || left.localeCompare(right))[0];
  }

  /** Archivos de una carpeta (sin subcarpetas) con una extension. */
  filesInDir(dir: string, extension: string) {
    const clean = normalizePath(dir);
    return this.paths.filter((path) => dirnameOf(path) === clean && path.toLowerCase().endsWith(extension));
  }

  /** Los .py dentro de una carpeta (un paquete sin __init__.py tambien es un paquete). */
  pythonFilesUnder(dir: string | null) {
    if (dir === null) {
      return [];
    }
    const prefix = dir ? `${normalizePath(dir)}/` : '';
    return prefix ? this.paths.filter((path) => path.startsWith(prefix) && path.endsWith('.py')) : [];
  }

  /** Carpetas que terminan en `dirSuffix` ("modelo" o "com/uni/modelo") con archivos .java. */
  javaFilesUnder(dirSuffix: string) {
    const clean = normalizePath(dirSuffix);
    return this.paths.filter((path) => {
      const dir = dirnameOf(path);
      return path.endsWith('.java') && (dir === clean || dir.endsWith(`/${clean}`));
    });
  }

  /** Otro archivo con ese nombre en cualquier carpeta (para «Está en ...»). */
  elsewhere(name: string, nearDir: string, except: string[] = []) {
    const list = (this.byBase.get(basenameOf(name).toLowerCase()) || []).filter((path) => !except.includes(path));
    return list.length ? this.nearest(list, nearDir) : '';
  }

  /** Archivos dentro de `root` (o de todo el proyecto si root es '') cuya ruta termina en `suffix`. */
  under(root: string, suffix: string, nearDir: string): Found | null {
    const clean = normalizePath(suffix);
    const prefix = root ? `${normalizePath(root)}/` : '';
    const list = (this.byBase.get(basenameOf(clean).toLowerCase()) || [])
      .filter((path) => (!prefix || path.startsWith(prefix)) && (path === clean || path.endsWith(`/${clean}`)));
    return list.length ? { path: this.nearest(list, nearDir), caseMismatch: false } : null;
  }

  /** La carpeta de arriba mas cercana con un archivo de compilacion de C/C++ ('' si es la raiz; null si no hay). */
  cProjectRoot(fromDir: string) {
    return ancestorsOf(fromDir).find((dir) => this.cProjectDirs.has(dir)) ?? null;
  }

  /** «¿Quisiste decir ...?»: el archivo de nombre mas parecido (misma extension o mismo nombre). */
  suggest(name: string, extensions: RegExp): string {
    const target = basenameOf(name).toLowerCase();
    if (!target) {
      return '';
    }
    const targetStem = target.replace(/\.[^.]+$/, '');
    let best = '';
    let bestScore = Number.MAX_SAFE_INTEGER;
    const max = target.length >= 6 ? 2 : 1;
    for (const path of this.paths) {
      if (!extensions.test(path)) {
        continue;
      }
      const base = basenameOf(path).toLowerCase();
      const stem = base.replace(/\.[^.]+$/, '');
      const score = stem === targetStem && base !== target ? 0.5 : editDistance(base, target, max);
      if (score <= max && score < bestScore) {
        best = path;
        bestScore = score;
      }
    }
    return best ? `¿Quisiste decir «${best}»?` : '';
  }
}

const CASE_WARNING = (path: string) => `Se llama «${basenameOf(path)}»: en Linux las mayúsculas cuentan.`;

type Resolved = {
  label: string;
  type: 'local' | 'library' | 'missing';
  path?: string;
  description?: string;
  warning?: string;
  hint?: string;
  /** Nombre de archivo para buscar en el disco si el indice no lo tiene. */
  probe?: string;
  /** Rutas exactas donde deberia estar (se comprueban en el disco antes de buscar por nombre). */
  expected?: string[];
  /** Biblioteca supuesta (un modulo de Python que no se encontro): fuera del proyecto no se muestra. */
  guessed?: boolean;
  names?: string[];
};

type ResolveOptions = {
  /** ¿El archivo usa este nombre? (para expandir import a.b.*;). */
  uses: (name: string) => boolean;
  /** Calcular «¿Quisiste decir...?» (no hace falta para «La usan»). */
  hints: boolean;
};

const C_HEADER_FILES = /\.(?:h|hh|hpp|hxx|h\+\+|inl|ipp|tpp|txx)$/i;
const C_SOURCE_FILES = /\.(?:c|cc|cpp|cxx|c\+\+)$/i;
const C_FAMILY_FILES = /\.(?:h|hh|hpp|hxx|inl|ipp|tpp|txx|c|cc|cpp|cxx)$/i;

function local(label: string, found: Found, warning?: string): Resolved {
  return { label, type: 'local', path: found.path, warning: found.caseMismatch ? CASE_WARNING(found.path) : warning };
}

/**
 * #include "x": donde lo busca el compilador. Junto al archivo; en `include/` o `inc/` de esa
 * carpeta o de una de arriba (el -Iinclude de casi todo CMake o Makefile); y, con aviso, en
 * una carpeta de arriba (solo compila con -I). Lo que esta en otra carpeta cualquiera ya no
 * cuenta como encontrado: es el error que el cuadro tiene que mostrar (revision independiente
 * del 25/10/2026: `taller2/main.cpp` con `#include "figura.h"` y solo `taller1/figura.h`).
 */
function findCInclude(spec: string, fromDir: string, project: ProjectFiles) {
  const near = project.findFirst([joinPath(fromDir, spec)]);
  if (near) {
    return { found: near, ancestor: false };
  }
  const ancestors = ancestorsOf(fromDir);
  const included = project.findFirst(ancestors.flatMap((dir) => [joinPath(dir, `include/${spec}`), joinPath(dir, `inc/${spec}`)]));
  if (included) {
    return { found: included, ancestor: false };
  }
  const above = project.findFirst(ancestors.slice(1).map((dir) => joinPath(dir, spec)));
  return above ? { found: above, ancestor: true } : null;
}

function resolveC(imp: ParsedImport, fromPath: string, project: ProjectFiles, options: ResolveOptions): Resolved[] {
  const written = imp.specifier.trim();
  const spec = written.replace(/\\/g, '/');
  const backslashWarning = spec !== written ? `En Linux usa / en la ruta: #include "${spec}".` : undefined;
  const lower = spec.toLowerCase();
  const known = C_HEADERS[lower];
  const warning = C_HEADER_WARNINGS[lower];
  const fromDir = dirnameOf(fromPath);
  const explicitRelative = /^\.{1,2}\//.test(spec);
  const relative = joinPath(fromDir, spec);
  // <Vector> o <String> pasan en Windows y macOS, no en Linux.
  const caseWarning = known && spec !== lower && !warning ? `En Linux se escribe en minúsculas: #include <${lower}>.` : undefined;
  if (imp.kind === 'angle') {
    if (known) {
      return [{ label: spec, type: 'library', description: known, warning: warning || caseWarning }];
    }
    const own = findCInclude(spec, fromDir, project);
    if (own) {
      return [local(spec, own.found, `Es tuyo: inclúyelo con comillas, #include "${spec}".`)];
    }
    return [{ label: spec, type: 'library', description: cLibraryDescription(spec) || 'biblioteca del sistema o externa' }];
  }
  if (relative === null) {
    return [{ label: spec, type: 'missing', description: 'La ruta sale de la carpeta abierta en VS Code.' }];
  }
  const own = explicitRelative
    ? (() => {
      const found = project.find(relative);
      return found ? { found, ancestor: false } : null;
    })()
    : findCInclude(spec, fromDir, project);
  if (own) {
    const source = C_SOURCE_FILES.exec(own.found.path);
    // Con CMakeLists.txt o Makefile, sus -I lo encuentran: el aviso de la carpeta de arriba sobra.
    const ancestorWarning = own.ancestor && project.cProjectRoot(fromDir) === null
      ? `Está en una carpeta de arriba: escribe #include "${relativeFrom(fromDir, own.found.path)}" o compila con -I.`
      : undefined;
    return [local(spec, own.found, backslashWarning
      || ancestorWarning
      || (source ? `Incluir un ${source[0]} suele dar «multiple definition»: incluye su .h.` : undefined))];
  }
  if (known) {
    return [{ label: spec, type: 'library', description: known, warning: warning || caseWarning }];
  }
  if (!explicitRelative) {
    // En el mismo proyecto pero en otra carpeta: con un CMakeLists.txt o un Makefile, sus -I lo
    // encuentran (headers/, src/, lib/...); sin ellos, solo compila agregando -I. Lo que esta en
    // la carpeta de otro ejercicio (taller1 desde taller2) sigue siendo «No encontrado».
    const projectRoot = project.cProjectRoot(fromDir);
    const exerciseRoot = projectRoot ?? (fromDir.split('/').filter(Boolean)[0] || '');
    const inProject = project.under(exerciseRoot, spec, fromDir);
    if (inProject) {
      // La carpeta que hay que pasar con -I: la ruta del archivo sin lo que dice el #include.
      const includeDir = inProject.path.slice(0, inProject.path.length - spec.length).replace(/\/$/, '');
      const flagDir = exerciseRoot && includeDir.startsWith(`${exerciseRoot}/`)
        ? includeDir.slice(exerciseRoot.length + 1)
        : includeDir === exerciseRoot ? '.' : includeDir;
      return [local(spec, inProject, projectRoot !== null
        ? undefined
        : `Está en «${includeDir || '.'}»: compila con -I${flagDir || '.'} o escribe #include "${relativeFrom(fromDir, inProject.path)}".`)];
    }
  }
  const library = cLibraryDescription(spec);
  if (library) {
    return [{ label: spec, type: 'library', description: library }];
  }
  // En otra carpeta: el compilador no lo encuentra, pero el estudiante si sabe donde esta.
  const other = project.elsewhere(spec, fromDir);
  if (other) {
    return [{
      label: spec,
      type: 'missing',
      description: 'Está en otra carpeta.',
      hint: `Está en «${other}»: escribe #include "${relativeFrom(fromDir, other)}".`,
      expected: [relative],
      probe: basenameOf(spec),
    }];
  }
  return [{
    label: spec,
    type: 'missing',
    description: 'Revisa el nombre y la carpeta.',
    hint: options.hints ? project.suggest(spec, C_HEADER_FILES.test(spec) ? C_HEADER_FILES : C_SOURCE_FILES.test(spec) ? C_SOURCE_FILES : C_FAMILY_FILES) : '',
    probe: basenameOf(spec),
    expected: [relative],
  }];
}

function pythonLibrary(spec: string): Resolved | null {
  const top = spec.split('.')[0];
  if (PY_STDLIB.has(top)) {
    return { label: spec, type: 'library', description: PY_DESCRIPTIONS[spec] || PY_DESCRIPTIONS[top] || 'biblioteca estándar de Python', warning: PY_WARNINGS[top] };
  }
  const third = PY_THIRD_PARTY[top] || PY_THIRD_PARTY[top.toLowerCase()];
  return third ? { label: spec, type: 'library', description: third } : null;
}

/**
 * Python busca un `import x` junto al archivo que se ejecuta, en la carpeta desde donde se
 * ejecuta (la raiz del proyecto con `python -m`) y en `src/`. Lo que esta en otra carpeta no
 * se importa (ModuleNotFoundError): el cuadro lo marca como no encontrado y dice donde esta.
 */
function resolvePython(imp: ParsedImport, fromPath: string, project: ProjectFiles, options: ResolveOptions): Resolved[] {
  const spec = imp.specifier;
  const fromDir = dirnameOf(fromPath);
  // from x import a, b: a y b son lo que usa de x (salvo que sean modulos: entonces son archivos).
  const names = imp.names.filter((name) => name !== '*');
  const findModule = (base: string | null) => (base === null
    ? null
    : project.findFirst([`${base}.py`, joinPath(base, '__init__.py')]));
  if (imp.kind === 'relative') {
    const dots = (/^\.+/.exec(spec) || ['.'])[0].length;
    const rest = spec.slice(dots);
    const base = joinPath(fromDir, Array.from({ length: dots - 1 }, () => '..').join('/'));
    if (base === null) {
      return [{ label: spec, type: 'missing', description: 'La ruta sale de la carpeta abierta en VS Code.' }];
    }
    const modulePath = rest ? joinPath(base, rest.replace(/\./g, '/')) : base;
    if (rest) {
      const found = findModule(modulePath);
      if (found) {
        return [{ ...local(spec, found), names }];
      }
    }
    // from . import a, b  /  from .paquete import modulo: cada nombre puede ser un modulo.
    const modules = names
      .map((name) => ({ name, found: findModule(joinPath(modulePath || '', name)) }))
      .filter((item): item is { name: string; found: Found } => !!item.found);
    if (modules.length) {
      return modules.map((item) => local(`${spec}${rest ? '.' : ''}${item.name}`, item.found));
    }
    const init = !rest ? project.find(joinPath(base, '__init__.py')) : null;
    if (init) {
      return [{ ...local(spec, init), names }];
    }
    const folder = rest ? project.pythonFilesUnder(modulePath) : [];
    if (folder.length) {
      return [{ label: spec, type: 'local', path: project.nearest(folder, fromDir), description: 'paquete de tu proyecto (carpeta)', names }];
    }
    const missingName = rest.split('.').pop() || names[0] || '';
    return [{
      label: spec,
      type: 'missing',
      description: 'Revisa el nombre y la carpeta.',
      hint: options.hints && missingName ? project.suggest(`${missingName}.py`, /\.py$/i) : '',
      probe: missingName ? `${missingName}.py` : undefined,
      expected: modulePath && rest ? [`${modulePath}.py`] : undefined,
    }];
  }
  const asPath = spec.replace(/\./g, '/');
  // Junto al archivo y en cada carpeta de arriba (python -m desde la carpeta del proyecto, pytest,
  // Django en backend/), tambien en su src/. Lo de una carpeta hermana no se importa.
  const roots = [...new Set(ancestorsOf(fromDir).flatMap((dir) => [dir, joinPath(dir, 'src') || 'src']))];
  const found = project.findFirst(roots.flatMap((root) => [joinPath(root, `${asPath}.py`), joinPath(root, `${asPath}/__init__.py`)]));
  if (found) {
    // random.py, turtle.py o math.py del estudiante tapan el modulo de Python del mismo nombre.
    const top = spec.split('.')[0];
    const ownName = stemOf(found.path) === '__init__' ? basenameOf(dirnameOf(found.path)) : stemOf(found.path);
    const shadowed = ownName === top && pythonLibrary(top)
      ? `Tapa el módulo «${top}» de Python: si querías ese, cámbiale el nombre.`
      : undefined;
    return [{ ...local(spec, found, shadowed), names }];
  }
  // from paquete import modulo
  const submodules = names
    .map((name) => ({ name, found: project.findFirst(roots.map((root) => joinPath(root, `${asPath}/${name}.py`))) }))
    .filter((item): item is { name: string; found: Found } => !!item.found);
  if (submodules.length) {
    return submodules.map((item) => local(`${spec}.${item.name}`, item.found));
  }
  // Paquete sin __init__.py (una carpeta con modulos).
  const folder = roots.map((root) => project.pythonFilesUnder(joinPath(root, asPath))).find((list) => list.length) || [];
  if (folder.length) {
    return [{ label: spec, type: 'local', path: project.nearest(folder, fromDir), description: 'paquete de tu proyecto (carpeta)', names }];
  }
  const library = pythonLibrary(spec);
  if (library) {
    return [library];
  }
  const top = spec.split('.')[0];
  const lastName = `${asPath.split('/').pop()}.py`;
  const other = project.elsewhere(lastName, fromDir);
  if (other) {
    return [{
      label: spec,
      type: 'missing',
      description: 'Está en otra carpeta.',
      hint: `Está en «${other}»: Python solo lo encuentra junto al archivo que ejecutas.`,
      probe: lastName,
      expected: [joinPath(fromDir, `${asPath}.py`) || `${asPath}.py`],
    }];
  }
  if (options.hints) {
    // Un nombre casi igual a un modulo tuyo o de Python es casi siempre un error de tipeo.
    const own = project.suggest(`${top}.py`, /\.py$/i);
    const max = top.length >= 6 ? 2 : 1;
    const std = own ? '' : [...PY_STDLIB].find((name) => name !== top && editDistance(name.toLowerCase(), top.toLowerCase(), max) <= max) || '';
    if (own || std) {
      return [{
        label: spec,
        type: 'missing',
        description: 'No está en tu proyecto ni es un módulo de Python.',
        hint: own || `¿Quisiste decir «${std}»?`,
        probe: `${top}.py`,
        expected: [joinPath(fromDir, `${asPath}.py`) || `${asPath}.py`],
      }];
    }
  }
  return [{
    label: spec,
    type: 'library',
    description: 'paquete externo: si Python no lo encuentra, instálalo con pip',
    probe: `${top}.py`,
    expected: [joinPath(fromDir, `${asPath}.py`) || `${asPath}.py`],
    guessed: true,
  }];
}

function javaLibraryDescription(spec: string) {
  if (JAVA_CLASSES[spec]) {
    return JAVA_CLASSES[spec];
  }
  const parts = spec.split('.');
  for (let length = parts.length; length > 0; length -= 1) {
    const prefix = parts.slice(0, length).join('.');
    if (JAVA_PACKAGES[prefix]) {
      return JAVA_PACKAGES[prefix];
    }
  }
  return JAVA_STD_PREFIX.test(spec) ? 'biblioteca estándar de Java' : 'biblioteca externa';
}

function resolveJava(imp: ParsedImport, fromPath: string, project: ProjectFiles, options: ResolveOptions): Resolved[] {
  const spec = imp.specifier;
  const fromDir = dirnameOf(fromPath);
  if (imp.kind === 'wildcard') {
    const classes = [...new Set([...(project.javaPackages.get(spec) || []), ...project.javaFilesUnder(spec.replace(/\./g, '/'))])];
    if (classes.length) {
      const used = classes.filter((path) => options.uses(stemOf(path)));
      return used.length
        ? used.map((path) => local(`${spec}.${stemOf(path)}`, { path, caseMismatch: false }))
        : [{ label: `${spec}.*`, type: 'local', path: project.nearest(classes, fromDir), description: `${classes.length} clase(s) de tu proyecto` }];
    }
    if (JAVA_STD_PREFIX.test(`${spec}.`) || JAVA_THIRD_PARTY_PREFIX.test(spec) || project.hasJavaBuild) {
      return [{ label: `${spec}.*`, type: 'library', description: javaLibraryDescription(spec) }];
    }
    return [{ label: `${spec}.*`, type: 'missing', description: 'No hay una carpeta con ese paquete en tu proyecto.' }];
  }
  const className = spec.slice(spec.lastIndexOf('.') + 1);
  const packageName = spec.includes('.') ? spec.slice(0, spec.lastIndexOf('.')) : '';
  // Por su linea package (cualquier carpeta de fuentes: src/main/java, src/test/java) o por la ruta.
  const byPackage = (project.javaPackages.get(packageName) || []).filter((path) => stemOf(path) === className);
  const found = byPackage.length
    ? { path: project.nearest(byPackage, fromDir), caseMismatch: false }
    : project.findSuffix(`${spec.replace(/\./g, '/')}.java`, fromDir);
  if (found) {
    return [local(spec, found)];
  }
  if (JAVA_STD_PREFIX.test(spec) || JAVA_THIRD_PARTY_PREFIX.test(spec)) {
    return [{ label: spec, type: 'library', description: javaLibraryDescription(spec) }];
  }
  const elsewhere = project.findSuffix(`${className}.java`, fromDir);
  if (elsewhere) {
    return [{
      label: spec,
      type: 'missing',
      description: 'El paquete no coincide con la carpeta de la clase.',
      hint: `Está en «${elsewhere.path}»: revisa su línea package o el import.`,
    }];
  }
  if (project.hasJavaBuild) {
    return [{ label: spec, type: 'library', description: 'dependencia del proyecto (Maven o Gradle)' }];
  }
  return [{
    label: spec,
    type: 'missing',
    description: 'Revisa el nombre y el paquete.',
    hint: options.hints ? project.suggest(`${className}.java`, /\.java$/i) : '',
    probe: `${className}.java`,
  }];
}

/** Sin extension escrita, solo modulos de codigo (`./util` no es util.css). */
const JS_SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
const JS_FILES = /\.(?:[cm]?[jt]sx?|json|vue|svelte|css|scss|sass|less|html)$/i;
const JS_SCRIPT_FILES = /\.(?:[cm]?[jt]sx?|json)$/i;

function findJsFile(base: string, project: ProjectFiles): Found | null {
  const hasExtension = /\.[^/.]+$/.test(base);
  const direct = project.find(base);
  if (direct && hasExtension) {
    return direct;
  }
  // TypeScript con ESM escribe './modulo.js' aunque el archivo sea modulo.ts.
  if (/\.(?:[cm]?js|jsx)$/i.test(base)) {
    const swapped = project.findFirst(['.ts', '.tsx', '.mts', '.cts'].map((extension) => base.replace(/\.(?:[cm]?js|jsx)$/i, extension)));
    if (swapped) {
      return swapped;
    }
  }
  return project.findFirst([
    ...JS_SCRIPT_EXTENSIONS.map((extension) => `${base}${extension}`),
    `${base}.d.ts`,
    ...JS_SCRIPT_EXTENSIONS.slice(0, 8).map((extension) => `${base}/index${extension}`),
  ]) || direct;
}

/** './App' con App.vue: webpack (Vue CLI) lo encuentra; Vite pide la extension. */
function findComponentFile(base: string, project: ProjectFiles): Found | null {
  return /\.[^/.]+$/.test(base) ? null : project.findFirst([`${base}.vue`, `${base}.svelte`]);
}

/**
 * Organizaciones de npm conocidas: '@vue/test-utils' es un paquete aunque el proyecto tenga una
 * carpeta vue/ (un alias como '@components/Boton' no esta en esta lista).
 */
const NPM_SCOPES = new Set(['@types', '@angular', '@vue', '@babel', '@mui', '@testing-library', '@reduxjs', '@tanstack', '@nestjs', '@prisma', '@firebase', '@supabase', '@aws-sdk', '@google-cloud', '@emotion', '@fortawesome', '@radix-ui', '@sveltejs', '@vitejs', '@playwright', '@jest', '@storybook', '@react-navigation', '@expo', '@ionic', '@capacitor', '@apollo', '@headlessui', '@heroicons', '@typescript-eslint', '@eslint']);

/**
 * Un alias de tsconfig o de Vite ('@components/Boton' -> src/components/Boton.tsx): un archivo
 * del proyecto cuya ruta termina igual (con las mayusculas iguales: una coincidencia floja no basta).
 */
function findJsAliasFile(rest: string, nearDir: string, project: ProjectFiles): Found | null {
  const hasExtension = /\.[^/.]+$/.test(basenameOf(rest));
  const candidates = hasExtension
    ? [rest]
    : [
      ...JS_SCRIPT_EXTENSIONS.map((extension) => `${rest}${extension}`),
      `${rest}.d.ts`,
      `${rest}.vue`,
      `${rest}.svelte`,
      ...JS_SCRIPT_EXTENSIONS.slice(0, 8).map((extension) => `${rest}/index${extension}`),
    ];
  for (const candidate of candidates) {
    const found = project.findSuffix(candidate, nearDir);
    if (found && !found.caseMismatch) {
      return found;
    }
  }
  return null;
}

function resolveJs(imp: ParsedImport, fromPath: string, project: ProjectFiles, options: ResolveOptions): Resolved[] {
  const written = imp.specifier;
  // './util\\formato' (barras de Windows) funciona en Windows y no en Linux.
  const windowsPath = /^\.{1,2}\\/.test(written);
  const spec = windowsPath ? written.replace(/\\\\/g, '/').replace(/\\/g, '/') : written;
  const backslashWarning = windowsPath ? `En Linux usa / en la ruta: '${spec}'.` : undefined;
  const fromDir = dirnameOf(fromPath);
  const names = imp.names;
  const isRelative = /^(?:\.{1,2}(?:\/|$)|\/)/.test(spec);
  const appAlias = spec.startsWith('@/') || spec.startsWith('~/') ? spec.slice(0, 2) : '';
  if (isRelative || appAlias) {
    // @/ y ~/ son la carpeta de la aplicacion: la src/ (o app/) de arriba mas cercana (la app puede
    // no estar en la raiz), o la carpeta de la app misma (Nuxt).
    const rest = spec.slice(2);
    const exists = (dir: string) => {
      const candidate = joinPath(dir, rest) || '';
      return !!(findJsFile(candidate, project) || findComponentFile(candidate, project));
    };
    const aliasRoot = appAlias
      ? [
        ...ancestorsOf(fromDir).flatMap((dir) => [joinPath(dir, 'src') || 'src', joinPath(dir, 'app') || 'app']),
        ...ancestorsOf(fromDir).reverse(),
      ].find(exists) ?? 'src'
      : '';
    const base = appAlias
      ? joinPath(aliasRoot, rest)
      : spec.startsWith('/') ? joinPath('', spec.slice(1)) : joinPath(fromDir, spec);
    if (base === null) {
      return [{ label: spec, type: 'missing', description: 'La ruta sale de la carpeta abierta en VS Code.' }];
    }
    const found = findJsFile(base, project);
    if (found) {
      return [{ ...local(spec, found, backslashWarning), names }];
    }
    const component = findComponentFile(base, project);
    if (component) {
      return [{ ...local(spec, component, `Con Vite escribe la extensión: '${spec}${component.path.slice(component.path.lastIndexOf('.'))}'.`), names }];
    }
    const name = basenameOf(base);
    const hasExtension = /\.[^.]+$/.test(name);
    return [{
      label: spec,
      type: 'missing',
      description: appAlias ? `El alias ${appAlias} suele apuntar a src/ y ahí no está.` : 'Revisa el nombre y la carpeta.',
      // Sin extension escrita es un modulo de codigo: no se sugiere util.css para './util'.
      hint: options.hints ? project.suggest(hasExtension ? name : `${name}.js`, hasExtension ? JS_FILES : JS_SCRIPT_FILES) : '',
      probe: name && !/[*?[\]{}]/.test(name) ? (hasExtension ? name : `${name}.*`) : undefined,
      expected: hasExtension ? [base] : ['.ts', '.js', '.tsx', '.jsx'].map((extension) => `${base}${extension}`),
    }];
  }
  const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
  const pkg = bare.startsWith('@') ? bare.split('/').slice(0, 2).join('/') : bare.split('/')[0];
  if (spec.startsWith('node:') || NODE_BUILTINS[bare] || NODE_BUILTINS[pkg]) {
    return [{ label: spec, type: 'library', description: `${NODE_BUILTINS[bare] || NODE_BUILTINS[pkg] || 'módulo'} (Node.js)` }];
  }
  // '@components/Boton' con un archivo components/Boton.tsx en el proyecto: un alias, no npm.
  if (/^@[\w.-]+\/./.test(spec) && !NPM_KNOWN[pkg] && !NPM_SCOPES.has(pkg.split('/')[0])) {
    const aliased = findJsAliasFile(spec.slice(1), fromDir, project);
    if (aliased) {
      return [{ ...local(spec, aliased), names }];
    }
  }
  return [{ label: spec, type: 'library', description: NPM_KNOWN[pkg] || 'paquete de npm' }];
}

/**
 * Ruby: require_relative busca junto al archivo. `require 'x'` busca en las gemas y en el
 * $LOAD_PATH (lib/ con -Ilib o con bundler), no en la carpeta del archivo.
 */
function resolveRuby(imp: ParsedImport, fromPath: string, project: ProjectFiles, options: ResolveOptions): Resolved[] {
  const spec = imp.specifier;
  const fromDir = dirnameOf(fromPath);
  const withExtension = /\.rb$/i.test(spec) ? spec : `${spec}.rb`;
  if (imp.kind === 'relative') {
    const base = joinPath(fromDir, withExtension);
    if (base === null) {
      return [{ label: spec, type: 'missing', description: 'La ruta sale de la carpeta abierta en VS Code.' }];
    }
    const found = project.find(base);
    if (found) {
      return [local(spec, found)];
    }
    return [{
      label: spec,
      type: 'missing',
      description: 'Revisa el nombre y la carpeta.',
      hint: options.hints ? project.suggest(withExtension, /\.rb$/i) : '',
      probe: basenameOf(withExtension),
      expected: [base],
    }];
  }
  // $LOAD_PATH: lib/ (con -Ilib o bundler) y spec/ o test/ (RSpec y Minitest los agregan).
  const ancestors = ancestorsOf(fromDir);
  const inLoadPath = project.findFirst([
    ...ancestors.flatMap((dir) => ['lib', 'spec', 'test'].map((folder) => joinPath(dir, `${folder}/${withExtension}`))),
    ...ancestors.filter((dir) => /(?:^|\/)(?:lib|spec|test)$/.test(dir)).map((dir) => joinPath(dir, withExtension)),
  ]);
  if (inLoadPath) {
    return [local(spec, inLoadPath)];
  }
  const sibling = project.find(joinPath(fromDir, withExtension));
  if (sibling) {
    return [local(spec, sibling, `require no busca en esta carpeta: usa require_relative '${spec}'.`)];
  }
  return [{ label: spec, type: 'library', description: RUBY_STD[spec] || 'gema de Ruby' }];
}

function resolveCSharp(imp: ParsedImport, fromPath: string, project: ProjectFiles): Resolved[] {
  const spec = imp.specifier;
  if (/^(?:System|Microsoft)(?:\.|$)/.test(spec)) {
    return [{ label: spec, type: 'library', description: CS_NAMESPACES[spec] || 'biblioteca de .NET' }];
  }
  // Un espacio de nombres declarado en el proyecto.
  const declaring = (project.namespaces.get(spec) || []).filter((path) => path !== fromPath);
  if (declaring.length) {
    return [{ label: spec, type: 'local', path: project.nearest(declaring, dirnameOf(fromPath)), description: 'espacio de nombres de tu proyecto' }];
  }
  return [{ label: spec, type: 'library', description: 'paquete NuGet o biblioteca externa' }];
}

function resolveImport(imp: ParsedImport, fromPath: string, family: DependencyFamily, project: ProjectFiles, options: ResolveOptions): Resolved[] {
  switch (family) {
    case 'c':
      return resolveC(imp, fromPath, project, options);
    case 'python':
      return resolvePython(imp, fromPath, project, options);
    case 'java':
      return resolveJava(imp, fromPath, project, options);
    case 'js':
      return resolveJs(imp, fromPath, project, options);
    case 'ruby':
      return resolveRuby(imp, fromPath, project, options);
    case 'csharp':
      return resolveCSharp(imp, fromPath, project);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Que usa de cada archivo del proyecto

const GENERIC_NAMES = new Set(['main', 'init', 'constructor', 'toString', 'equals', 'hashCode', 'function', 'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'extends', 'implements']);

/** Clases y funciones declaradas en la estructura de un archivo ("12: class Figura {"). */
export function declaredNames(outline: string) {
  const names = new Map<string, 'type' | 'function'>();
  for (const raw of String(outline || '').split('\n')) {
    const text = raw.replace(/^\s*\d+:\s?/, '').trim();
    if (!text || /^(?:#|import\b|from\b|require|using\b|package\b|\(\d+ declaracion)/.test(text) || /\boperator\b/.test(text)) {
      continue;
    }
    const type = /\b(?:class|struct|interface|enum(?:\s+class)?|union|record|module)\s+([A-Za-z_]\w*)/.exec(text);
    if (type && !GENERIC_NAMES.has(type[1])) {
      names.set(type[1], 'type');
      continue;
    }
    const def = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(text);
    const call = def || /([A-Za-z_~][\w]*)\s*\(/.exec(text);
    const name = call ? call[1] : '';
    if (!name || name.startsWith('~') || name.startsWith('__') || GENERIC_NAMES.has(name) || names.has(name)) {
      continue;
    }
    names.set(name, 'function');
  }
  return names;
}

function symbolsUsed(resolved: Resolved, entry: DependencyIndexFile | undefined, identifiers: Set<string>) {
  const out: string[] = [];
  for (const name of resolved.names || []) {
    if (!out.includes(name)) {
      out.push(name);
    }
  }
  if (!out.length && entry?.outline) {
    for (const [name, kind] of declaredNames(entry.outline)) {
      if (identifiers.has(name)) {
        out.push(kind === 'function' ? `${name}()` : name);
      }
    }
  }
  return out.slice(0, MAX_SYMBOLS);
}

/** Primera linea donde aparece `name` como palabra en el codigo (0 si no aparece). */
function firstUseLine(code: string, starts: number[], name: string, skip = -1) {
  const pattern = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`, 'g');
  for (const match of code.matchAll(pattern)) {
    const line = lineOfIndex(starts, match.index || 0);
    if (line !== skip) {
      return line;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Todo junto

/**
 * Dependencias del archivo activo: lo que usa del proyecto, las bibliotecas, lo que no se
 * encontro y los archivos que lo usan (por sus imports, guardados en el indice).
 */
export function resolveFileDependencies(input: DependencyInput): FileDependencies {
  const activePath = normalizePath(input.activePath);
  const family = dependencyFamily(input.language, activePath);
  // El activo cuenta aunque el indice no lo tenga (archivo recien creado, o un proyecto de mas de
  // 90 archivos): si no, «La usan» no encontraba los #include que llegan a el.
  const project = new ProjectFiles(input.files || [], [...(input.extraPaths || []), activePath], input.buildFiles || []);
  const result: FileDependencies = { family, local: [], libraries: [], missing: [], dependents: [], probes: [], expectedPaths: [] };
  const probes = new Set<string>();
  const expected = new Set<string>();
  const text = String(input.text || '');
  const activePackage = collectJavaPackage(text, family);

  if (family !== 'none') {
    const identifiers = collectIdentifiers(text, family);
    const options: ResolveOptions = { uses: (name) => identifiers.has(name), hints: true };
    const seen = new Set<string>();
    const imports = parseImports(text, family);
    for (const imp of imports) {
      for (const item of resolveImport(imp, activePath, family, project, options)) {
        if (item.type === 'local' && item.path === activePath) {
          // turtle.py con `import turtle` se importa a si mismo: el error clasico de nombrar el
          // archivo como la biblioteca. Se muestra la biblioteca con el aviso.
          const library = family === 'python' ? pythonLibrary(imp.specifier) : null;
          if (library && !seen.has(`library:${library.label}`)) {
            seen.add(`library:${library.label}`);
            result.libraries.push({
              label: library.label,
              line: imp.line,
              description: library.description || '',
              warning: `«import ${imp.specifier.split('.')[0]}» importa este mismo archivo (${basenameOf(activePath)}), no la biblioteca: cámbiale el nombre.`,
            });
          }
          continue; // se incluye a si mismo
        }
        // Un mismo archivo escrito de dos formas ("figura.h" y "./figura.h") va una vez.
        const key = item.type === 'local'
          ? (item.description || !item.path ? `package:${item.label}` : `local:${item.path}`)
          : `${item.type}:${item.label}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        if (item.probe && item.type !== 'local') {
          probes.add(item.probe);
        }
        if (item.type !== 'local') {
          (item.expected || []).forEach((path) => expected.add(path));
        }
        const base: FileDependencyItem = { label: item.label, line: imp.line };
        if (item.type === 'local') {
          const symbols = symbolsUsed(item, item.path ? project.entries.get(item.path) : undefined, identifiers);
          result.local.push({
            ...base,
            path: item.path,
            ...(item.description ? { description: item.description } : {}),
            ...(symbols.length ? { symbols } : {}),
            ...(item.warning ? { warning: item.warning } : {}),
          });
        } else if (item.type === 'library') {
          result.libraries.push({
            ...base,
            description: item.description || '',
            ...(item.warning ? { warning: item.warning } : {}),
            ...(item.guessed ? { guessed: true } : {}),
          });
        } else {
          result.missing.push({ ...base, description: item.description || '', ...(item.hint ? { hint: item.hint } : {}) });
        }
      }
    }

    // Java y C#: clases del mismo paquete (o del proyecto) que se usan sin import. Una clase
    // importada de otro paquete con el mismo nombre no cuenta (el import manda).
    if (family === 'java' || family === 'csharp') {
      const code = codeOnly(text, family);
      const starts = lineStartsOf(code);
      const own = stemOf(activePath);
      const already = new Set(result.local.map((item) => item.path));
      const imported = new Set(imports.map((imp) => imp.specifier.slice(imp.specifier.lastIndexOf('.') + 1)));
      // Java: el mismo paquete, en cualquier carpeta de fuentes (src/main/java y src/test/java),
      // o la misma carpeta si no se sabe el paquete.
      const candidates = family === 'java'
        ? [...new Set([...(activePackage ? project.javaPackages.get(activePackage) || [] : []), ...project.filesInDir(dirnameOf(activePath), '.java')])]
        : project.paths.filter((path) => path.toLowerCase().endsWith('.cs'));
      for (const path of candidates) {
        const name = stemOf(path);
        if (path === activePath || name === own || already.has(path) || imported.has(name) || !/^[A-Z]/.test(name) || !identifiers.has(name)) {
          continue;
        }
        result.local.push({ label: name, line: firstUseLine(code, starts, name), path, implicit: true });
      }
    }
  }

  // «La usan»: los archivos del proyecto cuyos imports llegan a este.
  const activeClass = family === 'java' || family === 'csharp' ? stemOf(activePath) : '';
  for (const file of input.files || []) {
    const path = normalizePath(file.path);
    if (path === activePath) {
      continue;
    }
    const fileFamily = dependencyFamily(file.language || '', path);
    if (fileFamily === 'none') {
      continue;
    }
    const refs = new Set(file.typeRefs || []);
    const options: ResolveOptions = { uses: (name) => refs.has(name), hints: false };
    let line = -1;
    for (const imp of file.imports || []) {
      if (resolveImport(imp, path, fileFamily, project, options).some((item) => item.type === 'local' && item.path === activePath)) {
        line = imp.line;
        break;
      }
    }
    const importsOtherWithSameName = (file.imports || []).some((imp) => imp.specifier.slice(imp.specifier.lastIndexOf('.') + 1) === activeClass);
    const samePackage = family === 'csharp'
      || dirnameOf(path) === dirnameOf(activePath)
      || (!!activePackage && file.javaPackage === activePackage);
    if (line < 0 && activeClass && fileFamily === family && refs.has(activeClass) && !importsOtherWithSameName && samePackage) {
      line = 0;
    }
    if (line >= 0) {
      result.dependents.push({ label: basenameOf(path), line, path, ...(line === 0 ? { implicit: true } : {}) });
    }
  }

  const byLine = (left: FileDependencyItem, right: FileDependencyItem) => (left.line || Number.MAX_SAFE_INTEGER) - (right.line || Number.MAX_SAFE_INTEGER);
  result.local = result.local.sort(byLine).slice(0, MAX_ITEMS_PER_GROUP);
  result.libraries = result.libraries.sort(byLine).slice(0, MAX_ITEMS_PER_GROUP);
  result.missing = result.missing.sort(byLine).slice(0, MAX_ITEMS_PER_GROUP);
  result.dependents = result.dependents
    .sort((left, right) => (left.path || '').localeCompare(right.path || ''))
    .slice(0, MAX_ITEMS_PER_GROUP);
  result.probes = [...probes].slice(0, MAX_PROBES);
  result.expectedPaths = [...expected].slice(0, MAX_PROBES * 2);
  return result;
}

/**
 * Una linea para el resumen del tutor: lo que usa del proyecto, las bibliotecas y quien lo usa.
 * Lo no encontrado no va: el indice no tiene todos los archivos y el tutor podria decirle al
 * estudiante que falta un archivo que si existe (la vista lo confirma buscando en el disco).
 */
export function formatDependenciesForPrompt(deps: FileDependencies | null, maxChars = 600) {
  if (!deps) {
    return '';
  }
  const parts: string[] = [];
  if (deps.local.length) {
    // Un paquete o un espacio de nombres va por su nombre, no por el primer archivo que tiene.
    parts.push(`usa del proyecto ${deps.local.slice(0, 8).map((item) => `${item.description || !item.path ? item.label : item.path}${item.symbols?.length ? ` (${item.symbols.join(', ')})` : ''}`).join(', ')}`);
  }
  if (deps.libraries.length) {
    parts.push(`bibliotecas ${deps.libraries.slice(0, 10).map((item) => item.label).join(', ')}`);
  }
  if (deps.dependents.length) {
    parts.push(`lo usan ${deps.dependents.slice(0, 8).map((item) => item.path || item.label).join(', ')}`);
  }
  if (!parts.length) {
    return '';
  }
  const text = `Dependencias del archivo: ${parts.join('; ')}.`;
  return text.length > maxChars ? `${text.slice(0, maxChars - 2)}….` : text;
}
