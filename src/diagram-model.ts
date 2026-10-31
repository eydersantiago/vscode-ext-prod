// ADACEEN (VS Code): lo que muestra «Ver diagrama» (0.0.38), sin importar vscode.
//
//   «Cómo debe quedar»: cada clase del diagrama del taller comparada con el codigo del
//   estudiante: hecha (existe con todo lo del diagrama), a medias (existe y le faltan atributos o
//   metodos: se dicen cuales, solo los nombres) o falta. Las relaciones (herencia, composicion,
//   asociacion...) se marcan hechas si el codigo ya las tiene (`class CuentaAhorros : public
//   Cuenta`, un atributo del tipo de la otra clase).
//   «Dependencias de tu proyecto»: los archivos del proyecto y quien incluye o importa a quien,
//   con el archivo activo resaltado y los #include que no se encontraron.
// Se prueba con node:test.
import { assertNeverRelation } from './class-diagram';
import type { ClassDiagram, DiagramClassKind, DiagramMember, DiagramRelationKind } from './class-diagram';
import type { ProjectDependencyGraph } from './file-dependencies';
import type { SourceClass } from './source-classes';

export type ClassStatus = 'done' | 'partial' | 'missing';

export type DiagramClassView = {
  name: string;
  kind: DiagramClassKind;
  status: ClassStatus;
  /** Archivo del estudiante donde esta la clase ('' si falta). */
  path: string;
  line: number;
  /** Lo que el diagrama pide y el codigo no tiene: «saldo», «retirarDinero()», «Cliente()». */
  missingMembers: string[];
  /** Cuantos miembros del diagrama ya estan, de cuantos. */
  present: number;
  total: number;
};

export type DiagramRelationView = {
  from: string;
  to: string;
  kind: DiagramRelationKind;
  label: string;
  fromMultiplicity: string;
  toMultiplicity: string;
  /** El codigo ya tiene la relacion. */
  done: boolean;
};

export type DiagramCounts = { classes: number; done: number; partial: number; missing: number };

export type DiagramTargetView = {
  /** Ruta del archivo del diagrama (para el subtitulo). */
  sourcePath: string;
  title: string;
  classes: DiagramClassView[];
  relations: DiagramRelationView[];
  counts: DiagramCounts;
};

export type DependencyNodeView = {
  /** Ruta relativa (identifica el nodo y se abre con un clic). */
  path: string;
  label: string;
  folder: string;
  active: boolean;
  /** Lo que incluye y no se encontro. */
  missing: string[];
};

export type DependencyGraphView = {
  nodes: DependencyNodeView[];
  edges: Array<{ from: string; to: string }>;
  libraries: Array<{ label: string; description: string; count: number }>;
  missing: Array<{ from: string; label: string; line: number; hint: string }>;
  /** Archivos del proyecto que no caben en el grafo. */
  hidden: number;
};

export type DiagramViewState = {
  status: 'loading' | 'ready';
  /** null: el taller no trae diagrama (o no se pudo leer). */
  target: DiagramTargetView | null;
  /** Por que no hay diagrama, o una nota sobre el (vacio si no hace falta). */
  targetNote: string;
  dependencies: DependencyGraphView;
  /** Hora local de la ultima lectura («14:32»). */
  updatedLabel: string;
};

const C_FAMILY_PATH = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|inl|ipp|tpp)$/i;
export const MAX_GRAPH_NODES = 24;

/**
 * Variantes de un nombre en el codigo que cuentan como el del diagrama: `_saldo`, `__saldo`
 * (Python privado), `saldo_` y `m_saldo` (C++).
 */
function memberAliases(name: string) {
  const out = new Set([name]);
  const stripped = name.replace(/^m_(?=\p{L})/u, '').replace(/^_+/, '').replace(/_+$/, '');
  if (stripped) {
    out.add(stripped);
  }
  return out;
}

/** ¿El codigo tiene ese miembro del diagrama? Constructor y destructor con sus equivalentes. */
export function hasDiagramMember(member: DiagramMember, source: SourceClass) {
  const names = new Set<string>();
  for (const name of source.members) {
    memberAliases(name).forEach((alias) => names.add(alias));
  }
  if (member.isConstructor) {
    return names.has(source.name) || names.has('__init__') || names.has('init') || names.has('constructor');
  }
  if (member.isDestructor) {
    // Fuera de C/C++ no hay destructores que escribir.
    return names.has(member.name) || names.has('__del__') || names.has('del') || !C_FAMILY_PATH.test(source.path);
  }
  return names.has(member.name);
}

/** Como se nombra un miembro que falta (solo el nombre: «saldo», «retirarDinero()»). */
export function memberLabel(member: DiagramMember) {
  return member.kind === 'method' ? `${member.name}()` : member.name;
}

function relationDone(kind: DiagramRelationKind, from: SourceClass | undefined, to: SourceClass | undefined) {
  if (!from || !to) {
    return false;
  }
  const has = (owner: SourceClass, list: 'fieldTypes' | 'usedTypes', name: string) => owner[list].includes(name);
  switch (kind) {
    case 'inheritance':
    case 'realization':
      return from.bases.includes(to.name);
    case 'composition':
    case 'aggregation':
      // El todo (from) guarda a la parte (to).
      return has(from, 'fieldTypes', to.name);
    case 'association':
      return has(from, 'fieldTypes', to.name) || has(from, 'usedTypes', to.name);
    case 'dependency':
      return has(from, 'usedTypes', to.name) || has(from, 'fieldTypes', to.name);
    case 'link':
      return has(from, 'fieldTypes', to.name) || has(to, 'fieldTypes', from.name)
        || has(from, 'usedTypes', to.name) || has(to, 'usedTypes', from.name);
    default:
      return assertNeverRelation(kind);
  }
}

/** El diagrama del taller comparado con las clases del codigo (mergeSourceClasses). */
export function compareDiagram(diagram: ClassDiagram, classes: Map<string, SourceClass>, sourcePath = ''): DiagramTargetView {
  const views: DiagramClassView[] = diagram.classes.map((item) => {
    const source = classes.get(item.name);
    const members = item.members;
    if (!source) {
      return { name: item.name, kind: item.kind, status: 'missing', path: '', line: 0, missingMembers: members.map(memberLabel), present: 0, total: members.length };
    }
    const missing = members.filter((member) => !hasDiagramMember(member, source));
    return {
      name: item.name,
      kind: item.kind,
      status: missing.length ? 'partial' : 'done',
      path: source.path,
      line: source.line,
      missingMembers: missing.map(memberLabel),
      present: members.length - missing.length,
      total: members.length,
    };
  });
  const relations = diagram.relations.map((relation) => ({
    ...relation,
    done: relationDone(relation.kind, classes.get(relation.from), classes.get(relation.to)),
  }));
  const counts: DiagramCounts = {
    classes: views.length,
    done: views.filter((item) => item.status === 'done').length,
    partial: views.filter((item) => item.status === 'partial').length,
    missing: views.filter((item) => item.status === 'missing').length,
  };
  return { sourcePath, title: diagram.title, classes: views, relations, counts };
}

function baseName(path: string) {
  return path.slice(path.lastIndexOf('/') + 1);
}

function folderOf(path: string) {
  const index = path.lastIndexOf('/');
  return index > 0 ? path.slice(0, index) : '';
}

/**
 * Los archivos que entran en el grafo (a lo sumo MAX_GRAPH_NODES): el activo, sus vecinos, los
 * que tienen mas conexiones y los que no encontraron algo; despues los demas en orden.
 */
export function buildDependencyGraphView(graph: ProjectDependencyGraph, activePath = '', maxNodes = MAX_GRAPH_NODES): DependencyGraphView {
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  }
  const missingBy = new Map<string, string[]>();
  for (const item of graph.missing) {
    const list = missingBy.get(item.from) || [];
    list.push(item.label);
    missingBy.set(item.from, list);
  }
  const neighbors = new Set(graph.edges.flatMap((edge) => (edge.from === activePath ? [edge.to] : edge.to === activePath ? [edge.from] : [])));
  const order = new Map(graph.files.map((path, index) => [path, index]));
  const priority = (path: string) => (path === activePath ? 1000 : 0)
    + (neighbors.has(path) ? 200 : 0)
    + (missingBy.has(path) ? 100 : 0)
    + Math.min(50, (degree.get(path) || 0) * 10);
  const chosen = [...graph.files]
    .sort((left, right) => priority(right) - priority(left) || (order.get(left) || 0) - (order.get(right) || 0))
    .slice(0, Math.max(1, maxNodes));
  const kept = new Set(chosen);
  // En el orden del proyecto (por carpeta y nombre): el dibujo no cambia de lugar al cambiar de pestaña.
  const nodes = [...kept]
    .sort((left, right) => left.localeCompare(right))
    .map((path) => ({ path, label: baseName(path), folder: folderOf(path), active: path === activePath, missing: missingBy.get(path) || [] }));
  return {
    nodes,
    edges: graph.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)),
    libraries: graph.libraries.slice(0, 30),
    missing: graph.missing.slice(0, 30),
    hidden: Math.max(0, graph.files.length - kept.size),
  };
}

/** Desde donde se abrio «Ver diagrama»: el value de vscode_diagram_opened. */
export type DiagramOpenOrigin = 'file_view' | 'command';

/**
 * Metadata de vscode_diagram_opened: solo cuentas de clases del diagrama (ni codigo, ni nombres
 * de archivos o de clases). Sin diagrama, todo en 0.
 */
export function diagramTelemetryMetadata(target: DiagramTargetView | null) {
  const counts = target?.counts || { classes: 0, done: 0, partial: 0, missing: 0 };
  return { classes: counts.classes, done: counts.done, partial: counts.partial, missing: counts.missing };
}

export const NO_DIAGRAM_NOTE = 'Este taller no trae un diagrama de clases (un archivo .puml en docs/, como docs/diagrama-clases.puml). Cuando tu docente lo agregue, aquí verás cómo debe quedar tu proyecto.';
export const EMPTY_DIAGRAM_NOTE = 'El archivo del diagrama no tiene clases que se puedan leer (¿es un diagrama de otro tipo?).';
