// ADACEEN (VS Code): leer la configuracion de VS Code y el entorno (backend, escaneo, sugerencias, disparadores, aplicar codigo) y detectar el backend local.
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import * as vscode from 'vscode';
import { LOCAL_BACKEND_BASE_URL, needsLocalBackendProbe, probeLocalBackend, resolveBackendBaseUrl } from './backend-url';
import { DEFAULT_OFFLINE_MAX_LINES } from './code-application-guard';
import { editorConnection } from './connection-state';
import { DEFAULT_ACTIVE_SUGGESTION_DEBOUNCE_MS, DEFAULT_ACTIVE_SUGGESTION_MAX_CODE_CHARS, DEFAULT_ACTIVE_SUGGESTION_TIMEOUT_MS, DEFAULT_BLOCKING_SECONDS, DEFAULT_DOCUMENT_INCLUDE_GLOB, DEFAULT_EXCLUDE_GLOB, DEFAULT_INCLUDE_GLOB, DEFAULT_MAX_DOCUMENTS, DEFAULT_MAX_DOCUMENT_BYTES, DEFAULT_MAX_FILES, DEFAULT_MAX_FILE_BYTES, DEFAULT_WORKER_POLL_MS } from './constants';
import type { ActiveSuggestionSettings, BackendSettings, CodeApplicationSettings, ScanCommandArgs, ScanMode, ScanOptions, TriggerSettings } from './types';

// Backend: local si esta corriendo en esta maquina, si no produccion (src/backend-url.ts).
export let localBackendDetected: boolean | null = null;

export function getEnv(name: string): string | undefined {
  const processLike = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return processLike?.env?.[name];
}

export function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function toPositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

export function toNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return undefined;
}

export function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const clean = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(clean)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(clean)) {
    return false;
  }
  return undefined;
}

export function parseMode(value: unknown): ScanMode | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case 'auto':
      return 'auto';
    case 'local':
      return 'local';
    case 'codespace':
    case 'codespaces':
      return 'codespace';
    case 'all':
      return 'all';
    default:
      return undefined;
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function getConfiguredString(config: vscode.WorkspaceConfiguration, key: string): string | undefined {
  const inspected = config.inspect<string>(key);
  return toOptionalString(inspected?.workspaceFolderLanguageValue) ??
    toOptionalString(inspected?.workspaceFolderValue) ??
    toOptionalString(inspected?.workspaceLanguageValue) ??
    toOptionalString(inspected?.workspaceValue) ??
    toOptionalString(inspected?.globalLanguageValue) ??
    toOptionalString(inspected?.globalValue);
}

export function isCodespaceRuntime(): boolean {
  const remoteName = (vscode.env.remoteName ?? '').toLowerCase();
  if (remoteName.includes('codespace')) {
    return true;
  }

  const envFlag = (getEnv('CODESPACES') ?? '').toLowerCase();
  return envFlag === 'true' || envFlag === '1';
}

/**
 * Prueba si hay un backend de ADACEEN en 127.0.0.1:3000 (npm run dev:local o
 * el rol local de las Mac del laboratorio). Solo cuando nadie eligio el backend
 * y no es Codespaces. Devuelve true si cambio la deteccion.
 */
export async function refreshLocalBackendDetection(): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('adaceen');
  const probeNeeded = needsLocalBackendProbe({
    configured: getConfiguredString(config, 'backend.baseUrl'),
    envUrl: getEnv('ADACEEN_BACKEND_URL'),
    codespace: isCodespaceRuntime(),
  });
  if (!probeNeeded) {
    return false;
  }
  if (vscode.env.uiKind === vscode.UIKind.Web && !vscode.env.remoteName) {
    // Extension web (vscode.dev sin tunel): no se prueba 127.0.0.1 para que el
    // navegador no pida permiso de red local; va a produccion.
    const changed = localBackendDetected !== false;
    localBackendDetected = false;
    return changed;
  }
  const detected = await probeLocalBackend(fetch, LOCAL_BACKEND_BASE_URL, 800);
  const changed = detected !== localBackendDetected;
  localBackendDetected = detected;
  return changed;
}

export function resolveScanOptions(args: ScanCommandArgs | undefined): ScanOptions {
  const config = vscode.workspace.getConfiguration('adaceen');

  const mode =
    parseMode(args?.mode) ??
    parseMode(getEnv('ADACEEN_SCAN_MODE')) ??
    parseMode(config.get<string>('scan.mode')) ??
    'auto';

  const includeGlob =
    toOptionalString(args?.includeGlob) ??
    toOptionalString(getEnv('ADACEEN_INCLUDE_GLOB')) ??
    toOptionalString(config.get<string>('scan.includeGlob')) ??
    DEFAULT_INCLUDE_GLOB;

  const excludeGlob =
    toOptionalString(args?.excludeGlob) ??
    toOptionalString(getEnv('ADACEEN_EXCLUDE_GLOB')) ??
    toOptionalString(config.get<string>('scan.excludeGlob')) ??
    DEFAULT_EXCLUDE_GLOB;

  const documentIncludeGlob =
    toOptionalString(args?.documentIncludeGlob) ??
    toOptionalString(getEnv('ADACEEN_DOCUMENT_INCLUDE_GLOB')) ??
    DEFAULT_DOCUMENT_INCLUDE_GLOB;

  const maxFiles =
    toPositiveInt(args?.maxFiles) ??
    toPositiveInt(getEnv('ADACEEN_MAX_FILES')) ??
    toPositiveInt(config.get<number>('scan.maxFiles')) ??
    DEFAULT_MAX_FILES;

  const argsMaxFileBytes = toPositiveInt(args?.maxFileBytes);
  const argsMaxFileKB = toPositiveInt(args?.maxFileKB);
  const envMaxFileBytes = toPositiveInt(getEnv('ADACEEN_MAX_FILE_BYTES'));
  const envMaxFileKB = toPositiveInt(getEnv('ADACEEN_MAX_FILE_KB'));
  const configMaxFileKB = toPositiveInt(config.get<number>('scan.maxFileKB'));

  const maxFileBytes =
    argsMaxFileBytes ??
    (argsMaxFileKB ? argsMaxFileKB * 1024 : undefined) ??
    envMaxFileBytes ??
    (envMaxFileKB ? envMaxFileKB * 1024 : undefined) ??
    (configMaxFileKB ? configMaxFileKB * 1024 : undefined) ??
    DEFAULT_MAX_FILE_BYTES;

  const argsMaxDocumentBytes = toPositiveInt(args?.maxDocumentBytes);
  const argsMaxDocumentKB = toPositiveInt(args?.maxDocumentKB);
  const envMaxDocumentBytes = toPositiveInt(getEnv('ADACEEN_MAX_DOCUMENT_BYTES'));
  const envMaxDocumentKB = toPositiveInt(getEnv('ADACEEN_MAX_DOCUMENT_KB'));
  const maxDocumentBytes =
    argsMaxDocumentBytes ??
    (argsMaxDocumentKB ? argsMaxDocumentKB * 1024 : undefined) ??
    envMaxDocumentBytes ??
    (envMaxDocumentKB ? envMaxDocumentKB * 1024 : undefined) ??
    DEFAULT_MAX_DOCUMENT_BYTES;

  const maxDocuments =
    toPositiveInt(args?.maxDocuments) ??
    toPositiveInt(getEnv('ADACEEN_MAX_DOCUMENTS')) ??
    DEFAULT_MAX_DOCUMENTS;

  return {
    mode,
    includeGlob,
    excludeGlob,
    maxFiles,
    maxFileBytes,
    documentIncludeGlob,
    maxDocuments,
    maxDocumentBytes,
  };
}

export function resolveCurrentBackendBaseUrl(config = vscode.workspace.getConfiguration('adaceen')) {
  return resolveBackendBaseUrl({
    configured: getConfiguredString(config, 'backend.baseUrl'),
    envUrl: getEnv('ADACEEN_BACKEND_URL'),
    codespace: isCodespaceRuntime(),
    localBackendDetected,
  });
}

/**
 * adaceen.backend.baseUrl escrito en el espacio de trabajo abierto
 * (.vscode/settings.json del repo), no por el usuario ni la maquina.
 */
export function backendUrlSetByWorkspace(config = vscode.workspace.getConfiguration('adaceen')) {
  const inspected = config.inspect<string>('backend.baseUrl');
  return Boolean(
    toOptionalString(inspected?.workspaceFolderLanguageValue) ??
    toOptionalString(inspected?.workspaceFolderValue) ??
    toOptionalString(inspected?.workspaceLanguageValue) ??
    toOptionalString(inspected?.workspaceValue),
  );
}

export function resolveBackendSettings(): BackendSettings {
  const config = vscode.workspace.getConfiguration('adaceen');
  const { baseUrl, source: baseUrlSource } = resolveCurrentBackendBaseUrl(config);

  const scanWorkerKey =
    toOptionalString(config.get<string>('backend.scanWorkerKey')) ??
    toOptionalString(getEnv('ADACEEN_SCAN_WORKER_KEY')) ??
    '';

  // SecretStorage -> ~/.adaceen/editor-session.json -> ajuste heredado -> ADACEEN_SESSION_ID.
  const sessionId = editorConnection
    ? editorConnection.sessions.currentSessionId()
    : toOptionalString(config.get<string>('backend.sessionId')) ??
      toOptionalString(getEnv('ADACEEN_SESSION_ID')) ??
      '';

  const autoWorkerEnabled =
    toBoolean(config.get<boolean>('backend.autoWorkerEnabled')) ??
    toBoolean(getEnv('ADACEEN_SCAN_WORKER_ENABLED')) ??
    true;

  const workerPollMs = Math.max(
    2000,
    toPositiveInt(config.get<number>('backend.workerPollMs')) ??
      toPositiveInt(getEnv('ADACEEN_SCAN_WORKER_POLL_MS')) ??
      DEFAULT_WORKER_POLL_MS,
  );

  const workerId =
    toOptionalString(getEnv('ADACEEN_SCAN_WORKER_ID')) ??
    `adaceen-vscode-${vscode.env.remoteName || 'local'}`;

  const codeActionsEnabled =
    toBoolean(config.get<boolean>('backend.codeActionsEnabled')) ??
    toBoolean(getEnv('ADACEEN_CODE_ACTIONS_ENABLED')) ??
    true;

  const autoApplyCodeActions =
    toBoolean(config.get<boolean>('backend.autoApplyCodeActions')) ??
    toBoolean(getEnv('ADACEEN_AUTO_APPLY_CODE_ACTIONS')) ??
    false;

  return {
    baseUrl,
    baseUrlSource,
    scanWorkerKey,
    sessionId,
    autoWorkerEnabled,
    workerPollMs,
    workerId,
    requestTimeoutMs: 120000,
    codeActionsEnabled,
    autoApplyCodeActions,
  };
}

export function resolveActiveSuggestionSettings(): ActiveSuggestionSettings {
  const config = vscode.workspace.getConfiguration('adaceen');

  const enabled =
    toBoolean(config.get<boolean>('suggestions.enabled')) ??
    toBoolean(getEnv('ADACEEN_SUGGESTIONS_ENABLED')) ??
    true;

  const useBackend =
    toBoolean(config.get<boolean>('suggestions.useBackend')) ??
    toBoolean(getEnv('ADACEEN_SUGGESTIONS_USE_BACKEND')) ??
    true;

  const autoRevealPanel =
    toBoolean(config.get<boolean>('suggestions.autoRevealPanel')) ??
    toBoolean(getEnv('ADACEEN_SUGGESTIONS_AUTO_REVEAL_PANEL')) ??
    false;

  const autoOpenSelectionActions =
    toBoolean(config.get<boolean>('suggestions.autoOpenSelectionActions')) ??
    toBoolean(getEnv('ADACEEN_SUGGESTIONS_AUTO_OPEN_SELECTION_ACTIONS')) ??
    true;

  const selectionWidget =
    toBoolean(config.get<boolean>('suggestions.selectionWidget')) ??
    toBoolean(getEnv('ADACEEN_SUGGESTIONS_SELECTION_WIDGET')) ??
    true;

  const debounceMs = Math.max(
    250,
    toPositiveInt(config.get<number>('suggestions.debounceMs')) ??
      toPositiveInt(getEnv('ADACEEN_SUGGESTIONS_DEBOUNCE_MS')) ??
      DEFAULT_ACTIVE_SUGGESTION_DEBOUNCE_MS,
  );

  const maxCodeChars = Math.max(
    1000,
    toPositiveInt(config.get<number>('suggestions.maxCodeChars')) ??
      toPositiveInt(getEnv('ADACEEN_SUGGESTIONS_MAX_CODE_CHARS')) ??
      DEFAULT_ACTIVE_SUGGESTION_MAX_CODE_CHARS,
  );

  const backendTimeoutMs = Math.max(
    10000,
    toPositiveInt(config.get<number>('suggestions.backendTimeoutMs')) ??
      toPositiveInt(getEnv('ADACEEN_SUGGESTIONS_BACKEND_TIMEOUT_MS')) ??
      DEFAULT_ACTIVE_SUGGESTION_TIMEOUT_MS,
  );

  return {
    enabled,
    useBackend,
    autoRevealPanel,
    autoOpenSelectionActions,
    selectionWidget,
    debounceMs,
    maxCodeChars,
    backendTimeoutMs,
    ragCourseCode: toOptionalString(config.get<string>('rag.courseCode')) ??
      toOptionalString(getEnv('ADACEEN_RAG_COURSE_CODE')) ??
      '',
  };
}

export function resolveTriggerSettings(): TriggerSettings {
  const config = vscode.workspace.getConfiguration('adaceen');
  const blockingSeconds = Math.min(
    3600,
    Math.max(
      10,
      toPositiveInt(config.get<number>('triggers.blockingSeconds')) ??
        toPositiveInt(getEnv('ADACEEN_TRIGGERS_BLOCKING_SECONDS')) ??
        DEFAULT_BLOCKING_SECONDS,
    ),
  );
  const suggestOnBlocking =
    toBoolean(config.get<boolean>('triggers.suggestOnBlocking')) ??
    toBoolean(getEnv('ADACEEN_TRIGGERS_SUGGEST_ON_BLOCKING')) ??
    true;
  return { blockingSeconds, suggestOnBlocking };
}

export function resolveCodeApplicationSettings(): CodeApplicationSettings {
  const config = vscode.workspace.getConfiguration('adaceen');
  const offlineMaxLines = Math.min(
    5000,
    toNonNegativeInt(config.get<number>('codeApplication.offlineMaxLines')) ??
      toNonNegativeInt(getEnv('ADACEEN_CODE_APPLICATION_OFFLINE_MAX_LINES')) ??
      DEFAULT_OFFLINE_MAX_LINES,
  );
  return { offlineMaxLines };
}
