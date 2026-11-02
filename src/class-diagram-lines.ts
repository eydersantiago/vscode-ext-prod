// ADACEEN (VS Code): una linea del diagrama de clases (PlantUML o Mermaid): nombre de clase, miembro (atributo o metodo) y relacion.
// Movido sin cambios desde src/class-diagram.ts (solo se agrego "export" y los imports).
import type { DiagramMember, DiagramVisibility, DiagramRelation, DiagramRelationKind } from './class-diagram';

export const NAME = String.raw`[\p{L}_][\p{L}\p{N}_$]*(?:(?:\.|::)[\p{L}_][\p{L}\p{N}_$]*)*(?:<[^<>{}]*>)?`;
export const QUOTED = String.raw`"[^"\n]+"`;
const IDENTIFIER = /[\p{L}_][\p{L}\p{N}_]*/gu;

/** "Cuenta<T>" -> "Cuenta"; "banco.Cuenta" -> "Cuenta"; "\"Cuenta Ahorros\"" -> "Cuenta Ahorros". */
export function cleanClassName(raw: string) {
  let name = String(raw || '').trim();
  if (name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).trim();
  }
  name = name.replace(/<[\s\S]*$/, '').replace(/~[^~]*~$/, '').trim();
  const parts = name.split(/::|\./).filter(Boolean);
  return (parts[parts.length - 1] || name).trim();
}

function identifiers(text: string): string[] {
  return text.match(IDENTIFIER) || [];
}

/** ¿El texto empieza llamando a `name`? ("Cliente(x : int)" con name "Cliente"). */
function startsWithCall(text: string, name: string) {
  const head = /^([\p{L}_][\p{L}\p{N}_]*)\s*\(/u.exec(text);
  return !!head && head[1] === name;
}

// ---------------------------------------------------------------------------------------------
// Miembros

/**
 * Un atributo o metodo del cuerpo de una clase, en PlantUML (`- saldo : long`,
 * `+ retirarDinero(cantidad : long) : bool`, `{static} - total : int`) o al estilo C++/Java/Mermaid
 * (`- long saldo`, `+bool retirar(long c)`, `+retirar(cantidad) bool`). null si no es un miembro
 * (separadores `--`, `..`, `==`, `__`, comentarios, lineas vacias).
 */
export function parseDiagramMember(raw: string, className: string): DiagramMember | null {
  let text = String(raw || '').trim().replace(/;$/, '').trim();
  if (!text || /^(?:--|\.\.|==|__)/.test(text) || text.startsWith("'") || text.startsWith('%%')) {
    return null;
  }
  let forced: DiagramMember['kind'] | '' = '';
  for (;;) {
    const modifier = /^\{(static|abstract|classifier|field|method)\}\s*/i.exec(text);
    if (!modifier) {
      break;
    }
    if (/field/i.test(modifier[1])) {
      forced = 'attribute';
    } else if (/method/i.test(modifier[1])) {
      forced = 'method';
    }
    text = text.slice(modifier[0].length);
  }
  let visibility: DiagramVisibility = '';
  const vis = /^([+\-#~])\s*/.exec(text);
  if (vis) {
    const rest = text.slice(vis[0].length);
    // "~Cliente()" es el destructor (sin visibilidad), no un metodo de paquete llamado Cliente.
    const destructor = vis[1] === '~' && vis[0] === '~' && startsWithCall(rest, className);
    if (!destructor) {
      visibility = vis[1] as DiagramVisibility;
      text = rest;
    }
  }
  // Clasificadores de Mermaid: "retirar()$" (estatico) o "area()*" (abstracto).
  text = text.replace(/[$*]\s*$/, '').trim();
  if (!text) {
    return null;
  }
  const paren = text.indexOf('(');
  const colon = text.indexOf(':');
  const isMethod = forced === 'method' || (forced !== 'attribute' && paren >= 0 && (colon < 0 || paren < colon));
  if (isMethod && paren >= 0) {
    const head = text.slice(0, paren).trim();
    const destructor = /~\s*([\p{L}_][\p{L}\p{N}_]*)$/u.exec(head);
    const words = identifiers(head);
    const name = destructor ? `~${destructor[1]}` : words[words.length - 1] || '';
    if (!name || /^operator/.test(name) || words.includes('operator')) {
      return null;
    }
    const bare = name.replace(/^~/, '');
    return {
      name,
      kind: 'method',
      visibility,
      text: text.replace(/\s+/g, ' '),
      isConstructor: !destructor && bare === className,
      isDestructor: !!destructor,
    };
  }
  // Atributo: "nombre : tipo" (UML) o "tipo nombre" (C++, Java, Mermaid).
  const declared = colon >= 0 ? text.slice(0, colon) : text.replace(/\s*=.*$/, '').replace(/\[[^\]]*\]/g, '');
  const words = identifiers(declared);
  const name = words[words.length - 1] || '';
  if (!name || name === className) {
    return null;
  }
  return { name, kind: 'attribute', visibility, text: text.replace(/\s+/g, ' '), isConstructor: false, isDestructor: false };
}

/**
 * Un cuerpo escrito en una sola linea (`class Cuenta { - id : string  - saldo : long  -- + retirar() : bool }`):
 * los separadores van aparte y cada miembro empieza en una visibilidad o despues de dos espacios.
 */
export function splitInlineBody(body: string) {
  return body
    .replace(/(^|\s)(?:--|\.\.|==|__)(?=\s|$)/g, '\n')
    .split(/\n|\s{2,}|\s+(?=[+\-#][\s\p{L}_{])|\s+(?=~\s*[\p{L}_])/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Relaciones

const ARROW = /^(?<head1><\||<|\*|o|\+|#|x|\}|\^)?(?<line1>-+|\.+)(?:\[[^\]]*\])?(?:(?:up|down|left|right|le|ri|do|u|d|l|r)(?=[-.]))?(?:\[[^\]]*\])?(?<line2>-*|\.*)(?<head2>\|>|>|\*|o|\+|#|x|\{|\^)?$/;

const RELATION = new RegExp(
  String.raw`^(?<a>${QUOTED}|${NAME})\s*(?:"(?<am>[^"]*)"\s*)?(?<arrow>[<>|*o+#x{}^.\-\[\]\w]+?)\s*(?:"(?<bm>[^"]*)"\s*)?(?<b>${QUOTED}|${NAME})\s*(?::\s*(?<label>.*))?$`,
  'u',
);

/** Una linea de relacion (`A -|> B`, `Banco "1" *-- "*" Cuenta : tiene`), o null. */
export function parseDiagramRelation(line: string): DiagramRelation | null {
  const match = RELATION.exec(String(line || '').trim());
  if (!match?.groups) {
    return null;
  }
  const arrow = ARROW.exec(match.groups.arrow);
  if (!arrow?.groups) {
    return null;
  }
  const head1 = arrow.groups.head1 || '';
  const head2 = arrow.groups.head2 || '';
  const dotted = (arrow.groups.line1 || '').startsWith('.');
  const a = cleanClassName(match.groups.a);
  const b = cleanClassName(match.groups.b);
  if (!a || !b) {
    return null;
  }
  const am = (match.groups.am || '').trim();
  const bm = (match.groups.bm || '').trim();
  // Etiqueta sin las flechas de lectura de PlantUML ("tiene >", "< usa").
  const label = (match.groups.label || '').replace(/^\s*[<>]\s*|\s*[<>]\s*$/g, '').trim().slice(0, 60);
  const make = (kind: DiagramRelationKind, reversed: boolean): DiagramRelation => reversed
    ? { from: b, to: a, kind, label, fromMultiplicity: bm, toMultiplicity: am }
    : { from: a, to: b, kind, label, fromMultiplicity: am, toMultiplicity: bm };
  const triangle = (head: string) => head === '<|' || head === '|>' || head === '^';
  if (triangle(head1) || triangle(head2)) {
    // Hereda (o implementa) el lado sin el triangulo.
    return make(dotted ? 'realization' : 'inheritance', triangle(head1));
  }
  if (head1 === '*' || head2 === '*') {
    return make('composition', head2 === '*' && head1 !== '*');
  }
  if (head1 === 'o' || head2 === 'o') {
    return make('aggregation', head2 === 'o' && head1 !== 'o');
  }
  if (head1 === '<' || head2 === '>') {
    return make(dotted ? 'dependency' : 'association', head1 === '<' && head2 !== '>');
  }
  if (head1 || head2) {
    // +--, #--, x--, }-- : se dibujan como una relacion simple.
    return make('link', false);
  }
  return make(dotted ? 'dependency' : 'link', false);
}
