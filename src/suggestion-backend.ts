// ADACEEN (VS Code): pedido de la sugerencia al tutor con cache local: clave de la cache por sesion, curso, foco y pedido.
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import { resolveBackendSettings, resolveActiveSuggestionSettings } from './settings';
import type { EditorCodeAction } from './suggestion-code';
import { normalizeCourseCode } from './suggestion-results';
import type { ActiveEditorSnapshot, WorkspaceProjectIndex, BackendSuggestionRequestScope, SuggestionTrigger } from './types';
import { stableStringHash } from './values';

export const buildBackendSuggestionTextCacheKey = (
  snapshot: ActiveEditorSnapshot,
  projectIndex: WorkspaceProjectIndex | null,
  scope: BackendSuggestionRequestScope,
  trigger: SuggestionTrigger,
  requestedAction?: EditorCodeAction,
) => {
  const projectKey = projectIndex?.cacheKey || 'sin-mapa';
  const backend = resolveBackendSettings();
  const activeRagCourse = normalizeCourseCode(resolveActiveSuggestionSettings().ragCourseCode);
  const sessionKey = stableStringHash(`${backend.sessionId || 'sin-sesion'}:${activeRagCourse || 'curso-backend'}`);
  if (scope === 'file_summary') {
    return `${sessionKey}:${snapshot.fileSummaryCacheKey}:${projectKey}`;
  }
  // Un bloqueo siempre llega al backend (su pregunta y su politica son otras), y
  // un pedido de codigo (0.0.34) no reusa la sugerencia normal del mismo bloque.
  const triggerKey = trigger === 'blocking' ? ':blocking' : '';
  const actionKey = requestedAction ? `:pedido-${requestedAction}` : '';
  return `${sessionKey}:${snapshot.cacheKey}:${projectKey}${triggerKey}${actionKey}`;
};
