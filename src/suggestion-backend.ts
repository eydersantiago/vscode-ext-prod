// ADACEEN (VS Code): pedido de la sugerencia al tutor con cache local (clave por sesion, curso, foco y pedido) y el indice del proyecto.
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import { fetchBackendSuggestionText } from './active-suggestion';
import { ACTIVE_SUGGESTION_INDEX_TTL_MS } from './constants';
import { hasActiveSelection } from './editor-snapshot';
import { output } from './extension-state';
import { resolveActiveSuggestionSettings, resolveBackendSettings } from './settings';
import { extractSuggestionCode } from './suggestion-code';
import type { EditorCodeAction } from './suggestion-code';
import { normalizeCourseCode } from './suggestion-results';
import { createStreamFanout } from './suggestion-stream';
import type { SuggestionStreamEvent } from './suggestion-stream';
import { backendSuggestionCache, backendSuggestionInFlight, setWorkspaceProjectIndexCache, setWorkspaceProjectIndexGeneration, setWorkspaceProjectIndexInFlight, workspaceProjectIndexCache, workspaceProjectIndexGeneration, workspaceProjectIndexInFlight } from './suggestion-state';
import type { ActiveEditorSnapshot, ActiveSuggestionSettings, BackendSuggestionInFlight, BackendSuggestionRequestContext, BackendSuggestionRequestScope, BackendSuggestionResult, SuggestionTrigger, WorkspaceProjectIndex } from './types';
import { stableStringHash } from './values';
import { buildWorkspaceProjectIndexForSuggestions, getWorkspaceProjectIndexIdentity } from './workspace-index';

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

export const clearWorkspaceProjectIndexCache = () => {
  setWorkspaceProjectIndexGeneration(workspaceProjectIndexGeneration + 1);
  setWorkspaceProjectIndexCache(null);
  setWorkspaceProjectIndexInFlight(null);
};

export const clearBackendSuggestionCaches = () => {
  backendSuggestionCache.cursor.clear();
  backendSuggestionCache.file_summary.clear();
  backendSuggestionInFlight.clear();
};

export const getBackendSuggestionText = async (
  settings: ActiveSuggestionSettings,
  snapshot: ActiveEditorSnapshot,
  projectIndex: WorkspaceProjectIndex | null,
  scope: BackendSuggestionRequestScope,
  requestContext: BackendSuggestionRequestContext,
  /** 0.0.39: la explicacion en vivo de este pedido (la reciben todos los que lo esperan). */
  onStreamEvent?: (event: SuggestionStreamEvent) => void,
): Promise<BackendSuggestionResult> => {
  const cacheKey = buildBackendSuggestionTextCacheKey(snapshot, projectIndex, scope, requestContext.trigger, requestContext.requestedAction);
  // Un pedido explicito del estudiante («Otra sugerencia», «Proponer una mejora»,
  // «Actualizar resumen») va al backend aunque haya respuesta guardada: repetir la
  // misma era lo que no servia al reintentar.
  const cached = requestContext.trigger === 'manual' ? undefined : backendSuggestionCache[scope].get(cacheKey);
  if (cached) {
    // Sale de la cache local: no hubo viaje al backend, asi que no hay latencia que medir.
    return { ...cached, latencyMs: null };
  }

  const inFlightKey = `${scope}:${cacheKey}`;
  let inFlight = backendSuggestionInFlight.get(inFlightKey);
  if (!inFlight) {
    // 0.0.39: el pedido se comparte; su explicacion en vivo tambien (createStreamFanout). Solo se
    // pide en vivo lo que muestra la ventana anclada a la seleccion: el foco con una seleccion
    // (el resumen del archivo y el cursor sin seleccion no se ven ahi).
    const fanout = scope === 'cursor' && settings.selectionWidget && hasActiveSelection(snapshot) ? createStreamFanout() : null;
    const request = fetchBackendSuggestionText(settings, snapshot, projectIndex, scope, requestContext, fanout ? (event) => fanout.emit(event) : undefined);
    const entry: BackendSuggestionInFlight = { key: cacheKey, request, ...(fanout ? { subscribe: fanout.subscribe } : {}) };
    inFlight = entry;
    backendSuggestionInFlight.set(inFlightKey, entry);
    const settle = () => {
      fanout?.close();
      // Solo si sigue siendo este pedido (clearBackendSuggestionCaches pudo dejar otro).
      if (backendSuggestionInFlight.get(inFlightKey) === entry) {
        backendSuggestionInFlight.delete(inFlightKey);
      }
    };
    request.then(settle, settle);
  }

  const unsubscribe = onStreamEvent && inFlight.subscribe ? inFlight.subscribe(onStreamEvent) : null;
  let result: BackendSuggestionResult;
  try {
    result = await inFlight.request;
  } finally {
    unsubscribe?.();
  }
  // Sin guardar: la respuesta sin modelo («El tutor no esta disponible») y un pedido de
  // codigo que volvio sin codigo; asi el siguiente intento le pregunta otra vez al tutor.
  const codeRequestWithoutCode = !!requestContext.requestedAction && !extractSuggestionCode(result.outputText);
  if (result.outputText && !result.degraded && !codeRequestWithoutCode) {
    backendSuggestionCache[scope].set(cacheKey, result);
  }
  return result;
};

/**
 * Indice del proyecto (cache de ACTIVE_SUGGESTION_INDEX_TTL_MS; se borra al guardar o al crear,
 * borrar o renombrar archivos). allowStale: sirve el de la cache aunque haya vencido (el cuadro
 * «Dependencias» al cambiar de pestaña no rearma el indice cada minuto).
 */
export const getWorkspaceProjectIndex = async (options: { allowStale?: boolean } = {}) => {
  const identity = getWorkspaceProjectIndexIdentity();
  if (!identity) {
    return null;
  }

  const now = Date.now();
  if (
    workspaceProjectIndexCache &&
    workspaceProjectIndexCache.identity === identity &&
    (options.allowStale || workspaceProjectIndexCache.expiresAt > now)
  ) {
    return workspaceProjectIndexCache.value;
  }

  if (!workspaceProjectIndexInFlight) {
    // 0.0.36: antes cada llamada que esperaba guardaba el resultado aunque un archivo se hubiera
    // guardado mientras se armaba (y la cache quedaba con un indice viejo por un minuto).
    const generation = workspaceProjectIndexGeneration;
    const request: Promise<WorkspaceProjectIndex | null> = buildWorkspaceProjectIndexForSuggestions(output)
      .catch((error) => {
        output.appendLine(`[Suggestions] No se pudo construir el mapa local del proyecto: ${String(error)}`);
        return null;
      })
      .then((value) => {
        if (generation === workspaceProjectIndexGeneration) {
          setWorkspaceProjectIndexCache({
            identity,
            expiresAt: Date.now() + ACTIVE_SUGGESTION_INDEX_TTL_MS,
            value,
          });
        }
        return value;
      })
      .finally(() => {
        if (workspaceProjectIndexInFlight === request) {
          setWorkspaceProjectIndexInFlight(null);
        }
      });
    setWorkspaceProjectIndexInFlight(request);
  }
  return workspaceProjectIndexInFlight;
};
