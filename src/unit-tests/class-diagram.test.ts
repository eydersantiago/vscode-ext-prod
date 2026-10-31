import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  cleanClassName,
  extractMermaidClassDiagram,
  parseDiagramMember,
  parseDiagramRelation,
  parseMermaidClassDiagram,
  parsePlantUmlClassDiagram,
  pickDiagramFile,
} from '../class-diagram';
import { BANCO_PUML } from './diagram-fixtures';

// «Ver diagrama» (0.0.38): el diagrama de clases del taller, como lo trae el repositorio.

describe('diagrama de clases en PlantUML (0.0.38)', () => {
  it('lee el diagrama del taller del banco: clases, miembros y relaciones', () => {
    const diagram = parsePlantUmlClassDiagram(BANCO_PUML);
    assert.equal(diagram.title, 'Diagrama de Clases - Sistema Bancario');
    assert.deepEqual(diagram.classes.map((item) => item.name), ['Cliente', 'Cuenta', 'CuentaAhorros', 'CuentaCorriente', 'Titularidad', 'Banco']);
    const cliente = diagram.classes[0];
    assert.deepEqual(cliente.members.map((item) => `${item.visibility}${item.name}:${item.kind}`), [
      '-identificacion:attribute', '-nombre:attribute', '-telefono:attribute',
      '+Cliente:method', '+getIdentificacion:method', '+getNombre:method',
    ]);
    assert.equal(cliente.members[3].isConstructor, true);
    const cuenta = diagram.classes[1];
    assert.deepEqual(cuenta.members.map((item) => item.name), ['id', 'saldo', 'retirarDinero'], 'cuerpo en una sola linea');
    assert.deepEqual(diagram.classes[2].members.map((item) => item.name), ['tasaInteres', 'aplicarInteres']);
    assert.deepEqual(diagram.classes[4].members.map((item) => item.name), ['cliente', 'cuenta'], 'atributos con puntero, sin separador');
    const banco = diagram.classes[5];
    assert.equal(banco.members.find((item) => item.name === '~Banco')?.isDestructor, true, '~Banco() es el destructor, no visibilidad de paquete');
    assert.deepEqual(diagram.relations.map((item) => `${item.from} ${item.kind} ${item.to}`), [
      'CuentaAhorros inheritance Cuenta',
      'CuentaCorriente inheritance Cuenta',
      'Banco composition Cuenta',
      'Banco aggregation Cliente',
      'Titularidad association Cliente',
      'Titularidad association Cuenta',
    ]);
    const composition = diagram.relations[2];
    assert.equal(composition.label, 'tiene');
    assert.equal(composition.fromMultiplicity, '1');
    assert.equal(composition.toMultiplicity, '0..*');
  });

  it('las flechas en ambos sentidos y con direccion', () => {
    const kinds = (line: string) => {
      const relation = parseDiagramRelation(line);
      return relation ? `${relation.from} ${relation.kind} ${relation.to}` : null;
    };
    assert.equal(kinds('A <|-- B'), 'B inheritance A');
    assert.equal(kinds('B --|> A'), 'B inheritance A');
    assert.equal(kinds('B -up-|> A'), 'B inheritance A');
    assert.equal(kinds('B ..|> Volador'), 'B realization Volador');
    assert.equal(kinds('Volador <|.. B'), 'B realization Volador');
    assert.equal(kinds('Parte --* Todo'), 'Todo composition Parte');
    assert.equal(kinds('Todo *-- Parte'), 'Todo composition Parte');
    assert.equal(kinds('Todo o-- Parte'), 'Todo aggregation Parte');
    assert.equal(kinds('A --> B'), 'A association B');
    assert.equal(kinds('B <-- A'), 'A association B');
    assert.equal(kinds('A ..> B : usa'), 'A dependency B');
    assert.equal(kinds('A -- B'), 'A link B');
    assert.equal(kinds('A -[#red]-> B'), 'A association B');
    assert.equal(kinds('skinparam groupInheritance 2'), null);
    assert.equal(kinds('left to right direction'), null);
  });

  it('se salta notas, skinparam con llaves, comentarios de bloque y paquetes', () => {
    const diagram = parsePlantUmlClassDiagram([
      '@startuml',
      "/' comentario",
      'class Fantasma',
      "'/",
      'skinparam class {',
      '  BackgroundColor White',
      '}',
      'package modelo {',
      '  class Figura <<abstract>> {',
      '    {abstract} + area() : double',
      '    {static} - total : int',
      '  }',
      '  interface Dibujable',
      '  enum Color {',
      '    ROJO',
      '    VERDE, AZUL',
      '  }',
      '}',
      'note "suelta" as N1',
      'abstract class Base',
      'class Circulo extends Figura implements Dibujable',
      'Circulo : - radio : double',
      '@enduml',
    ].join('\n'));
    assert.deepEqual(diagram.classes.map((item) => `${item.name}:${item.kind}`), ['Figura:abstract', 'Dibujable:interface', 'Color:enum', 'Base:abstract', 'Circulo:class']);
    assert.deepEqual(diagram.classes[0].members.map((item) => `${item.name}:${item.kind}`), ['area:method', 'total:attribute']);
    assert.deepEqual(diagram.classes[2].members.map((item) => item.name), ['ROJO', 'VERDE', 'AZUL']);
    assert.deepEqual(diagram.classes[4].members.map((item) => item.name), ['radio']);
    assert.deepEqual(diagram.relations.map((item) => `${item.from} ${item.kind} ${item.to}`), ['Circulo inheritance Figura', 'Circulo realization Dibujable']);
  });

  it('miembros al estilo de C++ y Java tambien', () => {
    assert.deepEqual(parseDiagramMember('- long saldo', 'Cuenta'), { name: 'saldo', kind: 'attribute', visibility: '-', text: 'long saldo', isConstructor: false, isDestructor: false });
    assert.equal(parseDiagramMember('+bool retirar(long c)', 'Cuenta')?.name, 'retirar');
    assert.equal(parseDiagramMember('+ Cuenta()', 'Cuenta')?.isConstructor, true);
    assert.equal(parseDiagramMember('~ calcular() : int', 'Cuenta')?.visibility, '~', 'visibilidad de paquete');
    assert.equal(parseDiagramMember('--', 'Cuenta'), null);
    assert.equal(parseDiagramMember('+ operator==(o : Cuenta) : bool', 'Cuenta'), null);
    assert.equal(cleanClassName('"Cuenta Ahorros"'), 'Cuenta Ahorros');
    assert.equal(cleanClassName('banco.Cuenta<T>'), 'Cuenta');
  });

  it('nunca lanza con texto raro', () => {
    for (const text of ['', '@startuml\nclass {\n', 'class A {\n  + f(\n', '}}}}', 'A -- ', '"x" -- "y"', 'x'.repeat(5000)]) {
      assert.doesNotThrow(() => parsePlantUmlClassDiagram(text));
    }
  });
});

describe('diagrama de clases en Mermaid (0.0.38)', () => {
  it('lee el classDiagram de un Markdown', () => {
    const markdown = [
      '# Taller',
      '```mermaid',
      'classDiagram',
      '  class Cuenta {',
      '    -long saldo',
      '    +retirar(long cantidad) bool',
      '  }',
      '  class Volador',
      '  <<interface>> Volador',
      '  Cuenta <|-- CuentaAhorros',
      '  Banco "1" *-- "*" Cuenta : tiene',
      '  CuentaAhorros : +aplicarInteres()',
      '```',
    ].join('\n');
    const source = extractMermaidClassDiagram(markdown);
    assert.ok(source);
    const diagram = parseMermaidClassDiagram(source);
    assert.deepEqual(diagram.classes.map((item) => `${item.name}:${item.kind}`), ['Cuenta:class', 'Volador:interface', 'CuentaAhorros:class', 'Banco:class']);
    assert.deepEqual(diagram.classes[0].members.map((item) => item.name), ['saldo', 'retirar']);
    assert.deepEqual(diagram.classes[2].members.map((item) => item.name), ['aplicarInteres']);
    assert.deepEqual(diagram.relations.map((item) => `${item.from} ${item.kind} ${item.to}`), ['CuentaAhorros inheritance Cuenta', 'Banco composition Cuenta']);
    assert.equal(extractMermaidClassDiagram('```mermaid\nsequenceDiagram\nA->>B: hola\n```'), '', 'solo diagramas de clases');
  });
});

describe('que archivo de diagrama usar (0.0.38)', () => {
  it('prefiere docs/diagrama-clases.puml, despues uno de clases en docs/, despues la raiz', () => {
    assert.equal(pickDiagramFile(['docs/secuencia.puml', 'docs/diagrama-clases.puml', 'otro.puml']), 'docs/diagrama-clases.puml');
    assert.equal(pickDiagramFile(['docs/secuencia.puml', 'docs/clases-banco.plantuml', 'modelo.puml']), 'docs/clases-banco.plantuml');
    assert.equal(pickDiagramFile(['src/a/b/x.puml', 'diagrama.puml']), 'diagrama.puml');
    assert.equal(pickDiagramFile(['src/main.cpp', 'README.md']), null);
  });
});
