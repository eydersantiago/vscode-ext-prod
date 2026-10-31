// ADACEEN (VS Code): acomodo de cajas en capas para «Ver diagrama» (0.0.38), sin importar vscode.
//
// Un dibujo legible para 6 a 24 cajas sin bibliotecas (la extension corre tambien en vscode.dev):
//   - capas por el camino mas largo: la clase padre (o el archivo que incluye) arriba y la hija
//     (o el incluido) abajo; los ciclos se rompen con un recorrido en profundidad;
//   - en cada capa, el orden que acerca cada caja a sus vecinas de la capa de arriba y de abajo
//     (baricentro, dos vueltas), para que se crucen pocas lineas;
//   - una capa con muchas cajas se parte en filas; las cajas sin relaciones van al final;
//   - cada fila centrada.
// Tambien recorta una linea al borde de una caja (para que las flechas no queden debajo).
// Se prueba con node:test.

export type LayoutNode = { id: string; width: number; height: number };

/** De la caja de arriba (from) a la de abajo (to). */
export type LayoutEdge = { from: string; to: string };

export type LayoutBox = { x: number; y: number; width: number; height: number };

export type LayoutResult = {
  boxes: Map<string, LayoutBox>;
  width: number;
  height: number;
};

export type LayoutOptions = {
  maxPerRow: number;
  gapX: number;
  gapY: number;
  margin: number;
};

export const DEFAULT_LAYOUT: LayoutOptions = { maxPerRow: 4, gapX: 36, gapY: 56, margin: 16 };

/** Aristas sin las que cierran un ciclo (recorrido en profundidad en el orden de las cajas). */
function acyclicEdges(ids: string[], edges: LayoutEdge[]) {
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    const list = out.get(edge.from) || [];
    if (!list.includes(edge.to)) {
      list.push(edge.to);
    }
    out.set(edge.from, list);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const kept: LayoutEdge[] = [];
  const visit = (start: string) => {
    // Iterativo: un grafo largo no llena la pila.
    const stack: Array<{ id: string; index: number }> = [{ id: start, index: 0 }];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = (out.get(top.id) || [])[top.index];
      if (next === undefined) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      top.index += 1;
      const seen = state.get(next) || 0;
      if (seen === 1) {
        continue; // cierra un ciclo: no cuenta para las capas
      }
      kept.push({ from: top.id, to: next });
      if (seen === 0) {
        state.set(next, 1);
        stack.push({ id: next, index: 0 });
      }
    }
  };
  for (const id of ids) {
    if (!state.get(id)) {
      visit(id);
    }
  }
  return kept;
}

/** Capa de cada caja: 0 arriba; cada hija una capa por debajo de su padre mas bajo. */
function assignLayers(ids: string[], edges: LayoutEdge[]) {
  const layer = new Map(ids.map((id) => [id, 0]));
  const indegree = new Map(ids.map((id) => [id, 0]));
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
    out.set(edge.from, [...(out.get(edge.from) || []), edge.to]);
  }
  const queue = ids.filter((id) => !indegree.get(id));
  while (queue.length) {
    const id = queue.shift() as string;
    for (const next of out.get(id) || []) {
      layer.set(next, Math.max(layer.get(next) || 0, (layer.get(id) || 0) + 1));
      indegree.set(next, (indegree.get(next) || 0) - 1);
      if (!indegree.get(next)) {
        queue.push(next);
      }
    }
  }
  return layer;
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

/** Orden dentro de cada capa por el promedio de la posicion de sus vecinas (dos vueltas). */
function orderLayers(layers: string[][], edges: LayoutEdge[]) {
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  for (const edge of edges) {
    down.set(edge.from, [...(down.get(edge.from) || []), edge.to]);
    up.set(edge.to, [...(up.get(edge.to) || []), edge.from]);
  }
  const position = new Map<string, number>();
  const remember = () => layers.forEach((row) => row.forEach((id, index) => position.set(id, index)));
  remember();
  const sortBy = (row: string[], neighbors: Map<string, string[]>) => {
    const keyed = row.map((id, index) => {
      const score = average((neighbors.get(id) || []).map((other) => position.get(other) ?? 0));
      return { id, key: Number.isNaN(score) ? index : score, index };
    });
    keyed.sort((left, right) => left.key - right.key || left.index - right.index);
    return keyed.map((item) => item.id);
  };
  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = 1; index < layers.length; index += 1) {
      layers[index] = sortBy(layers[index], up);
      remember();
    }
    for (let index = layers.length - 2; index >= 0; index -= 1) {
      layers[index] = sortBy(layers[index], down);
      remember();
    }
  }
  return layers;
}

/**
 * Posiciones de las cajas. `edges` van de la caja de arriba a la de abajo; las que nombran una
 * caja que no esta se ignoran. Nunca lanza.
 */
export function layeredLayout(nodes: LayoutNode[], edges: LayoutEdge[], options: Partial<LayoutOptions> = {}): LayoutResult {
  const opts = { ...DEFAULT_LAYOUT, ...options };
  const maxPerRow = Math.max(1, Math.floor(opts.maxPerRow));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ids = [...byId.keys()];
  const valid = edges.filter((edge) => edge.from !== edge.to && byId.has(edge.from) && byId.has(edge.to));
  const connected = new Set(valid.flatMap((edge) => [edge.from, edge.to]));
  const linked = ids.filter((id) => connected.has(id));
  const loose = ids.filter((id) => !connected.has(id));
  const dag = acyclicEdges(linked, valid);
  const layerOf = assignLayers(linked, dag);
  const layerCount = linked.length ? Math.max(...linked.map((id) => layerOf.get(id) || 0)) + 1 : 0;
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  for (const id of linked) {
    layers[layerOf.get(id) || 0].push(id);
  }
  orderLayers(layers, dag);
  const rows: string[][] = [];
  for (const layer of layers) {
    for (let index = 0; index < layer.length; index += maxPerRow) {
      rows.push(layer.slice(index, index + maxPerRow));
    }
  }
  for (let index = 0; index < loose.length; index += maxPerRow) {
    rows.push(loose.slice(index, index + maxPerRow));
  }
  const rowWidth = (row: string[]) => row.reduce((sum, id) => sum + (byId.get(id)?.width || 0), 0) + Math.max(0, row.length - 1) * opts.gapX;
  const contentWidth = rows.reduce((max, row) => Math.max(max, rowWidth(row)), 0);
  const boxes = new Map<string, LayoutBox>();
  let y = opts.margin;
  for (const row of rows) {
    const height = row.reduce((max, id) => Math.max(max, byId.get(id)?.height || 0), 0);
    let x = opts.margin + (contentWidth - rowWidth(row)) / 2;
    for (const id of row) {
      const node = byId.get(id) as LayoutNode;
      boxes.set(id, { x: Math.round(x), y: Math.round(y), width: node.width, height: node.height });
      x += node.width + opts.gapX;
    }
    y += height + opts.gapY;
  }
  const height = rows.length ? y - opts.gapY + opts.margin : opts.margin * 2;
  return { boxes, width: Math.round(contentWidth + opts.margin * 2), height: Math.round(height) };
}

/** Punto donde la linea del centro de la caja hacia (toX, toY) cruza su borde. */
export function clipToBox(box: LayoutBox, toX: number, toY: number) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = toX - cx;
  const dy = toY - cy;
  if (!dx && !dy) {
    return { x: cx, y: cy };
  }
  const scaleX = dx ? (box.width / 2) / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const scaleY = dy ? (box.height / 2) / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/** El segmento entre dos cajas, de borde a borde. */
export function edgeBetween(from: LayoutBox, to: LayoutBox) {
  const start = clipToBox(from, to.x + to.width / 2, to.y + to.height / 2);
  const end = clipToBox(to, from.x + from.width / 2, from.y + from.height / 2);
  return { x1: start.x, y1: start.y, x2: end.x, y2: end.y };
}
