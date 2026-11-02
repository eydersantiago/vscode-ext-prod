// ADACEEN (VS Code): diagrama de clases del taller (0.0.38), sin importar vscode.
//
// Pedido del 30/10/2026: un boton «Ver diagrama» que muestre «Cómo debe quedar» el proyecto. Los
// talleres traen el diagrama en PlantUML (docs/diagrama-clases.puml); aqui se lee: clases, sus
// atributos y metodos con visibilidad, y las relaciones (herencia, composicion, agregacion,
// asociacion, dependencia). Tambien un `classDiagram` de Mermaid dentro de un .md. No dibuja: eso
// lo hacen diagram-layout.ts y diagram-svg.ts. Se prueba con node:test. Cada linea (nombre,
// miembro, relacion) se lee en class-diagram-lines.ts.

import { cleanClassName, NAME, parseDiagramMember, parseDiagramRelation, QUOTED, splitInlineBody } from './class-diagram-lines';

export type DiagramVisibility = '+' | '-' | '#' | '~' | '';

export type DiagramMember = {
  name: string;
  kind: 'attribute' | 'method';
  visibility: DiagramVisibility;
  /** Como esta escrito en el diagrama, sin la visibilidad (para el detalle). */
  text: string;
  isConstructor: boolean;
  isDestructor: boolean;
};

export type DiagramClassKind = 'class' | 'abstract' | 'interface' | 'enum' | 'struct';

export type DiagramClass = {
  name: string;
  kind: DiagramClassKind;
  members: DiagramMember[];
  /** Linea (1-based) donde se declara en el archivo del diagrama. */
  line: number;
};

/**
 * inheritance: from hereda de to. realization: from implementa la interfaz to. composition y
 * aggregation: from es el todo (lado del rombo) y to la parte. association y dependency: de
 * from hacia to (lado de la flecha). link: sin direccion.
 */
export type DiagramRelationKind = 'inheritance' | 'realization' | 'composition' | 'aggregation' | 'association' | 'dependency' | 'link';

export type DiagramRelation = {
  from: string;
  to: string;
  kind: DiagramRelationKind;
  label: string;
  fromMultiplicity: string;
  toMultiplicity: string;
};

export type ClassDiagram = {
  format: 'plantuml' | 'mermaid';
  title: string;
  classes: DiagramClass[];
  relations: DiagramRelation[];
};

/** Tope de lo que se lee: un diagrama de taller tiene decenas de lineas. */
const MAX_DIAGRAM_CHARS = 200_000;
const MAX_CLASSES = 60;
const MAX_MEMBERS = 60;
const MAX_RELATIONS = 120;

function emptyDiagram(format: ClassDiagram['format']): ClassDiagram {
  return { format, title: '', classes: [], relations: [] };
}

// ---------------------------------------------------------------------------------------------
// PlantUML

const CLASS_DECLARATION = new RegExp(
  String.raw`^(?<kind>abstract\s+class|abstract|class|interface|enum|struct|entity|annotation|protocol|exception)\s+(?<name>${QUOTED}|${NAME})(?:\s+as\s+(?<alias>${NAME}))?(?<rest>.*)$`,
  'iu',
);

function classKindOf(raw: string): DiagramClassKind {
  const kind = raw.toLowerCase();
  if (kind.startsWith('abstract')) {
    return 'abstract';
  }
  if (kind === 'interface' || kind === 'protocol') {
    return 'interface';
  }
  if (kind === 'enum') {
    return 'enum';
  }
  if (kind === 'struct') {
    return 'struct';
  }
  return 'class';
}

/** La `}` que cierra el cuerpo de la clase en esta linea (no la de `{static}` o `{abstract}`), o -1. */
function bodyCloseIndex(line: string) {
  let depth = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '{') {
      depth += 1;
    } else if (line[index] === '}') {
      if (depth === 0) {
        return index;
      }
      depth -= 1;
    }
  }
  return -1;
}

/** Sin los comentarios de PlantUML: `' linea` y `/' bloque '/`. */
function stripPlantUmlComments(text: string) {
  return text
    .replace(/\/'[\s\S]*?'\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*'/.test(line) ? '' : line));
}

class DiagramBuilder {
  private readonly byName = new Map<string, DiagramClass>();
  private readonly aliases = new Map<string, string>();
  readonly diagram: ClassDiagram;

  constructor(format: ClassDiagram['format']) {
    this.diagram = emptyDiagram(format);
  }

  ensureClass(rawName: string, kind: DiagramClassKind, line: number, alias = '') {
    const name = cleanClassName(rawName);
    if (alias) {
      this.aliases.set(cleanClassName(alias), name);
    }
    let entry = this.byName.get(name);
    if (!entry && this.diagram.classes.length < MAX_CLASSES) {
      entry = { name, kind, members: [], line };
      this.byName.set(name, entry);
      this.diagram.classes.push(entry);
    } else if (entry && kind !== 'class' && entry.kind === 'class') {
      entry.kind = kind;
    }
    return entry || null;
  }

  resolve(name: string) {
    return this.aliases.get(name) || name;
  }

  addMember(entry: DiagramClass | null, raw: string) {
    if (!entry || entry.members.length >= MAX_MEMBERS) {
      return;
    }
    if (entry.kind === 'enum') {
      // Los valores de un enum: una palabra por linea (o separados por comas).
      for (const value of raw.split(',').map((item) => item.trim()).filter((item) => /^[\p{L}_][\p{L}\p{N}_]*$/u.test(item))) {
        entry.members.push({ name: value, kind: 'attribute', visibility: '', text: value, isConstructor: false, isDestructor: false });
      }
      return;
    }
    const member = parseDiagramMember(raw, entry.name);
    if (member && !entry.members.some((item) => item.name === member.name && item.kind === member.kind)) {
      entry.members.push(member);
    }
  }

  addRelation(relation: DiagramRelation | null, line: number) {
    if (!relation || this.diagram.relations.length >= MAX_RELATIONS) {
      return;
    }
    const from = this.resolve(relation.from);
    const to = this.resolve(relation.to);
    // Una relacion con una clase que no se declaro la crea (PlantUML hace lo mismo).
    this.ensureClass(from, 'class', line);
    this.ensureClass(to, 'class', line);
    const resolved = { ...relation, from, to };
    const duplicate = this.diagram.relations.some((item) => item.from === from && item.to === to && item.kind === resolved.kind);
    if (!duplicate && from !== to) {
      this.diagram.relations.push(resolved);
    }
  }

  /** `class A extends B implements C, D` (sintaxis de PlantUML). */
  addHeaderRelations(name: string, rest: string, line: number) {
    const extendsMatch = /\bextends\s+([^{]+?)(?=\s+implements\b|\s*\{|\s*$)/i.exec(rest);
    const implementsMatch = /\bimplements\s+([^{]+?)(?=\s*\{|\s*$)/i.exec(rest);
    for (const parent of (extendsMatch?.[1] || '').split(',').map(cleanClassName).filter(Boolean)) {
      this.addRelation({ from: name, to: parent, kind: 'inheritance', label: '', fromMultiplicity: '', toMultiplicity: '' }, line);
    }
    for (const parent of (implementsMatch?.[1] || '').split(',').map(cleanClassName).filter(Boolean)) {
      this.addRelation({ from: name, to: parent, kind: 'realization', label: '', fromMultiplicity: '', toMultiplicity: '' }, line);
    }
  }
}

/**
 * Lee un diagrama de clases de PlantUML. Lo que no es de clases (notas, skinparam, title,
 * `left to right direction`, paquetes, `hide`/`show`) se salta; lo que no se entiende tambien
 * (nunca lanza).
 */
export function parsePlantUmlClassDiagram(source: string): ClassDiagram {
  const builder = new DiagramBuilder('plantuml');
  const lines = stripPlantUmlComments(String(source || '').slice(0, MAX_DIAGRAM_CHARS).replace(/\r\n?/g, '\n'));
  let body: DiagramClass | null = null;
  let inBody = false;
  let skipUntil: RegExp | null = null;
  let skinDepth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    if (skipUntil) {
      if (skipUntil.test(line)) {
        skipUntil = null;
      }
      continue;
    }
    if (skinDepth > 0) {
      skinDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      continue;
    }
    if (inBody) {
      const close = bodyCloseIndex(line);
      const content = close >= 0 ? line.slice(0, close) : line;
      if (content.trim()) {
        builder.addMember(body, content);
      }
      if (close >= 0) {
        inBody = false;
        body = null;
      }
      continue;
    }
    if (/^@(?:start|end)uml\b/i.test(line) || /^(?:left\s+to\s+right|top\s+to\s+bottom)\s+direction\b/i.test(line)
      || /^(?:hide|show|remove|!|set\s|scale\b|allowmixing\b|together\b|newpage\b|caption\b|header\b|footer\b|legend\b|end\s*legend\b)/i.test(line)) {
      if (/^legend\b/i.test(line)) {
        skipUntil = /^end\s*legend\b/i;
      }
      continue;
    }
    const title = /^title\s+(.+)$/i.exec(line);
    if (title) {
      builder.diagram.title = title[1].trim().slice(0, 120);
      continue;
    }
    if (/^title\s*$/i.test(line)) {
      skipUntil = /^end\s*title\b/i;
      continue;
    }
    if (/^skinparam\b/i.test(line)) {
      skinDepth = Math.max(0, (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length);
      continue;
    }
    if (/^(?:note|legend|rnote|hnote)\b/i.test(line)) {
      // "note left of X : texto" y "note "..." as N" son de una linea; las demas terminan en "end note".
      if (!/:/.test(line) && !/^note\s+"[^"]*"\s+as\s+\w+/i.test(line)) {
        skipUntil = /^end\s*(?:note|legend|rnote|hnote)\b/i;
      }
      continue;
    }
    if (/^(?:package|namespace|folder|frame|node|rectangle|cloud|database)\b/i.test(line) || /^\}\s*$/.test(line)) {
      continue; // los paquetes solo agrupan: sus clases se leen igual
    }
    const declaration = CLASS_DECLARATION.exec(line);
    if (declaration?.groups) {
      const name = declaration.groups.alias ? cleanClassName(declaration.groups.alias) : cleanClassName(declaration.groups.name);
      const rest = declaration.groups.rest || '';
      // `class Figura <<abstract>>` o `<<interface>>`: el estereotipo dice el tipo.
      const stereotype = /<<\s*(abstract|interface|enum|struct)\b/i.exec(rest);
      const entry = builder.ensureClass(name, classKindOf(stereotype ? (stereotype[1].toLowerCase() === 'abstract' ? 'abstract class' : stereotype[1]) : declaration.groups.kind), lineNumber);
      builder.addHeaderRelations(name, rest, lineNumber);
      const open = rest.indexOf('{');
      if (open >= 0) {
        const after = rest.slice(open + 1);
        const close = after.lastIndexOf('}');
        if (close >= 0) {
          splitInlineBody(after.slice(0, close)).forEach((part) => builder.addMember(entry, part));
        } else {
          if (after.trim()) {
            splitInlineBody(after).forEach((part) => builder.addMember(entry, part));
          }
          inBody = true;
          body = entry;
        }
      }
      continue;
    }
    // "Cuenta : - saldo : long" (miembro fuera del cuerpo)
    const external = /^([\p{L}_][\p{L}\p{N}_]*)\s*:\s*(.+)$/u.exec(line);
    if (external) {
      builder.addMember(builder.ensureClass(builder.resolve(external[1]), 'class', lineNumber), external[2]);
      continue;
    }
    builder.addRelation(parseDiagramRelation(line), lineNumber);
  }
  return builder.diagram;
}

// ---------------------------------------------------------------------------------------------
// Mermaid (classDiagram dentro de un .md)

/** El primer bloque ```mermaid con `classDiagram` de un Markdown, o ''. */
export function extractMermaidClassDiagram(markdown: string) {
  const text = String(markdown || '').slice(0, MAX_DIAGRAM_CHARS).replace(/\r\n?/g, '\n');
  for (const match of text.matchAll(/```+\s*mermaid[^\n]*\n([\s\S]*?)```/gi)) {
    if (/^\s*classDiagram\b/.test(match[1])) {
      return match[1];
    }
  }
  return '';
}

/** Lee un `classDiagram` de Mermaid (clases, miembros y relaciones; lo demas se salta). */
export function parseMermaidClassDiagram(source: string): ClassDiagram {
  const builder = new DiagramBuilder('mermaid');
  const lines = String(source || '').slice(0, MAX_DIAGRAM_CHARS).replace(/\r\n?/g, '\n').split('\n');
  let body: DiagramClass | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].replace(/%%.*$/, '').trim();
    if (!line || /^classDiagram\b/.test(line) || /^(?:direction|note|style|classDef|cssClass|click|link|callback)\b/.test(line)) {
      continue;
    }
    if (body) {
      if (line.startsWith('}')) {
        body = null;
      } else if (!/^<<.*>>$/.test(line)) {
        builder.addMember(body, line);
      } else if (/interface/i.test(line)) {
        body.kind = 'interface';
      } else if (/abstract/i.test(line)) {
        body.kind = 'abstract';
      } else if (/enum/i.test(line)) {
        body.kind = 'enum';
      }
      continue;
    }
    const title = /^title\s*:?\s*(.+)$/i.exec(line);
    if (title) {
      builder.diagram.title = title[1].trim().slice(0, 120);
      continue;
    }
    const declaration = /^class\s+([\p{L}_][\p{L}\p{N}_]*)(?:~[^~]*~)?(?:\s*\[[^\]]*\])?\s*(\{)?\s*(?::::\w+)?$/u.exec(line);
    if (declaration) {
      const entry = builder.ensureClass(declaration[1], 'class', lineNumber);
      body = declaration[2] ? entry : null;
      continue;
    }
    const annotation = /^<<\s*(\w+)\s*>>\s*([\p{L}_][\p{L}\p{N}_]*)$/u.exec(line);
    if (annotation) {
      const kind = /interface/i.test(annotation[1]) ? 'interface' : /abstract/i.test(annotation[1]) ? 'abstract' : /enum/i.test(annotation[1]) ? 'enum' : 'class';
      builder.ensureClass(annotation[2], kind, lineNumber);
      continue;
    }
    const relation = parseDiagramRelation(line);
    if (relation) {
      builder.addRelation(relation, lineNumber);
      continue;
    }
    const external = /^([\p{L}_][\p{L}\p{N}_]*)\s*:\s*(.+)$/u.exec(line);
    if (external) {
      builder.addMember(builder.ensureClass(external[1], 'class', lineNumber), external[2]);
    }
  }
  return builder.diagram;
}

// ---------------------------------------------------------------------------------------------
// Que archivo usar

/**
 * El diagrama del taller entre los archivos .puml / .plantuml del proyecto: primero
 * docs/diagrama-clases.puml; despues uno de docs/ que hable de clases; despues cualquiera de
 * docs/; despues uno de la raiz; al final el menos profundo. null si no hay.
 */
export function pickDiagramFile(paths: string[]): string | null {
  const candidates = paths
    .map((path) => String(path || '').replace(/\\/g, '/').replace(/^\.\/+/, ''))
    .filter((path) => /\.(?:puml|plantuml|pu|iuml|wsd)$/i.test(path));
  if (!candidates.length) {
    return null;
  }
  const score = (path: string) => {
    const lower = path.toLowerCase();
    const depth = path.split('/').length - 1;
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    const inDocs = /(?:^|\/)docs?\//.test(lower);
    let value = 0;
    if (/(?:^|\/)docs\/diagrama-clases\.puml$/.test(lower)) {
      value += 1000;
    }
    if (/clase|class/.test(base)) {
      value += 200;
    }
    if (inDocs) {
      value += 100;
    }
    if (depth === 0) {
      value += 50;
    }
    if (/secuencia|sequence|caso|usecase|actividad|activity|estado|state|componente|despliegue/.test(base)) {
      value -= 150;
    }
    return value - depth;
  };
  return [...candidates].sort((left, right) => score(right) - score(left) || left.localeCompare(right))[0];
}

/** Para los switch sobre el tipo de relacion: si aparece uno nuevo, tsc obliga a decidir como se dibuja. */
export function assertNeverRelation(kind: never): never {
  throw new Error(`Relacion de diagrama sin manejar: ${String(kind)}`);
}
