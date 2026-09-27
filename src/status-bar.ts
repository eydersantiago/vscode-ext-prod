// ADACEEN (VS Code): origen del backend (worker, heartbeat) y barra de estado.
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import * as vscode from 'vscode';
import { buildWorkerHeaders, fetchJsonWithTimeout } from './backend-http';
import { describeBackendUrlSource } from './backend-url';
import { asRecord, toOptionalString } from './settings';
import type { BackendSettings } from './types';

export type BackendOrigin = {
  /** Modo del backend: local | azure | queue. */
  mode: string;
  /** Etiqueta ya resuelta por el backend: "Google Cloud - L4". */
  label: string;
  id: string;
  provider: string;
  reachable: boolean;
  /** Motivo cuando no se pudo consultar, para el tooltip. */
  detail: string;
  /**
   * El backend informa latidos (listening es un arreglo) y ningun worker
   * esta vivo: la barra dice "GPU: sin worker activo".
   */
  noWorker: boolean;
  /** alive_workers del backend; null si es un backend sin latidos. */
  aliveWorkers: number | null;
  /** Workers que el backend conoce (listening.length); null si no viene. */
  listeningCount: number | null;
  /** Servidores con latido reciente, agrupados: "Mac del laboratorio - M2 x2". */
  aliveLabels: string[];
};

export const UNKNOWN_BACKEND_ORIGIN: BackendOrigin = {
  mode: '',
  label: 'sin consultar',
  id: '',
  provider: 'unknown',
  reachable: false,
  detail: '',
  noWorker: false,
  aliveWorkers: null,
  listeningCount: null,
  aliveLabels: [],
};

/**
 * Lectura de listening / alive_workers de /api/agent/backend. Solo cuenta
 * como "sin worker" si listening es un arreglo y alive_workers es 0; en modo
 * local o azure no hay workers con latido, asi que no se avisa. Con un
 * backend viejo (sin esos campos) todo sigue como antes.
 */
export function readWorkerHeartbeat(data: Record<string, unknown>) {
  const listening = Array.isArray(data.listening) ? data.listening : null;
  const aliveRaw = data.alive_workers;
  const aliveWorkers = typeof aliveRaw === 'number' && Number.isFinite(aliveRaw) ? Math.max(0, Math.floor(aliveRaw)) : null;
  const mode = (toOptionalString(data.mode) || '').toLowerCase();
  const heartbeatMode = mode !== 'local' && mode !== 'azure';
  const counts = new Map<string, number>();
  for (const entry of listening ?? []) {
    const worker = asRecord(entry);
    const label = toOptionalString(worker.label);
    if (worker.alive === true && label) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return {
    listeningCount: listening ? listening.length : null,
    aliveWorkers,
    noWorker: !!listening && aliveWorkers === 0 && heartbeatMode,
    aliveLabels: [...counts].map(([label, count]) => (count > 1 ? `${label} x${count}` : label)),
  };
}

export function backendOriginIcon(origin: BackendOrigin): string {
  if (!origin.reachable || origin.noWorker) {
    return '$(warning)';
  }
  switch (origin.provider) {
    case 'gcp':
      return '$(cloud)';
    case 'colab':
      return '$(beaker)';
    case 'mac':
    case 'pc':
      return '$(device-desktop)';
    case 'azure':
    case 'local':
      return '$(server)';
    default:
      return '$(question)';
  }
}

/**
 * Pregunta al backend quien esta poniendo la GPU.
 *
 * Nunca lanza: si el backend no responde o es una version anterior sin
 * /api/agent/backend, devuelve un origen no alcanzable con el motivo en
 * detail, que es justo lo que hay que mostrarle al estudiante.
 */
export async function fetchBackendOrigin(settings: BackendSettings): Promise<BackendOrigin> {
  try {
    const data = asRecord(
      await fetchJsonWithTimeout(
        `${settings.baseUrl}/api/agent/backend`,
        { method: 'GET', headers: buildWorkerHeaders(settings, false) },
        8000,
      ),
    );
    // worker es el ultimo job atendido; expected es lo que el backend espera
    // cuando todavia no ha pasado ninguno.
    const worker = asRecord(data.worker ?? data.expected);
    const heartbeat = readWorkerHeartbeat(data);
    return {
      mode: toOptionalString(data.mode) ?? '',
      label: heartbeat.noWorker ? 'sin worker activo' : toOptionalString(worker.label) ?? 'sin identificar',
      id: toOptionalString(worker.id) ?? '',
      provider: toOptionalString(worker.provider) ?? 'unknown',
      reachable: true,
      detail: heartbeat.noWorker
        ? 'Ningún worker de GPU ha mandado latido reciente al backend. Las sugerencias pueden tardar o salir del respaldo local hasta que un worker vuelva a conectarse.'
        : '',
      noWorker: heartbeat.noWorker,
      aliveWorkers: heartbeat.aliveWorkers,
      listeningCount: heartbeat.listeningCount,
      aliveLabels: heartbeat.aliveLabels,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outdated = /\b404\b/.test(message);
    return {
      ...UNKNOWN_BACKEND_ORIGIN,
      label: outdated ? 'backend sin indicador' : 'backend no disponible',
      detail: outdated
        ? 'Este backend es anterior a /api/agent/backend. Actualiza PDC para ver el origen de la GPU.'
        : message,
    };
  }
}

export function updateBackendOriginStatusBar(
  statusBar: vscode.StatusBarItem,
  origin: BackendOrigin,
  settings: BackendSettings,
) {
  statusBar.text = `${backendOriginIcon(origin)} GPU: ${origin.label}`;
  statusBar.tooltip = [
    origin.noWorker ? 'GPU: sin worker activo' : `Origen de la inferencia: ${origin.label}`,
    origin.id ? `${origin.noWorker ? 'Ultimo worker conocido' : 'Worker'}: ${origin.id}` : '',
    origin.mode ? `Modo del backend: ${origin.mode}` : '',
    origin.aliveWorkers !== null && origin.listeningCount !== null
      ? `Workers con latido reciente: ${origin.aliveWorkers} de ${origin.listeningCount}`
      : '',
    origin.aliveLabels.length ? `Servidores vivos: ${origin.aliveLabels.join(', ')}` : '',
    `Backend: ${settings.baseUrl} (${describeBackendUrlSource(settings.baseUrlSource)})`,
    origin.detail,
  ]
    .filter(Boolean)
    .join('\n');
  statusBar.backgroundColor = origin.reachable && !origin.noWorker
    ? undefined
    : new vscode.ThemeColor('statusBarItem.warningBackground');
  statusBar.show();
}
