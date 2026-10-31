// ADACEEN (VS Code): el SVG de «Ver diagrama» (0.0.38), sin importar vscode.
//
// Cajas con el nombre y un color de estado (hecha, a medias, falta), lineas con la forma de UML
// (triangulo: hereda; rombo lleno: compone; rombo vacio: agrega; flecha: usa) y el grafo de
// archivos del proyecto. Los colores no van aqui: cada elemento lleva una clase y la hoja de
// estilos de la vista usa las variables del tema de VS Code (claro, oscuro, alto contraste).
// Todo el texto va escapado: nombres de clases y archivos vienen del proyecto del estudiante.
// Se prueba con node:test.
import { edgeBetween, layeredLayout } from './diagram-layout';
import type { LayoutBox, LayoutEdge, LayoutNode } from './diagram-layout';
import type { DependencyGraphView, DiagramClassView, DiagramRelationView, DiagramTargetView } from './diagram-model';
import type { DiagramRelationKind } from './class-diagram';

const CHAR_WIDTH_NAME = 7.6;
const CHAR_WIDTH_SMALL = 6.4;
const MAX_MISSING_LINES = 4;

export function escapeXml(text: string) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch] as string));
}

/** Corta con «…» lo que no cabe en `max` caracteres. */
export function fitText(text: string, max: number) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function n(value: number) {
  return Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------------------------------------
// Diagrama de clases

const STATUS_TEXT: Record<DiagramClassView['status'], string> = {
  done: 'hecha',
  partial: 'a medias',
  missing: 'falta',
};

const KIND_TEXT: Partial<Record<DiagramClassView['kind'], string>> = {
  interface: '«interfaz»',
  abstract: '«abstracta»',
  enum: '«enum»',
  struct: '«struct»',
};

const RELATION_TEXT: Record<DiagramRelationKind, string> = {
  inheritance: 'hereda de',
  realization: 'implementa',
  composition: 'se compone de',
  aggregation: 'agrupa a',
  association: 'usa a',
  dependency: 'depende de',
  link: 'se relaciona con',
};

type ClassBoxText = { stereotype: string; name: string; status: string; missing: string[] };

function classBoxText(item: DiagramClassView): ClassBoxText {
  const status = item.status === 'partial'
    ? `a medias · ${item.present} de ${item.total}`
    : item.status === 'missing'
      ? 'falta'
      : 'hecha';
  const missing = item.missingMembers.slice(0, MAX_MISSING_LINES);
  const rest = item.missingMembers.length - missing.length;
  return {
    stereotype: KIND_TEXT[item.kind] || '',
    name: item.name,
    status,
    missing: rest > 0 ? [...missing, `y ${rest} más`] : missing,
  };
}

function classBoxSize(text: ClassBoxText) {
  const longest = Math.max(
    text.name.length * CHAR_WIDTH_NAME,
    text.status.length * CHAR_WIDTH_SMALL,
    ...text.missing.map((line) => (line.length + 2) * CHAR_WIDTH_SMALL),
  );
  const width = Math.round(clamp(longest + 30, 130, 240));
  const height = 10 + (text.stereotype ? 14 : 0) + 20 + 16 + (text.missing.length ? 4 + text.missing.length * 15 : 0) + 8;
  return { width, height };
}

/** Caja de arriba y de abajo de cada relacion: el padre y el todo arriba. */
function layoutEdgeOf(relation: DiagramRelationView): LayoutEdge {
  switch (relation.kind) {
    case 'inheritance':
    case 'realization':
      return { from: relation.to, to: relation.from };
    default:
      return { from: relation.from, to: relation.to };
  }
}

/**
 * El segmento en el sentido en que va la marca (siempre al final): hacia el padre (triangulo),
 * hacia el todo (rombo) o hacia la clase usada (flecha).
 */
function orientedSegment(relation: DiagramRelationView, boxes: Map<string, LayoutBox>) {
  const from = boxes.get(relation.from);
  const to = boxes.get(relation.to);
  if (!from || !to) {
    return null;
  }
  switch (relation.kind) {
    case 'composition':
    case 'aggregation':
      // Del lado de la parte hacia el todo: el rombo queda en el todo.
      return { segment: edgeBetween(to, from), startName: relation.to, endName: relation.from };
    default:
      return { segment: edgeBetween(from, to), startName: relation.from, endName: relation.to };
  }
}

const MARKERS: Record<DiagramRelationKind, string> = {
  inheritance: 'tri',
  realization: 'tri',
  composition: 'dia-fill',
  aggregation: 'dia',
  association: 'arrow',
  dependency: 'arrow',
  link: '',
};

function markerDefs(prefix: string) {
  const defs: string[] = [];
  for (const state of ['done', 'todo']) {
    defs.push(
      `<marker id="${prefix}-tri-${state}" class="mk mk-${state}" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" markerUnits="userSpaceOnUse" orient="auto"><path class="mk-hollow" d="M1 1 L11 6 L1 11 Z"/></marker>`,
      `<marker id="${prefix}-dia-fill-${state}" class="mk mk-${state}" viewBox="0 0 16 10" refX="15" refY="5" markerWidth="16" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path class="mk-solid" d="M1 5 L8 1 L15 5 L8 9 Z"/></marker>`,
      `<marker id="${prefix}-dia-${state}" class="mk mk-${state}" viewBox="0 0 16 10" refX="15" refY="5" markerWidth="16" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path class="mk-hollow" d="M1 5 L8 1 L15 5 L8 9 Z"/></marker>`,
      `<marker id="${prefix}-arrow-${state}" class="mk mk-${state}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path class="mk-open" d="M1 1 L9 5 L1 9"/></marker>`,
    );
  }
  return `<defs>${defs.join('')}</defs>`;
}

/** Texto pequeño cerca de un extremo de la linea (multiplicidad). */
function endLabel(x1: number, y1: number, x2: number, y2: number, text: string) {
  const length = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / length;
  const uy = (y2 - y1) / length;
  // 14 px hacia adentro de la linea y 9 px a un lado.
  const x = x1 + ux * 14 - uy * 9;
  const y = y1 + uy * 14 + ux * 9 + 4;
  return `<text class="edge-mult" x="${n(x)}" y="${n(y)}" text-anchor="middle">${escapeXml(fitText(text, 8))}</text>`;
}

function renderRelation(relation: DiagramRelationView, boxes: Map<string, LayoutBox>, prefix: string) {
  const oriented = orientedSegment(relation, boxes);
  if (!oriented) {
    return '';
  }
  const { x1, y1, x2, y2 } = oriented.segment;
  const state = relation.done ? 'done' : 'todo';
  const marker = MARKERS[relation.kind];
  const dashed = relation.kind === 'realization' || relation.kind === 'dependency';
  const title = `${relation.from} ${RELATION_TEXT[relation.kind]} ${relation.to}${relation.label ? ` (${relation.label})` : ''} · ${relation.done ? 'ya está en tu código' : 'todavía no está en tu código'}`;
  const parts = [
    `<g class="edge ${state}${dashed ? ' dashed' : ''}" data-kind="${relation.kind}">`,
    `<title>${escapeXml(title)}</title>`,
    `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}"${marker ? ` marker-end="url(#${prefix}-${marker}-${state})"` : ''}/>`,
  ];
  // Multiplicidades junto a su clase (no junto a la marca).
  const startMult = oriented.startName === relation.from ? relation.fromMultiplicity : relation.toMultiplicity;
  const endMult = oriented.endName === relation.to ? relation.toMultiplicity : relation.fromMultiplicity;
  if (startMult) {
    parts.push(endLabel(x1, y1, x2, y2, startMult));
  }
  if (endMult) {
    parts.push(endLabel(x2, y2, x1, y1, endMult));
  }
  if (relation.label) {
    parts.push(`<text class="edge-label" x="${n((x1 + x2) / 2)}" y="${n((y1 + y2) / 2 - 4)}" text-anchor="middle">${escapeXml(fitText(relation.label, 22))}</text>`);
  }
  parts.push('</g>');
  return parts.join('');
}

function renderClassBox(item: DiagramClassView, box: LayoutBox, text: ClassBoxText) {
  const openable = !!item.path;
  const label = `${item.name}: ${STATUS_TEXT[item.status]}${item.missingMembers.length ? `, le falta ${item.missingMembers.join(', ')}` : ''}${openable ? '. Enter abre el archivo.' : ''}`;
  const parts = [
    `<g class="node class ${item.status}${openable ? ' openable' : ''}" transform="translate(${box.x} ${box.y})"${openable ? ` data-open="${escapeXml(item.path)}" data-line="${item.line}" tabindex="0" role="button"` : ' role="img"'} aria-label="${escapeXml(label)}">`,
    `<title>${escapeXml(label)}</title>`,
    `<rect class="box" width="${box.width}" height="${box.height}" rx="6"/>`,
    `<rect class="stripe" width="5" height="${box.height}" rx="2"/>`,
  ];
  let y = 10;
  if (text.stereotype) {
    y += 10;
    parts.push(`<text class="stereo" x="${n(box.width / 2)}" y="${y}" text-anchor="middle">${escapeXml(text.stereotype)}</text>`);
    y += 4;
  }
  y += 15;
  parts.push(`<text class="name" x="${n(box.width / 2)}" y="${y}" text-anchor="middle">${escapeXml(fitText(text.name, Math.floor((box.width - 24) / CHAR_WIDTH_NAME)))}</text>`);
  y += 5;
  parts.push(`<line class="sep" x1="5" y1="${y}" x2="${box.width}" y2="${y}"/>`);
  y += 14;
  parts.push(`<text class="status" x="14" y="${y}">${escapeXml(text.status)}</text>`);
  if (text.missing.length) {
    y += 4;
    const max = Math.floor((box.width - 30) / CHAR_WIDTH_SMALL);
    for (const line of text.missing) {
      y += 15;
      const more = /^y \d+ más$/.test(line);
      parts.push(`<text class="member${more ? ' more' : ''}" x="16" y="${y}">${escapeXml(more ? line : `– ${fitText(line, max)}`)}</text>`);
    }
  }
  parts.push('</g>');
  return parts.join('');
}

/** El diagrama del taller, comparado con el codigo (compareDiagram). '' sin clases. */
export function renderClassDiagramSvg(target: DiagramTargetView, prefix = 'cd') {
  if (!target.classes.length) {
    return '';
  }
  const texts = new Map(target.classes.map((item) => [item.name, classBoxText(item)]));
  const nodes: LayoutNode[] = target.classes.map((item) => ({ id: item.name, ...classBoxSize(texts.get(item.name) as ClassBoxText) }));
  const layout = layeredLayout(nodes, target.relations.map(layoutEdgeOf), { maxPerRow: 4, gapX: 44, gapY: 64 });
  const edges = target.relations.map((relation) => renderRelation(relation, layout.boxes, prefix)).join('');
  const boxes = target.classes
    .map((item) => {
      const box = layout.boxes.get(item.name);
      return box ? renderClassBox(item, box, texts.get(item.name) as ClassBoxText) : '';
    })
    .join('');
  const summary = `Diagrama de clases: ${target.counts.done} hechas, ${target.counts.partial} a medias y ${target.counts.missing} por hacer de ${target.counts.classes}.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="diagram" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" role="group" aria-label="${escapeXml(summary)}">${markerDefs(prefix)}<g class="edges">${edges}</g><g class="nodes">${boxes}</g></svg>`;
}

// ---------------------------------------------------------------------------------------------
// Grafo de archivos del proyecto

function fileBoxSize(label: string, folder: string, missing: number) {
  const longest = Math.max(label.length * CHAR_WIDTH_NAME, (folder ? folder.length + 1 : 0) * CHAR_WIDTH_SMALL, missing ? 15 * CHAR_WIDTH_SMALL : 0);
  return {
    width: Math.round(clamp(longest + 24, 110, 210)),
    height: 10 + 16 + (folder ? 14 : 0) + (missing ? 15 : 0) + 8,
  };
}

/** Los archivos del proyecto y sus #include / import (buildDependencyGraphView). '' sin archivos. */
export function renderDependencyGraphSvg(graph: DependencyGraphView, prefix = 'dg') {
  if (!graph.nodes.length) {
    return '';
  }
  const nodes: LayoutNode[] = graph.nodes.map((node) => ({ id: node.path, ...fileBoxSize(node.label, node.folder, node.missing.length) }));
  const layout = layeredLayout(nodes, graph.edges, { maxPerRow: 5, gapX: 30, gapY: 52 });
  const active = graph.nodes.find((node) => node.active)?.path || '';
  const edges = graph.edges.map((edge) => {
    const from = layout.boxes.get(edge.from);
    const to = layout.boxes.get(edge.to);
    if (!from || !to) {
      return '';
    }
    const { x1, y1, x2, y2 } = edgeBetween(from, to);
    const hot = edge.from === active || edge.to === active;
    return `<g class="edge file-edge${hot ? ' hot' : ''}"><title>${escapeXml(`${edge.from} usa ${edge.to}`)}</title><line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" marker-end="url(#${prefix}-arrow-${hot ? 'hot' : 'plain'})"/></g>`;
  }).join('');
  const boxes = graph.nodes.map((node) => {
    const box = layout.boxes.get(node.path);
    if (!box) {
      return '';
    }
    const label = `${node.path}${node.active ? ' (archivo activo)' : ''}${node.missing.length ? `: no encuentra ${node.missing.join(', ')}` : ''}. Enter abre el archivo.`;
    const parts = [
      `<g class="node file${node.active ? ' active' : ''}${node.missing.length ? ' warn' : ''} openable" transform="translate(${box.x} ${box.y})" data-open="${escapeXml(node.path)}" data-line="0" tabindex="0" role="button" aria-label="${escapeXml(label)}">`,
      `<title>${escapeXml(label)}</title>`,
      `<rect class="box" width="${box.width}" height="${box.height}" rx="5"/>`,
    ];
    let y = 25;
    parts.push(`<text class="name" x="12" y="${y}">${escapeXml(fitText(node.label, Math.floor((box.width - 20) / CHAR_WIDTH_NAME)))}</text>`);
    if (node.folder) {
      y += 14;
      parts.push(`<text class="folder" x="12" y="${y}">${escapeXml(fitText(`${node.folder}/`, Math.floor((box.width - 20) / CHAR_WIDTH_SMALL)))}</text>`);
    }
    if (node.missing.length) {
      y += 15;
      parts.push(`<text class="warn-text" x="12" y="${y}">${escapeXml(node.missing.length === 1 ? '1 sin encontrar' : `${node.missing.length} sin encontrar`)}</text>`);
    }
    parts.push('</g>');
    return parts.join('');
  }).join('');
  const defs = `<defs>${['plain', 'hot'].map((state) => `<marker id="${prefix}-arrow-${state}" class="mk mk-${state}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path class="mk-open" d="M1 1 L9 5 L1 9"/></marker>`).join('')}</defs>`;
  const summary = `Archivos del proyecto: ${graph.nodes.length}${graph.hidden ? ` (y ${graph.hidden} más)` : ''}, ${graph.edges.length} relaciones.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="diagram files" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" role="group" aria-label="${escapeXml(summary)}">${defs}<g class="edges">${edges}</g><g class="nodes">${boxes}</g></svg>`;
}
