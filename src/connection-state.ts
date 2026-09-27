// ADACEEN (VS Code): conexion con el editor (EditorConnection) compartida entre modulos.
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import type { EditorConnection } from './editor-connect';

// Sesion (x-session-id): emparejada, archivo del tunel o ajuste heredado (src/editor-session.ts).
export let editorConnection: EditorConnection | null = null;

// activate() la fija al crear la conexion (antes asignaba la variable directamente en extension.ts).
export function setEditorConnection(connection: EditorConnection | null) {
  editorConnection = connection;
}
