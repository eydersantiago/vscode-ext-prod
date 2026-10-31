// ADACEEN (VS Code): los mensajes entre la extension y el panel «Ver diagrama» (0.0.38), sin
// importar vscode. Hacia el panel va el estado ya dibujado (los SVG de diagram-svg.ts, con el texto
// escapado); desde el panel solo llegan tres mensajes, que se revisan antes de usarlos (el script
// del panel corre en un webview: lo que manda no se toma tal cual).
import type { DiagramViewState } from './diagram-model';
import { renderClassDiagramSvg, renderDependencyGraphSvg } from './diagram-svg';

/** Lo que viaja al script del panel: los SVG ya armados y los textos. */
export type DiagramPanelMessage = {
  type: 'state';
  status: DiagramViewState['status'];
  updatedLabel: string;
  target: null | {
    title: string;
    sourcePath: string;
    counts: { classes: number; done: number; partial: number; missing: number };
    relationsDone: number;
    relationsTotal: number;
    svg: string;
  };
  targetNote: string;
  files: {
    svg: string;
    hidden: number;
    libraries: Array<{ label: string; description: string; count: number }>;
    missing: Array<{ from: string; label: string; hint: string }>;
  };
};

export function buildDiagramPanelMessage(state: DiagramViewState): DiagramPanelMessage {
  const target = state.target;
  return {
    type: 'state',
    status: state.status,
    updatedLabel: state.updatedLabel,
    target: target
      ? {
        title: target.title,
        sourcePath: target.sourcePath,
        counts: target.counts,
        relationsDone: target.relations.filter((item) => item.done).length,
        relationsTotal: target.relations.length,
        svg: renderClassDiagramSvg(target),
      }
      : null,
    targetNote: state.targetNote,
    files: {
      svg: renderDependencyGraphSvg(state.dependencies),
      hidden: state.dependencies.hidden,
      libraries: state.dependencies.libraries.slice(0, 20),
      missing: state.dependencies.missing.slice(0, 20).map((item) => ({ from: item.from, label: item.label, hint: item.hint })),
    },
  };
}

/**
 * Lo que manda el script del panel: listo para recibir el estado, «Actualizar», o un clic en una
 * clase o un archivo (la ruta relativa que el propio estado traia en data-open).
 */
export type DiagramPanelInboundMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'open'; path: string; line: number };

const MAX_OPEN_PATH = 1000;

/** El mensaje del panel revisado, o null si no es uno de los tres (o trae algo raro). */
export function parseDiagramPanelInboundMessage(raw: unknown): DiagramPanelInboundMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const data = raw as Record<string, unknown>;
  switch (data.type) {
    case 'ready':
      return { type: 'ready' };
    case 'refresh':
      return { type: 'refresh' };
    case 'open': {
      if (typeof data.path !== 'string' || !data.path || data.path.length > MAX_OPEN_PATH) {
        return null;
      }
      const line = typeof data.line === 'number' && Number.isInteger(data.line) && data.line > 0 ? data.line : 0;
      return { type: 'open', path: data.path, line };
    }
    default:
      return null;
  }
}
