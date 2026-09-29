// ADACEEN (VS Code): llamadas HTTP al backend: cabeceras, cola del worker (escaneos y acciones de codigo) y clasificacion de documentos.
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import * as vscode from 'vscode';
import { buildIdentityHeaders, rejectedSessionId } from './client-identity';
import { editorConnection } from './connection-state';
import { asRecord, toOptionalString } from './settings';
import { actionTypeToApplyMode } from './suggestion-edit';
import { isAbortLikeError } from './suggestion-results';
import type { BackendSettings, PendingCodeAction, PendingScanRequest, ScanPayload, ScannedDocument } from './types';
import { scoreDocumentName } from './workspace-scan';

/** Respuesta no 2xx del backend. El mensaje es el mismo de antes; status permite distinguir un 404. */
export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * x-adaceen-session: invalid en una respuesta: la sesion enviada ya no vale
 * (logout, vencida). editor-session.ts la olvida y busca otra.
 */
export function reportRejectedSession(sentHeaders: unknown, responseHeaders: unknown) {
  const rejected = rejectedSessionId(
    sentHeaders as Record<string, unknown> | undefined,
    responseHeaders as { get(name: string): string | null } | undefined,
  );
  if (rejected) {
    editorConnection?.sessions.reportInvalid(rejected);
  }
}

export async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    reportRejectedSession(init.headers, response.headers);
    const text = await response.text();
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = {};
      }
    }
    if (!response.ok) {
      const structuredError = toOptionalString(asRecord(data).error);
      const rawError = toOptionalString(text);
      const looksLikeHtml = /^<!doctype html>|<html[\s>]/i.test(rawError || '');
      if (response.status === 524 || /524:\s*a timeout occurred|error code 524/i.test(rawError || '')) {
        throw new HttpError('Backend no respondio a tiempo por Cloudflare 524. Se usara fallback local.', response.status);
      }
      if (looksLikeHtml) {
        throw new HttpError(`Backend devolvio HTML en lugar de JSON (HTTP ${response.status}).`, response.status);
      }
      throw new HttpError(structuredError || rawError || `HTTP ${response.status}`, response.status);
    }
    return data;
  } catch (error) {
    if (isAbortLikeError(error)) {
      throw new Error(`Backend no respondio en ${Math.round(timeoutMs / 1000)}s; se mantiene fallback local.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Cabeceras base de TODAS las llamadas al backend: worker y, siempre,
 * x-adaceen-client-id (identidad sin sesion, ver client-identity.ts).
 */
export function buildWorkerHeaders(settings: BackendSettings, includeJsonContentType: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'x-adaceen-worker-id': settings.workerId,
    ...buildIdentityHeaders(),
  };
  if (settings.scanWorkerKey) {
    headers['x-adaceen-worker-key'] = settings.scanWorkerKey;
  }
  if (includeJsonContentType) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }
  return headers;
}

/** Como buildWorkerHeaders mas x-session-id cuando hay sesion compartida. */
export function buildSessionHeaders(settings: BackendSettings, includeJsonContentType: boolean): Record<string, string> {
  return {
    ...buildWorkerHeaders(settings, includeJsonContentType),
    ...buildIdentityHeaders(settings.sessionId),
  };
}

export function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export async function claimNextScanRequest(
  settings: BackendSettings,
  repoFullName: string,
): Promise<PendingScanRequest | null> {
  const query = `?repoFullName=${encodeURIComponent(repoFullName)}`;
  // Con la sesion (A12.12): el backend solo entrega las solicitudes del mismo estudiante.
  const response = await fetchJsonWithTimeout(
    `${settings.baseUrl}/api/projects/scan/request/next${query}`,
    {
      method: 'GET',
      headers: buildSessionHeaders(settings, false),
    },
    settings.requestTimeoutMs,
  );

  const data = asRecord(response);
  const request = asRecord(data.request);
  const id = toOptionalString(request.id);
  const repo = toOptionalString(request.repoFullName);
  if (!id || !repo) {
    return null;
  }
  return {
    id,
    repoFullName: repo.toLowerCase(),
  };
}

export async function sendScanResult(
  settings: BackendSettings,
  requestId: string,
  payload: ScanPayload,
) {
  return fetchJsonWithTimeout(
    `${settings.baseUrl}/api/projects/scan/request/${encodeURIComponent(requestId)}/result`,
    {
      method: 'POST',
      headers: buildSessionHeaders(settings, true),
      body: JSON.stringify(payload),
    },
    settings.requestTimeoutMs,
  );
}

export async function claimNextCodeAction(
  settings: BackendSettings,
  repoFullName: string,
): Promise<PendingCodeAction | null> {
  if (!settings.sessionId || !settings.codeActionsEnabled) {
    return null;
  }

  // POST /claim con lease (A12.12). Un backend anterior no la tiene (404): se usa GET /next.
  let response: unknown;
  try {
    response = await fetchJsonWithTimeout(
      `${settings.baseUrl}/api/projects/code-actions/claim`,
      {
        method: 'POST',
        headers: buildSessionHeaders(settings, true),
        body: JSON.stringify({ repoFullName, workerId: settings.workerId }),
      },
      settings.requestTimeoutMs,
    );
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) {
      throw error;
    }
    const query = `?repoFullName=${encodeURIComponent(repoFullName)}`;
    response = await fetchJsonWithTimeout(
      `${settings.baseUrl}/api/projects/code-actions/next${query}`,
      {
        method: 'GET',
        headers: buildSessionHeaders(settings, false),
      },
      settings.requestTimeoutMs,
    );
  }

  const action = asRecord(asRecord(response).action);
  const id = toOptionalString(action.id);
  const repo = toOptionalString(action.repoFullName);
  const filePath = toOptionalString(action.filePath);
  const actionType = toOptionalString(action.actionType) || 'replace_selection';
  const replacementText = typeof action.replacementText === 'string' ? action.replacementText : '';
  const applyMode = actionTypeToApplyMode(actionType);
  if (!id || !repo || !filePath || (applyMode !== 'delete' && !replacementText.trim())) {
    return null;
  }

  return {
    id,
    repoFullName: repo.toLowerCase(),
    branch: toOptionalString(action.branch) || '',
    filePath,
    actionType,
    title: toOptionalString(action.title) || 'Reemplazo sugerido',
    originalText: toOptionalString(action.originalText) || '',
    replacementText,
    metadata: normalizeMetadata(action.metadata),
    source: toOptionalString(action.source) || '',
    requestedAt: toOptionalString(action.requestedAt) || '',
    claimedAt: toOptionalString(action.claimedAt) || '',
    leaseUntil: toOptionalString(action.leaseUntil) || '',
    // Sin el campo (backend anterior) se asume el primer reclamo.
    attempts: Math.max(1, Number(action.attempts) || 1),
  };
}

export async function completeCodeAction(
  settings: BackendSettings,
  actionId: string,
  metadata: Record<string, unknown>,
) {
  if (!settings.sessionId) {
    return;
  }

  await fetchJsonWithTimeout(
    `${settings.baseUrl}/api/projects/code-actions/${encodeURIComponent(actionId)}/complete`,
    {
      method: 'POST',
      headers: buildSessionHeaders(settings, true),
      body: JSON.stringify({ metadata }),
    },
    settings.requestTimeoutMs,
  );
}

export async function failCodeAction(
  settings: BackendSettings,
  actionId: string,
  errorMessage: string,
) {
  if (!settings.sessionId) {
    return;
  }

  await fetchJsonWithTimeout(
    `${settings.baseUrl}/api/projects/code-actions/${encodeURIComponent(actionId)}/fail`,
    {
      method: 'POST',
      headers: buildSessionHeaders(settings, true),
      body: JSON.stringify({ error: errorMessage.slice(0, 1200) }),
    },
    settings.requestTimeoutMs,
  );
}

export function mimeTypeForDocument(extension: string) {
  switch (extension.toLowerCase()) {
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'txt':
      return 'text/plain';
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    case 'tiff':
      return 'image/tiff';
    default:
      return 'application/octet-stream';
  }
}

export function bytesToBase64(bytes: Uint8Array) {
  const maybeBuffer = (globalThis as unknown as {
    Buffer?: { from(value: Uint8Array): { toString(encoding: string): string } };
  }).Buffer;
  if (maybeBuffer?.from) {
    return maybeBuffer.from(bytes).toString('base64');
  }

  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.slice(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function shouldUseModelForDocument(document: ScannedDocument, index: number) {
  return index < 3 || scoreDocumentName(document.path) >= 25;
}

export async function sendDocumentClassification(
  settings: BackendSettings,
  input: {
    repoFullName: string;
    requestId: string;
    snapshotId: string;
    document: ScannedDocument;
    useModel: boolean;
  },
) {
  const bytes = await vscode.workspace.fs.readFile(input.document.uri);
  return fetchJsonWithTimeout(
    `${settings.baseUrl}/api/documents/classify`,
    {
      method: 'POST',
      headers: buildSessionHeaders(settings, true),
      body: JSON.stringify({
        repoFullName: input.repoFullName,
        requestId: input.requestId,
        snapshotId: input.snapshotId,
        filePath: input.document.path,
        fileName: input.document.fileName,
        extension: input.document.extension,
        mimeType: mimeTypeForDocument(input.document.extension),
        contentBase64: bytesToBase64(bytes),
        useModel: input.useModel,
      }),
    },
    settings.requestTimeoutMs,
  );
}

export async function classifyScannedDocuments(
  settings: BackendSettings,
  params: {
    repoFullName: string;
    requestId: string;
    snapshotId: string;
    documents: ScannedDocument[];
  },
  output: vscode.OutputChannel,
) {
  if (!params.snapshotId || params.documents.length === 0) {
    return;
  }

  output.appendLine(`[Worker] Clasificando ${params.documents.length} documento(s) candidato(s)...`);
  for (let index = 0; index < params.documents.length; index += 1) {
    const document = params.documents[index];
    try {
      const response = await sendDocumentClassification(settings, {
        repoFullName: params.repoFullName,
        requestId: params.requestId,
        snapshotId: params.snapshotId,
        document,
        useModel: shouldUseModelForDocument(document, index),
      });
      const classification = asRecord(asRecord(response).classification);
      const label = toOptionalString(classification.label) || 'OTRO';
      const confidence = Number(classification.confidence) || 0;
      output.appendLine(`[Worker] Documento clasificado: ${label} ${Math.round(confidence * 100)}% | ${document.path}`);
    } catch (error) {
      output.appendLine(`[Worker] No se pudo clasificar ${document.path}: ${String(error)}`);
    }
  }
}

export async function sendScanFailure(
  settings: BackendSettings,
  requestId: string,
  errorMessage: string,
) {
  try {
    await fetchJsonWithTimeout(
      `${settings.baseUrl}/api/projects/scan/request/${encodeURIComponent(requestId)}/fail`,
      {
        method: 'POST',
        headers: buildSessionHeaders(settings, true),
        body: JSON.stringify({ error: errorMessage.slice(0, 1200) }),
      },
      settings.requestTimeoutMs,
    );
  } catch {
    // No-op: el worker intenta reportar, pero no debe romper el ciclo si esto falla.
  }
}
