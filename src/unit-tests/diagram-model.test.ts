import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { parsePlantUmlClassDiagram } from '../class-diagram';
import { buildDependencyGraphView, compareDiagram, diagramTelemetryMetadata, hasDiagramMember } from '../diagram-model';
import { clipToBox, layeredLayout } from '../diagram-layout';
import { escapeXml, renderClassDiagramSvg, renderDependencyGraphSvg } from '../diagram-svg';
import { dependencyFamily, parseImports, resolveProjectDependencyGraph } from '../file-dependencies';
import { extractSourceClasses, mergeSourceClasses } from '../source-classes';
import { BANCO_PUML } from './diagram-fixtures';

// «Ver diagrama» (0.0.38): el diagrama del taller comparado con lo que escribio el estudiante.

const CLIENTE_H = [
  '#ifndef CLIENTE_H',
  '#define CLIENTE_H',
  '#include <string>',
  'using namespace std;',
  '// class Comentada { };',
  'class Cliente {',
  'private:',
  '    string identificacion;',
  '    string nombre, telefono;',
  'public:',
  '    Cliente(string identificacion, string nombre, string telefono);',
  '    string getIdentificacion() const;',
  '    string getNombre() const { return nombre; }',
  '};',
  '#endif',
].join('\n');

const CUENTA_H = [
  '#pragma once',
  '#include <string>',
  'class Cuenta {',
  'protected:',
  '    std::string id;',
  '    long saldo{0};',
  'public:',
  '    virtual bool retirarDinero(long cantidad);',
  '    virtual ~Cuenta() = default;',
  '};',
  'class CuentaAhorros : public Cuenta {',
  '    double tasaInteres = 0.02;',
  '};',
].join('\n');

const CUENTA_CPP = [
  '#include "Cuenta.h"',
  'bool Cuenta::retirarDinero(long cantidad) {',
  '    if (cantidad > saldo) { return false; }',
  '    saldo -= cantidad;',
  '    return true;',
  '}',
  'void CuentaAhorros::aplicarInteres() {',
  '    saldo += saldo * tasaInteres;',
  '}',
].join('\n');

const BANCO_H = [
  '#include <vector>',
  '#include "Cliente.h"',
  '#include "Cuenta.h"',
  'class Banco {',
  '    std::vector<Cliente*> clientes;',
  '    std::vector<Cuenta*> cuentas;',
  'public:',
  '    Cuenta* abrirCuenta(const std::string& idCliente, long monto);',
  '};',
].join('\n');

function studentClasses() {
  return mergeSourceClasses([
    ...extractSourceClasses(CLIENTE_H, 'include/Cliente.h', 'cpp'),
    ...extractSourceClasses(CUENTA_H, 'include/Cuenta.h', 'cpp'),
    ...extractSourceClasses(CUENTA_CPP, 'src/Cuenta.cpp', 'cpp'),
    ...extractSourceClasses(BANCO_H, 'include/Banco.h', 'cpp'),
  ]);
}

describe('clases del codigo del estudiante (0.0.38)', () => {
  it('C++: atributos, metodos, constructor, destructor y herencia; sin lo comentado', () => {
    const classes = extractSourceClasses(CLIENTE_H, 'include/Cliente.h', 'cpp');
    assert.deepEqual(classes.map((item) => item.name), ['Cliente']);
    assert.deepEqual(classes[0].members, ['identificacion', 'nombre', 'telefono', 'Cliente', 'getIdentificacion', 'getNombre']);
    assert.equal(classes[0].line, 6);
    const cuentas = extractSourceClasses(CUENTA_H, 'include/Cuenta.h', 'cpp');
    assert.deepEqual(cuentas.map((item) => item.name), ['Cuenta', 'CuentaAhorros']);
    assert.deepEqual(cuentas[0].members, ['id', 'saldo', 'retirarDinero', '~Cuenta']);
    assert.deepEqual(cuentas[1].bases, ['Cuenta']);
    assert.deepEqual(cuentas[1].members, ['tasaInteres']);
  });

  it('C++: los metodos definidos en el .cpp se suman a la clase del .h', () => {
    const merged = studentClasses();
    assert.deepEqual(merged.get('CuentaAhorros')?.members, ['tasaInteres', 'aplicarInteres']);
    assert.equal(merged.get('CuentaAhorros')?.path, 'include/Cuenta.h', 'la declaracion manda para abrir');
    assert.deepEqual(merged.get('Banco')?.fieldTypes.includes('Cuenta'), true);
  });

  it('Java, Python, C# y TypeScript', () => {
    const java = extractSourceClasses([
      'package banco;',
      'public class CuentaAhorros extends Cuenta implements Comparable<Cuenta> {',
      '    private double tasaInteres;',
      '    private final List<Cliente> titulares = new ArrayList<>();',
      '    public CuentaAhorros(String id) { super(id); }',
      '    @Override',
      '    public boolean retirarDinero(long cantidad) { return false; }',
      '}',
    ].join('\n'), 'src/CuentaAhorros.java', 'java');
    assert.deepEqual(java[0].bases, ['Cuenta', 'Comparable']);
    assert.deepEqual(java[0].members, ['tasaInteres', 'titulares', 'CuentaAhorros', 'retirarDinero']);
    assert.ok(java[0].fieldTypes.includes('Cliente'));

    const python = extractSourceClasses([
      'class Cuenta(Base):',
      '    """Una cuenta. class Falsa: no cuenta"""',
      '    total = 0',
      '    def __init__(self, id: str):',
      '        self.id = id',
      '        self._saldo: int = 0',
      '        self.titular = Cliente("x")',
      '    def retirar_dinero(self, cantidad):',
      '        return True',
      '',
      'class Otra:',
      '    pass',
    ].join('\n'), 'cuenta.py', 'python');
    assert.deepEqual(python.map((item) => item.name), ['Cuenta', 'Otra']);
    assert.deepEqual(python[0].bases, ['Base']);
    assert.deepEqual(python[0].members, ['total', '__init__', 'id', '_saldo', 'titular', 'retirar_dinero']);
    assert.ok(python[0].fieldTypes.includes('Cliente'));

    const csharp = extractSourceClasses('public class Banco : IBanco { public long Saldo { get; set; } private List<Cuenta> cuentas; public void Abrir() { } }', 'Banco.cs', 'csharp');
    assert.deepEqual(csharp[0].bases, ['IBanco']);
    assert.deepEqual(csharp[0].members, ['Saldo', 'cuentas', 'Abrir']);

    const ts = extractSourceClasses('export class Cuenta extends Base {\n  private saldo: number = 0;\n  retirar = (c: number) => true;\n  constructor(id: string) { super(); this.id = id; }\n  depositar(c: number): void {}\n}', 'cuenta.ts', 'typescript');
    assert.deepEqual(ts[0].members, ['saldo', 'retirar', 'constructor', 'id', 'depositar']);
  });

  it('C++: plantillas, espacios de nombres y llamadas Clase::f() dentro de funciones', () => {
    const lista = extractSourceClasses('template <class T>\nclass Lista {\n  T* datos;\n public:\n  void agregar(T x);\n};', 'Lista.h', 'cpp');
    assert.deepEqual(lista.map((item) => item.name), ['Lista'], 'el class de template <class T> no es una clase');
    assert.deepEqual(lista[0].members, ['datos', 'agregar']);
    const cpp = extractSourceClasses([
      'namespace banco {',
      'bool Cuenta::retirar(long c) {',
      '  if (Util::valida(c)) { return true; }',
      '  return Reporte::imprimir(c) {};',
      '}',
      '}',
    ].join('\n'), 'Cuenta.cpp', 'cpp');
    assert.deepEqual(cpp.map((item) => `${item.name}:${item.members.join(',')}`), ['Cuenta:retirar'], 'Util::valida es una llamada');
  });

  it('nunca lanza', () => {
    for (const text of ['class {', 'class A : public {', 'struct B { int x', '}}}} class', 'class C(']) {
      assert.doesNotThrow(() => extractSourceClasses(text, 'a.cpp', 'cpp'));
      assert.doesNotThrow(() => extractSourceClasses(text, 'a.py', 'python'));
    }
  });
});

describe('comparar el diagrama con el codigo (0.0.38)', () => {
  it('el taller del banco: hecha, a medias (con lo que falta) y falta; las relaciones hechas', () => {
    const view = compareDiagram(parsePlantUmlClassDiagram(BANCO_PUML), studentClasses(), 'docs/diagrama-clases.puml');
    const status = Object.fromEntries(view.classes.map((item) => [item.name, item.status]));
    assert.deepEqual(status, {
      Cliente: 'done',
      Cuenta: 'done',
      CuentaAhorros: 'done',
      CuentaCorriente: 'missing',
      Titularidad: 'missing',
      Banco: 'partial',
    });
    const banco = view.classes.find((item) => item.name === 'Banco');
    assert.deepEqual(banco?.missingMembers, ['~Banco()'], 'el destructor que pide el diagrama');
    assert.equal(banco?.path, 'include/Banco.h');
    assert.deepEqual(view.classes.find((item) => item.name === 'CuentaCorriente')?.missingMembers, ['sobregiro', 'retirarDinero()']);
    assert.deepEqual(view.counts, { classes: 6, done: 3, partial: 1, missing: 2 });
    const relation = (from: string, to: string) => view.relations.find((item) => item.from === from && item.to === to)?.done;
    assert.equal(relation('CuentaAhorros', 'Cuenta'), true, 'class CuentaAhorros : public Cuenta');
    assert.equal(relation('CuentaCorriente', 'Cuenta'), false);
    assert.equal(relation('Banco', 'Cuenta'), true, 'vector<Cuenta*> cuentas');
    assert.equal(relation('Banco', 'Cliente'), true);
  });

  it('nombres con _ o m_ y el constructor de Python cuentan', () => {
    const diagram = parsePlantUmlClassDiagram('class Cuenta {\n - saldo : int\n + Cuenta(id : str)\n + ~Cuenta()\n}');
    const python = mergeSourceClasses(extractSourceClasses('class Cuenta:\n    def __init__(self, id):\n        self.__saldo = 0\n', 'cuenta.py', 'python'));
    assert.equal(compareDiagram(diagram, python).classes[0].status, 'done', 'Python no tiene destructores que escribir');
    const cpp = mergeSourceClasses(extractSourceClasses('class Cuenta {\n int m_saldo;\n public: Cuenta(std::string id);\n};', 'Cuenta.h', 'cpp'));
    assert.deepEqual(compareDiagram(diagram, cpp).classes[0].missingMembers, ['~Cuenta()']);
    const member = diagram.classes[0].members[0];
    assert.equal(hasDiagramMember(member, { name: 'Cuenta', path: 'a.h', line: 1, bases: [], members: ['saldo_'], fieldTypes: [], usedTypes: [] }), true);
  });

  it('la telemetria lleva solo cuentas', () => {
    const target = compareDiagram(parsePlantUmlClassDiagram(BANCO_PUML), studentClasses());
    const metadata = diagramTelemetryMetadata(target);
    assert.deepEqual(metadata, { classes: 6, done: 3, partial: 1, missing: 2 });
    assert.doesNotMatch(JSON.stringify(metadata), /Cuenta|Banco|\.h/, 'sin nombres de clases ni de archivos');
    assert.deepEqual(diagramTelemetryMetadata(null), { classes: 0, done: 0, partial: 0, missing: 0 });
  });
});

describe('grafo de archivos del proyecto (0.0.38)', () => {
  function indexFile(path: string, text: string, language: string) {
    return { path, language, imports: parseImports(text, dependencyFamily(language, path)) };
  }

  it('aristas entre archivos propios, bibliotecas aparte y lo no encontrado', () => {
    const graph = resolveProjectDependencyGraph({
      files: [
        indexFile('src/main.cpp', '#include <iostream>\n#include "Banco.h"\n#include "Reporte.h"', 'cpp'),
        indexFile('src/Banco.h', '#include <vector>\n#include "Cuenta.h"\n#include "Cliente.h"', 'cpp'),
        indexFile('src/Cuenta.h', '#include <string>', 'cpp'),
        indexFile('src/Cliente.h', '#include <string>', 'cpp'),
        indexFile('README.md', '# hola', 'markdown'),
      ],
    });
    assert.deepEqual(graph.files, ['src/main.cpp', 'src/Banco.h', 'src/Cuenta.h', 'src/Cliente.h']);
    assert.deepEqual(graph.edges, [
      { from: 'src/main.cpp', to: 'src/Banco.h' },
      { from: 'src/Banco.h', to: 'src/Cuenta.h' },
      { from: 'src/Banco.h', to: 'src/Cliente.h' },
    ]);
    assert.deepEqual(graph.missing.map((item) => `${item.from}:${item.label}`), ['src/main.cpp:Reporte.h']);
    assert.deepEqual(graph.libraries.map((item) => `${item.label}x${item.count}`), ['string x2'.replace(' ', ''), 'iostreamx1', 'vectorx1']);

    const view = buildDependencyGraphView(graph, 'src/Banco.h');
    assert.equal(view.nodes.find((node) => node.active)?.path, 'src/Banco.h');
    assert.deepEqual(view.nodes.find((node) => node.path === 'src/main.cpp')?.missing, ['Reporte.h']);
    const small = buildDependencyGraphView(graph, 'src/Cuenta.h', 2);
    assert.equal(small.nodes.length, 2);
    assert.equal(small.hidden, 2);
    assert.ok(small.nodes.some((node) => node.path === 'src/Cuenta.h'), 'el activo siempre entra');
  });
});

describe('acomodo y dibujo (0.0.38)', () => {
  it('padre arriba e hijas abajo, sin cajas encimadas, aun con ciclos', () => {
    const nodes = ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id, width: 120, height: 50 }));
    const layout = layeredLayout(nodes, [{ from: 'A', to: 'B' }, { from: 'A', to: 'C' }, { from: 'C', to: 'D' }, { from: 'D', to: 'A' }]);
    const box = (id: string) => layout.boxes.get(id)!;
    assert.ok(box('A').y < box('B').y);
    assert.ok(box('C').y < box('D').y);
    assert.ok(box('E').y > box('D').y, 'la caja suelta va al final');
    const all = [...layout.boxes.values()];
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const a = all[i];
        const b = all[j];
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        assert.equal(overlap, false);
      }
    }
    assert.ok(layout.width >= 120 && layout.height >= 50);
    const point = clipToBox({ x: 0, y: 0, width: 100, height: 40 }, 50, 200);
    assert.deepEqual(point, { x: 50, y: 40 });
  });

  it('el SVG del taller: una caja por clase con su estado, flechas UML y texto escapado', () => {
    const target = compareDiagram(parsePlantUmlClassDiagram(BANCO_PUML), studentClasses());
    const svg = renderClassDiagramSvg(target);
    assert.equal((svg.match(/class="node class /g) || []).length, 6);
    assert.match(svg, /class="node class done openable"[^>]*data-open="include\/Cliente\.h"/);
    assert.match(svg, /class="node class missing" [^>]*role="img"/, 'lo que falta no se abre');
    assert.match(svg, /a medias · \d+ de \d+/);
    assert.match(svg, /– ~Banco\(\)/);
    assert.match(svg, /marker-end="url\(#cd-tri-done\)"/, 'herencia hecha');
    assert.match(svg, /marker-end="url\(#cd-dia-fill-done\)"/, 'composicion');
    assert.doesNotMatch(svg, /<script/i);
    const evil = renderClassDiagramSvg({ ...target, classes: [{ ...target.classes[0], name: '<script>x</script>', path: '"><img>' }], relations: [] });
    assert.doesNotMatch(evil, /<script>|"><img>/);
    assert.equal(escapeXml('a<b>&"\''), 'a&lt;b&gt;&amp;&quot;&#39;');
  });

  it('el SVG de los archivos: el activo resaltado y lo no encontrado en aviso', () => {
    const svg = renderDependencyGraphSvg({
      nodes: [
        { path: 'src/main.cpp', label: 'main.cpp', folder: 'src', active: true, missing: ['Reporte.h'] },
        { path: 'src/Banco.h', label: 'Banco.h', folder: 'src', active: false, missing: [] },
      ],
      edges: [{ from: 'src/main.cpp', to: 'src/Banco.h' }],
      libraries: [],
      missing: [],
      hidden: 0,
    });
    assert.match(svg, /class="node file active warn openable"/);
    assert.match(svg, /1 sin encontrar/);
    assert.match(svg, /class="edge file-edge hot"/);
    assert.equal(renderDependencyGraphSvg({ nodes: [], edges: [], libraries: [], missing: [], hidden: 0 }), '');
  });
});
