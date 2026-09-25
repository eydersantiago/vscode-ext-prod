/**
 * Enlace a una fuente RAG que se abre en el navegador del sistema.
 *
 * El visor del backend (/api/rag/sources/:id/view) no usa la sesion: un
 * sessionId en la URL quedaria en el historial del navegador del equipo (en
 * una Mac compartida lo ve el siguiente estudiante), en los logs de acceso y
 * en la telemetria (vscode_rag_source_opened guarda la URL). Por eso se quita
 * aunque venga del backend, igual que la extension de navegador (A12.8).
 *
 * No importa vscode, para poder probarlo con node:test.
 */

const RAG_VIEWER_PATH = /\/api\/rag\/sources\/[^/]+\/view\b/i;

export function isRagViewerPath(pathname: string) {
  return RAG_VIEWER_PATH.test(pathname);
}

/**
 * Enlaces del visor (tambien relativos al backend): URL absoluta sin
 * sessionId. Cualquier otro enlace se devuelve tal cual.
 */
export function ragViewerUrl(rawUrl: string, baseUrl: string): string {
  const text = String(rawUrl || '').trim();
  if (!text) {
    return '';
  }
  try {
    const parsed = new URL(text, baseUrl || undefined);
    if (!isRagViewerPath(parsed.pathname)) {
      return text;
    }
    parsed.searchParams.delete('sessionId');
    return parsed.toString();
  } catch {
    return text;
  }
}
