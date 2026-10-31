// ADACEEN (VS Code): los mensajes que manda el script de la vista «Este archivo» (0.0.38), sin
// importar vscode. El script corre en un webview: lo que manda se revisa antes de usarlo (como en
// diagram-panel-messages.ts).
import type { FileViewDependencyGroup } from './file-view-model';

export const FILE_VIEW_DEPENDENCY_GROUPS: readonly FileViewDependencyGroup[] = ['local', 'libraries', 'missing', 'dependents'];

const MAX_ID_CHARS = 2000;
const MAX_KEY_CHARS = 2000;

export type FileViewInboundMessage =
  /** El script ya escucha: se le manda el estado. */
  | { type: 'ready' }
  /** Abrir la fuente citada en la ultima sugerencia (por su posicion). */
  | { type: 'openSource'; index: number }
  /** Abrir un elemento del material del curso. */
  | { type: 'openMaterial'; id: string }
  | { type: 'loadMaterial' }
  | { type: 'refreshSummary' }
  | { type: 'openQuiz' }
  | { type: 'openDiagram' }
  /** Clic en el cuadro «Dependencias»: el grupo, la posicion, de que cuadro era y el id del elemento. */
  | { type: 'openDependency'; group: FileViewDependencyGroup; index: number; key: string; id: string };

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** El mensaje de la vista revisado, o null si no es uno de los conocidos (o trae algo raro). */
export function parseFileViewInboundMessage(raw: unknown): FileViewInboundMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const data = raw as Record<string, unknown>;
  switch (data.type) {
    case 'ready':
    case 'loadMaterial':
    case 'refreshSummary':
    case 'openQuiz':
    case 'openDiagram':
      return { type: data.type };
    case 'openSource':
      return isIndex(data.index) ? { type: 'openSource', index: data.index } : null;
    case 'openMaterial':
      return typeof data.id === 'string' && data.id ? { type: 'openMaterial', id: data.id.slice(0, MAX_ID_CHARS) } : null;
    case 'openDependency': {
      const group = FILE_VIEW_DEPENDENCY_GROUPS.find((item) => item === data.group);
      if (!group || !isIndex(data.index)) {
        return null;
      }
      return {
        type: 'openDependency',
        group,
        index: data.index,
        key: typeof data.key === 'string' ? data.key.slice(0, MAX_KEY_CHARS) : '',
        id: typeof data.id === 'string' ? data.id.slice(0, MAX_ID_CHARS) : '',
      };
    }
    default:
      return null;
  }
}
