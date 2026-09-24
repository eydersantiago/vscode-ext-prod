import * as vscode from 'vscode';
import {
  AdaceenSelectionWidget,
  SELECTION_WIDGET_ORIGIN,
  SelectionWidgetModel,
  sanitizeTutorMarkdown,
} from './selection-widget';
import { AdaceenQuizViewProvider, QuizHistoryItem } from './quiz-view';
import { buildIdentityHeaders, currentClientId, initClientIdentity } from './client-identity';
import {
  SuggestionExposureTracker,
  TelemetryCategory,
  TelemetryClient,
  TelemetryEventInput,
} from './telemetry';
import {
  BlockingSignal,
  DiagnosticLike,
  DiagnosticsSummary,
  ErrorSignal,
  ErrorSignalTracker,
  ERROR_TEXT_MAX_CHARS,
  SuggestDiagnostic,
  summarizeDiagnostics,
} from './error-signals';
import {
  ApplyCheckRequest,
  CodeApplicationGuardDeps,
  CodeApplicationVerdict,
  DEFAULT_OFFLINE_MAX_LINES,
  guardCodeApplication,
} from './code-application-guard';

const DEFAULT_INCLUDE_GLOB =
  '**/*.{ts,tsx,js,jsx,mjs,cjs,py,java,cpp,c,h,hpp,cs,go,rs,php,rb,md,json,yml,yaml,html,css,scss,sql,xml}';

const DEFAULT_DOCUMENT_INCLUDE_GLOB =
  '**/*.{pdf,docx,txt,md,markdown,png,jpg,jpeg,webp,gif,bmp,tiff}';

const DEFAULT_EXCLUDE_GLOB =
  '**/{node_modules,.git,dist,build,out,coverage,.next,target,bin,obj,vendor,__pycache__}/**';

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_FILE_BYTES = 300 * 1024; // 300 KB por archivo
const DEFAULT_MAX_DOCUMENTS = 12;
const DEFAULT_MAX_DOCUMENT_BYTES = 1024 * 1024;
const DEFAULT_BACKEND_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_CODESPACES_BACKEND_BASE_URL = 'https://app-adaceen-api-eyder05232002.azurewebsites.net';
const DEFAULT_WORKER_POLL_MS = 8000;
const DEFAULT_ACTIVE_SUGGESTION_DEBOUNCE_MS = 900;
const DEFAULT_ACTIVE_SUGGESTION_MAX_CODE_CHARS = 24000;
const DEFAULT_ACTIVE_SUGGESTION_TIMEOUT_MS = 120000;
const ACTIVE_SUGGESTION_FALLBACK_DELAY_MS = 120000;
const DEFAULT_CODE_ACTION_CONFIRM_LABEL = 'Aplicar reemplazo';
const ACTIVE_SUGGESTION_INDEX_TTL_MS = 60_000;
const ACTIVE_SUGGESTION_INDEX_MAX_FILES = 90;
const ACTIVE_SUGGESTION_INDEX_MAX_FILE_KB = 96;
const ACTIVE_SUGGESTION_INDEX_PREVIEW_CHARS = 220;
const ACTIVE_SUGGESTION_PROMPT_CODE_CHARS = 7200;
const ACTIVE_SUGGESTION_PROMPT_VISIBLE_CHARS = 1400;
const ACTIVE_SUGGESTION_PROMPT_SELECTION_CHARS = 12000;
const ACTIVE_SUGGESTION_SELECTION_MAX_LINES = 20;
const ACTIVE_SUGGESTION_PROMPT_INDEX_MAX_FILES = 24;
const ACTIVE_SUGGESTION_PROMPT_INDEX_PREVIEW_CHARS = 110;
const ACTIVE_SUGGESTION_CURSOR_IDLE_MS = 3000;
const ACTIVE_SUGGESTION_ACTION_IDLE_MS = 10000;
const ACTIVE_SUGGESTION_SELECTION_IDLE_MS = 1200;
const ACTIVE_SUGGESTION_SELECTION_ACTION_IDLE_MS = 2200;
const ACTIVE_SUGGESTION_POST_APPLY_GRACE_MS = 3500;
const ACTIVE_SUGGESTION_HISTORY_STORAGE_KEY = 'adaceen.suggestionHistory.v1';
const ACTIVE_SUGGESTION_HISTORY_LIMIT = 80;
const ACTIVE_SUGGESTION_HISTORY_PANEL_LIMIT = 5;
const WORKER_TICK_MS = 4000;
const DEFAULT_BLOCKING_SECONDS = 90;
const APPLY_CHECK_TIMEOUT_MS = 8000;
/** Una senal de bloqueo pendiente marca las peticiones siguientes como trigger "blocking" durante este tiempo. */
const BLOCKING_TRIGGER_TTL_MS = 10 * 60_000;
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'txt', 'md', 'markdown', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff']);

type ScanMode = 'auto' | 'local' | 'codespace' | 'all';

type ScannedFile = {
  path: string;
  bytes: number;
  lines: number;
  preview: string;
  content: string;
};

type ScannedDocument = {
  uri: vscode.Uri;
  path: string;
  fileName: string;
  extension: string;
  bytes: number;
};

type ScanCommandArgs = Partial<{
  mode: ScanMode | 'codespaces' | string;
  includeGlob: string;
  excludeGlob: string;
  maxFiles: number | string;
  maxFileBytes: number | string;
  maxFileKB: number | string;
  documentIncludeGlob: string;
  maxDocuments: number | string;
  maxDocumentBytes: number | string;
  maxDocumentKB: number | string;
}>;

type ScanOptions = {
  mode: ScanMode;
  includeGlob: string;
  excludeGlob: string;
  maxFiles: number;
  maxFileBytes: number;
  documentIncludeGlob: string;
  maxDocuments: number;
  maxDocumentBytes: number;
};

type ScanPayload = {
  repoFullName: string;
  runtime: {
    remoteName: string | null;
    isCodespace: boolean;
  };
  mode: {
    requested: ScanMode;
    applied: Exclude<ScanMode, 'auto'>;
  };
  workspaceFolders: Array<{ name: string; scheme: string }>;
  selectedFolders: Array<{ name: string; scheme: string }>;
  scannedAt: string;
  totalFiles: number;
  skippedBySize: number;
  files: ScannedFile[];
};

type ScanComputation = {
  payload: ScanPayload;
  options: ScanOptions;
  selection: {
    mode: Exclude<ScanMode, 'auto'>;
    folders: readonly vscode.WorkspaceFolder[];
    notes: string[];
  };
  documents: ScannedDocument[];
};

type BackendSettings = {
  baseUrl: string;
  scanWorkerKey: string;
  sessionId: string;
  autoWorkerEnabled: boolean;
  workerPollMs: number;
  workerId: string;
  requestTimeoutMs: number;
  codeActionsEnabled: boolean;
  autoApplyCodeActions: boolean;
};

type ActiveSuggestionSettings = {
  enabled: boolean;
  useBackend: boolean;
  autoRevealPanel: boolean;
  autoOpenSelectionActions: boolean;
  /** Ventana flotante anclada a la seleccion (Insertar / Modificar / Eliminar). */
  selectionWidget: boolean;
  debounceMs: number;
  maxCodeChars: number;
  backendTimeoutMs: number;
  ragCourseCode: string;
};

/** Activacion por eventos definidos (bloqueo). */
type TriggerSettings = {
  blockingSeconds: number;
  suggestOnBlocking: boolean;
};

type CodeApplicationSettings = {
  /** Sin respuesta de apply-check solo se aplican cambios de hasta estas lineas. */
  offlineMaxLines: number;
};

/** Origen real de una peticion a /suggest-tab (contrato: campo trigger). */
type SuggestionTrigger = 'cursor_idle' | 'selection' | 'manual' | 'blocking' | 'file_open' | 'panel';

/** policy_applied de /suggest-tab. */
type SuggestionPolicyApplied = {
  name: string;
  eventType: string;
  interventionType: string;
  detailLevel: string;
  helpStage: string;
  blocked: boolean;
  reason: string;
  reasonCode: string;
};

/** code_application de /suggest-tab. */
type SuggestionCodeApplication = {
  allowed: boolean;
  maxLines: number | null;
  remaining: number | null;
  requireConfirmation: boolean;
  countsAsHint: boolean;
  reason: string;
};

type ActiveSuggestionRagSource = {
  id: string;
  sourceId: string;
  chunkId: string;
  title: string;
  fileName: string;
  scope: string;
  courseCode: string;
  knowledgeTier: string;
  contextDomain: string;
  citationLabel: string;
  pageStart: number | null;
  pageEnd: number | null;
  excerpt: string;
  url: string;
};

type ActiveEditorSnapshot = {
  uriString: string;
  filePath: string;
  fileName: string;
  language: string;
  repoFullName: string;
  workspaceName: string;
  line: number;
  column: number;
  lineCount: number;
  selectionText: string;
  selectionStartLine: number;
  selectionEndLine: number;
  selectionLineCount: number;
  selectionOriginalLineCount: number;
  selectionTruncated: boolean;
  selectionRangeKey: string;
  visibleText: string;
  content: string;
  currentLineText: string;
  generatedAt: string;
  fileSummaryCacheKey: string;
  cacheKey: string;
  /** Errores y avisos del archivo activo al tomar la foto (para visibleError / diagnostics). */
  diagnostics: DiagnosticsSummary;
};

type ActiveSuggestionModel = {
  uriString: string;
  filePath: string;
  fileName: string;
  language: string;
  repoFullName: string;
  title: string;
  summary: string;
  fileOverview: string;
  lineSummary: string;
  suggestions: string[];
  fileSuggestions: string[];
  lineSuggestions: string[];
  nextSteps: string[];
  chips: string[];
  source: 'local' | 'backend' | 'local-fallback';
  backendError: string;
  ragSources: ActiveSuggestionRagSource[];
  ragCourseCode: string;
  updatedAt: string;
  line: number;
  column: number;
  selectionLineCount: number;
  selectionOriginalLineCount: number;
  selectionTruncated: boolean;
  selectionRangeKey: string;
  fileSummaryCacheKey: string;
  metricId: string;
  completionText: string;
  applyMode: SuggestionApplyMode;
  triggerKind: 'file' | 'cursor';
  actionsVisible?: boolean;
  loading?: boolean;
  applied?: boolean;
  appliedMode?: SuggestionApplyMode;
  /** decision_id que devolvio /suggest-tab (va en las metricas y en apply-check). */
  decisionId?: string;
  policyApplied?: SuggestionPolicyApplied | null;
  codeApplication?: SuggestionCodeApplication | null;
  /** La politica bloqueo la respuesta: solo mensaje del tutor, sin aplicar codigo. */
  blocked?: boolean;
  /** Markdown del tutor cuando blocked es true. */
  tutorMessage?: string;
  /** Origen real de la peticion que produjo esta sugerencia. */
  trigger?: SuggestionTrigger;
};

type VscodeReplacementOption = {
  id: string;
  label: string;
  description: string;
  actionType: string;
  originalText: string;
  replacementText: string;
  metadata: Record<string, unknown>;
};

type WorkspaceProjectIndexEntry = {
  path: string;
  language: string;
  bytes: number;
  lines: number;
  preview: string;
};

type WorkspaceProjectIndex = {
  cacheKey: string;
  generatedAt: string;
  totalFiles: number;
  files: WorkspaceProjectIndexEntry[];
  folders: string[];
};

type BackendSuggestionSections = {
  resumen: string[];
  sugerencias: string[];
  riesgos: string[];
  all: string[];
};

type BackendSuggestionScope = 'file' | 'cursor';
type BackendSuggestionRequestScope = 'file_summary' | 'cursor';

type BackendSuggestionInFlight = {
  key: string;
  request: Promise<BackendSuggestionResult>;
};

type BackendSuggestionResult = {
  outputText: string;
  ragSources: ActiveSuggestionRagSource[];
  ragCourseCode: string;
  decisionId: string;
  blocked: boolean;
  policyApplied: SuggestionPolicyApplied | null;
  codeApplication: SuggestionCodeApplication | null;
  /** Tiempo de ida y vuelta de /suggest-tab (null si salio de la cache local). */
  latencyMs: number | null;
};

/** Datos de la peticion que no forman parte de la foto del editor. */
type BackendSuggestionRequestContext = {
  trigger: SuggestionTrigger;
  clientSessionId: string;
};

type BackendSuggestionSettledResult =
  | { ok: true; result: BackendSuggestionResult }
  | { ok: false; error: unknown };

type SuggestionApplyMode = 'insert' | 'replace' | 'delete';

type ActiveSuggestionHistoryKind = 'line' | 'file';

type ActiveSuggestionHistoryEntry = {
  id: string;
  kind: ActiveSuggestionHistoryKind;
  filePath: string;
  fileName: string;
  language: string;
  repoFullName: string;
  title: string;
  summary: string;
  suggestions: string[];
  source: ActiveSuggestionModel['source'];
  triggerKind: ActiveSuggestionModel['triggerKind'];
  applyMode: SuggestionApplyMode;
  line: number;
  column: number;
  selectionStartLine: number;
  selectionEndLine: number;
  selectionLineCount: number;
  selectionOriginalLineCount: number;
  selectionTruncated: boolean;
  ragCourseCode: string;
  backendError: string;
  metricId: string;
  createdAt: string;
  updatedAt: string;
};

type CursorIdleAnchor = {
  uriString: string;
  version: number;
  line: number;
  column: number;
  selectionRangeKey: string;
};

type PendingScanRequest = {
  id: string;
  repoFullName: string;
};

type PendingCodeAction = {
  id: string;
  repoFullName: string;
  branch: string;
  filePath: string;
  actionType: string;
  title: string;
  originalText: string;
  replacementText: string;
  metadata: Record<string, unknown>;
};

function hasActiveSelection(snapshot: Pick<ActiveEditorSnapshot, 'selectionText'>) {
  return Boolean(snapshot.selectionText.trim());
}

type GitRemoteRef = {
  name?: string;
  fetchUrl?: string;
  pushUrl?: string;
};

type GitRepositoryRef = {
  rootUri?: vscode.Uri;
  state?: {
    remotes?: GitRemoteRef[];
  };
};

type GitApiRef = {
  repositories?: GitRepositoryRef[];
};

type GitExtensionExports = {
  getAPI(version: number): GitApiRef;
};

function getEnv(name: string): string | undefined {
  const processLike = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return processLike?.env?.[name];
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toPositiveInt(value: unknown): number | undefined {
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

function toNonNegativeInt(value: unknown): number | undefined {
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

function toBoolean(value: unknown): boolean | undefined {
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

function parseMode(value: unknown): ScanMode | undefined {
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

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeBackendBaseUrl(value: string | undefined): string {
  const fallback = DEFAULT_BACKEND_BASE_URL;
  const clean = toOptionalString(value);
  if (!clean) {
    return fallback;
  }
  return clean.replace(/\/+$/, '');
}

function getConfiguredString(config: vscode.WorkspaceConfiguration, key: string): string | undefined {
  const inspected = config.inspect<string>(key);
  return toOptionalString(inspected?.workspaceFolderLanguageValue) ??
    toOptionalString(inspected?.workspaceFolderValue) ??
    toOptionalString(inspected?.workspaceLanguageValue) ??
    toOptionalString(inspected?.workspaceValue) ??
    toOptionalString(inspected?.globalLanguageValue) ??
    toOptionalString(inspected?.globalValue);
}

function isCodespaceRuntime(): boolean {
  const remoteName = (vscode.env.remoteName ?? '').toLowerCase();
  if (remoteName.includes('codespace')) {
    return true;
  }

  const envFlag = (getEnv('CODESPACES') ?? '').toLowerCase();
  return envFlag === 'true' || envFlag === '1';
}

function resolveScanOptions(args: ScanCommandArgs | undefined): ScanOptions {
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

function resolveBackendSettings(): BackendSettings {
  const config = vscode.workspace.getConfiguration('adaceen');
  const configuredBaseUrl = getConfiguredString(config, 'backend.baseUrl');
  const defaultBaseUrl = isCodespaceRuntime()
    ? DEFAULT_CODESPACES_BACKEND_BASE_URL
    : DEFAULT_BACKEND_BASE_URL;

  const baseUrl = normalizeBackendBaseUrl(
    configuredBaseUrl ??
      toOptionalString(getEnv('ADACEEN_BACKEND_URL')) ??
      defaultBaseUrl,
  );

  const scanWorkerKey =
    toOptionalString(config.get<string>('backend.scanWorkerKey')) ??
    toOptionalString(getEnv('ADACEEN_SCAN_WORKER_KEY')) ??
    '';

  const sessionId =
    toOptionalString(config.get<string>('backend.sessionId')) ??
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

function resolveActiveSuggestionSettings(): ActiveSuggestionSettings {
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

function resolveTriggerSettings(): TriggerSettings {
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

function resolveCodeApplicationSettings(): CodeApplicationSettings {
  const config = vscode.workspace.getConfiguration('adaceen');
  const offlineMaxLines = Math.min(
    5000,
    toNonNegativeInt(config.get<number>('codeApplication.offlineMaxLines')) ??
      toNonNegativeInt(getEnv('ADACEEN_CODE_APPLICATION_OFFLINE_MAX_LINES')) ??
      DEFAULT_OFFLINE_MAX_LINES,
  );
  return { offlineMaxLines };
}

function selectFolders(
  requestedMode: ScanMode,
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): {
  mode: Exclude<ScanMode, 'auto'>;
  folders: readonly vscode.WorkspaceFolder[];
  notes: string[];
} {
  const notes: string[] = [];
  const resolvedMode: Exclude<ScanMode, 'auto'> =
    requestedMode === 'auto'
      ? isCodespaceRuntime()
        ? 'codespace'
        : 'local'
      : requestedMode;

  let folders: readonly vscode.WorkspaceFolder[];

  switch (resolvedMode) {
    case 'local':
      folders = workspaceFolders.filter((folder) => folder.uri.scheme === 'file');
      break;
    case 'codespace':
      folders = workspaceFolders.filter((folder) => folder.uri.scheme !== 'file');
      break;
    case 'all':
      folders = workspaceFolders;
      break;
  }

  if (!folders.length) {
    notes.push(`No se encontraron carpetas para modo "${resolvedMode}". Se usará todo el workspace.`);
    folders = workspaceFolders;
  }

  return { mode: resolvedMode, folders, notes };
}

async function findWorkspaceFiles(
  folders: readonly vscode.WorkspaceFolder[],
  options: ScanOptions,
): Promise<vscode.Uri[]> {
  const found = new Map<string, vscode.Uri>();

  for (const folder of folders) {
    const remaining = options.maxFiles - found.size;
    if (remaining <= 0) {
      break;
    }

    const includePattern = new vscode.RelativePattern(folder, options.includeGlob);
    const excludePattern = new vscode.RelativePattern(folder, options.excludeGlob);
    const files = await vscode.workspace.findFiles(
      includePattern,
      excludePattern,
      remaining,
    );

    for (const fileUri of files) {
      const key = fileUri.toString();
      if (!found.has(key)) {
        found.set(key, fileUri);
      }
    }
  }

  return [...found.values()];
}

function getDocumentExtension(uri: vscode.Uri) {
  const lastSegment = uri.path.split('/').pop() || '';
  const index = lastSegment.lastIndexOf('.');
  return index >= 0 ? lastSegment.slice(index + 1).toLowerCase() : '';
}

function normalizeDocumentName(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function scoreDocumentName(value: string) {
  const text = normalizeDocumentName(value);
  let score = 0;
  if (/\bbitacora\b/.test(text)) {
    score += 120;
  }
  if (/\blogbook\b/.test(text)) {
    score += 100;
  }
  if (/diario[-_\s]+de[-_\s]+campo/.test(text)) {
    score += 95;
  }
  if (/registro[-_\s]+(de[-_\s]+)?actividades/.test(text)) {
    score += 90;
  }
  if (/seguimiento[-_\s]+semanal/.test(text)) {
    score += 85;
  }
  if (/registro[-_\s]+(de[-_\s]+)?avance/.test(text)) {
    score += 80;
  }
  if (/\bavance(s)?\b/.test(text)) {
    score += 25;
  }
  if (/\bsemana[-_\s]*\d{1,2}\b/.test(text)) {
    score += 20;
  }
  return score;
}

async function findWorkspaceDocuments(
  folders: readonly vscode.WorkspaceFolder[],
  options: ScanOptions,
  output: vscode.OutputChannel,
): Promise<ScannedDocument[]> {
  const found = new Map<string, vscode.Uri>();

  for (const folder of folders) {
    const remaining = options.maxDocuments - found.size;
    if (remaining <= 0) {
      break;
    }

    const includePattern = new vscode.RelativePattern(folder, options.documentIncludeGlob);
    const excludePattern = new vscode.RelativePattern(folder, options.excludeGlob);
    const files = await vscode.workspace.findFiles(includePattern, excludePattern, remaining * 3);

    for (const fileUri of files) {
      const extension = getDocumentExtension(fileUri);
      if (!DOCUMENT_EXTENSIONS.has(extension)) {
        continue;
      }
      const key = fileUri.toString();
      if (!found.has(key)) {
        found.set(key, fileUri);
      }
      if (found.size >= options.maxDocuments) {
        break;
      }
    }
  }

  const documents: ScannedDocument[] = [];
  for (const uri of found.values()) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > options.maxDocumentBytes) {
        output.appendLine(`Documento omitido por tamano: ${vscode.workspace.asRelativePath(uri, false)} (${stat.size} bytes)`);
        continue;
      }

      const relativePath = vscode.workspace.asRelativePath(uri, false);
      documents.push({
        uri,
        path: relativePath,
        fileName: relativePath.split(/[\\/]/).pop() || relativePath,
        extension: getDocumentExtension(uri),
        bytes: stat.size,
      });
    } catch (error) {
      output.appendLine(`No se pudo preparar documento ${vscode.workspace.asRelativePath(uri, false)}: ${String(error)}`);
    }
  }

  return documents
    .sort((left, right) => scoreDocumentName(right.path) - scoreDocumentName(left.path) || left.path.localeCompare(right.path))
    .slice(0, options.maxDocuments);
}

async function performWorkspaceScan(args: ScanCommandArgs | undefined, output: vscode.OutputChannel): Promise<ScanComputation> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    throw new Error('Abre una carpeta o workspace antes de escanear.');
  }

  const options = resolveScanOptions(args);
  const selection = selectFolders(options.mode, workspaceFolders);
  const files = await findWorkspaceFiles(selection.folders, options);
  const documents = await findWorkspaceDocuments(selection.folders, options, output);

  const results: ScannedFile[] = [];
  let skippedBySize = 0;

  for (const uri of files) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);

      if (bytes.byteLength > options.maxFileBytes) {
        skippedBySize += 1;
        continue;
      }

      const textDocument = await vscode.workspace.openTextDocument(uri);
      const text = textDocument.getText();
      const lines = text.length ? text.split(/\r?\n/).length : 0;

      results.push({
        path: vscode.workspace.asRelativePath(uri, false),
        bytes: bytes.byteLength,
        lines,
        preview: text.slice(0, 300).replace(/\s+/g, ' ').trim(),
        content: text,
      });
    } catch (error) {
      output.appendLine(`No se pudo leer ${vscode.workspace.asRelativePath(uri, false)}: ${String(error)}`);
    }
  }

  const payload: ScanPayload = {
    repoFullName: '',
    runtime: {
      remoteName: vscode.env.remoteName ?? null,
      isCodespace: isCodespaceRuntime(),
    },
    mode: {
      requested: options.mode,
      applied: selection.mode,
    },
    workspaceFolders: workspaceFolders.map((folder) => ({
      name: folder.name,
      scheme: folder.uri.scheme,
    })),
    selectedFolders: selection.folders.map((folder) => ({
      name: folder.name,
      scheme: folder.uri.scheme,
    })),
    scannedAt: new Date().toISOString(),
    totalFiles: results.length,
    skippedBySize,
    files: results,
  };

  return {
    payload,
    options,
    selection,
    documents,
  };
}

function renderScanOutput(output: vscode.OutputChannel, scan: ScanComputation) {
  output.clear();
  output.appendLine('=== ADACEEN / Resumen del workspace ===');
  output.appendLine(`Entorno detectado: ${isCodespaceRuntime() ? 'Codespace/remoto' : 'Local'}`);
  output.appendLine(`Modo solicitado: ${scan.options.mode} | Modo aplicado: ${scan.selection.mode}`);
  output.appendLine(`Include: ${scan.options.includeGlob} | Exclude: ${scan.options.excludeGlob}`);
  output.appendLine(
    `Límites: ${scan.options.maxFiles} archivos, ${Math.round(scan.options.maxFileBytes / 1024)} KB por archivo`,
  );
  output.appendLine(
    `Carpetas usadas: ${scan.selection.folders
      .map((folder) => `${folder.name} [${folder.uri.scheme}]`)
      .join(', ')}`,
  );
  for (const note of scan.selection.notes) {
    output.appendLine(`Nota: ${note}`);
  }
  output.appendLine(`Archivos leídos: ${scan.payload.totalFiles}`);
  output.appendLine(`Archivos omitidos por tamaño: ${scan.payload.skippedBySize}`);
  output.appendLine(`Documentos candidatos: ${scan.documents.length}`);
  output.appendLine('');

  for (const file of scan.payload.files) {
    output.appendLine(`• ${file.path}`);
    output.appendLine(`  Líneas: ${file.lines} | Bytes: ${file.bytes}`);
    output.appendLine(`  Preview: ${file.preview || '(sin contenido visible)'}`);
    output.appendLine('');
  }

  for (const document of scan.documents) {
    output.appendLine(`Documento candidato: ${document.path}`);
    output.appendLine(`  Tipo: ${document.extension} | Bytes: ${document.bytes}`);
    output.appendLine('');
  }

  output.appendLine('=== JSON listo para enviar a backend ===');
  output.appendLine(JSON.stringify(scan.payload, null, 2));
}

async function fetchJsonWithTimeout(
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
        throw new Error('Backend no respondio a tiempo por Cloudflare 524. Se usara fallback local.');
      }
      if (looksLikeHtml) {
        throw new Error(`Backend devolvio HTML en lugar de JSON (HTTP ${response.status}).`);
      }
      throw new Error(structuredError || rawError || `HTTP ${response.status}`);
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
function buildWorkerHeaders(settings: BackendSettings, includeJsonContentType: boolean): Record<string, string> {
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
function buildSessionHeaders(settings: BackendSettings, includeJsonContentType: boolean): Record<string, string> {
  return {
    ...buildWorkerHeaders(settings, includeJsonContentType),
    ...buildIdentityHeaders(settings.sessionId),
  };
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function extractRepoFromGitUrl(url: string): string | undefined {
  const clean = url.trim();
  const patterns = [
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
  ];

  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (!match) {
      continue;
    }
    return `${match[1]}/${match[2]}`.toLowerCase();
  }

  return undefined;
}

function parseRepoFromGitConfig(raw: string): string | undefined {
  const originSection = raw.match(/\[remote\s+"origin"\]([\s\S]*?)(?:\n\[|$)/i)?.[1] || '';
  const originUrl = originSection.match(/^\s*url\s*=\s*(.+)\s*$/im)?.[1];
  const fromOrigin = originUrl ? extractRepoFromGitUrl(originUrl) : undefined;
  if (fromOrigin) {
    return fromOrigin;
  }

  const allUrls = raw.match(/^\s*url\s*=\s*(.+)\s*$/gim) || [];
  for (const line of allUrls) {
    const value = line.replace(/^\s*url\s*=\s*/i, '').trim();
    const parsed = extractRepoFromGitUrl(value);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function resolveGitDirUri(baseUri: vscode.Uri, gitDirRaw: string): vscode.Uri | undefined {
  const clean = gitDirRaw.trim().replace(/^"+|"+$/g, '');
  if (!clean) {
    return undefined;
  }

  if (/^[a-z]+:\/\//i.test(clean)) {
    try {
      return vscode.Uri.parse(clean);
    } catch {
      return undefined;
    }
  }

  if (/^[a-zA-Z]:[\\/]/.test(clean)) {
    try {
      return vscode.Uri.file(clean);
    } catch {
      return undefined;
    }
  }

  if (clean.startsWith('/')) {
    return baseUri.with({ path: clean });
  }

  return vscode.Uri.joinPath(baseUri, clean);
}

async function readGitConfigText(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
  try {
    const gitConfigUri = vscode.Uri.joinPath(folder.uri, '.git', 'config');
    const gitConfigDoc = await vscode.workspace.openTextDocument(gitConfigUri);
    return gitConfigDoc.getText();
  } catch {
    // Continuar con fallback cuando .git es un archivo de apuntador.
  }

  try {
    const gitEntryUri = vscode.Uri.joinPath(folder.uri, '.git');
    const gitEntryDoc = await vscode.workspace.openTextDocument(gitEntryUri);
    const gitDirRaw = gitEntryDoc.getText().match(/^\s*gitdir:\s*(.+)\s*$/im)?.[1];
    if (!gitDirRaw) {
      return undefined;
    }

    const gitDirUri = resolveGitDirUri(folder.uri, gitDirRaw);
    if (!gitDirUri) {
      return undefined;
    }

    const pointedConfigUri = vscode.Uri.joinPath(gitDirUri, 'config');
    const pointedConfigDoc = await vscode.workspace.openTextDocument(pointedConfigUri);
    return pointedConfigDoc.getText();
  } catch {
    return undefined;
  }
}

async function detectRepoFromGitExtension(
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): Promise<string | undefined> {
  try {
    const gitExtension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!gitExtension) {
      return undefined;
    }

    const gitExports = (gitExtension.isActive
      ? gitExtension.exports
      : await gitExtension.activate()) as GitExtensionExports | undefined;
    if (!gitExports || typeof gitExports.getAPI !== 'function') {
      return undefined;
    }

    const api = gitExports.getAPI(1);
    const repositories = Array.isArray(api.repositories) ? api.repositories : [];
    const workspaceUris = workspaceFolders.map((folder) => folder.uri.toString().toLowerCase());

    for (const repo of repositories) {
      const rootUri = repo.rootUri;
      if (!rootUri) {
        continue;
      }

      const rootRef = rootUri.toString().toLowerCase();
      const belongsToWorkspace = workspaceUris.some(
        (workspaceUri) => rootRef.startsWith(workspaceUri) || workspaceUri.startsWith(rootRef),
      );
      if (!belongsToWorkspace) {
        continue;
      }

      const remotes = Array.isArray(repo.state?.remotes) ? [...repo.state.remotes] : [];
      remotes.sort((a, b) => {
        const aIsOrigin = (a.name || '').toLowerCase() === 'origin';
        const bIsOrigin = (b.name || '').toLowerCase() === 'origin';
        if (aIsOrigin === bIsOrigin) {
          return 0;
        }
        return aIsOrigin ? -1 : 1;
      });

      for (const remote of remotes) {
        const candidate = remote.fetchUrl || remote.pushUrl;
        if (!candidate) {
          continue;
        }
        const parsed = extractRepoFromGitUrl(candidate);
        if (parsed) {
          return parsed;
        }
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function detectRepoFullName(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<string | undefined> {
  for (const folder of workspaceFolders) {
    const gitConfigText = await readGitConfigText(folder);
    if (!gitConfigText) {
      continue;
    }
    const parsed = parseRepoFromGitConfig(gitConfigText);
    if (parsed) {
      return parsed;
    }
  }
  return detectRepoFromGitExtension(workspaceFolders);
}

async function claimNextScanRequest(
  settings: BackendSettings,
  repoFullName: string,
): Promise<PendingScanRequest | null> {
  const query = `?repoFullName=${encodeURIComponent(repoFullName)}`;
  const response = await fetchJsonWithTimeout(
    `${settings.baseUrl}/api/projects/scan/request/next${query}`,
    {
      method: 'GET',
      headers: buildWorkerHeaders(settings, false),
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

async function sendScanResult(
  settings: BackendSettings,
  requestId: string,
  payload: ScanPayload,
) {
  return fetchJsonWithTimeout(
    `${settings.baseUrl}/api/projects/scan/request/${encodeURIComponent(requestId)}/result`,
    {
      method: 'POST',
      headers: buildWorkerHeaders(settings, true),
      body: JSON.stringify(payload),
    },
    settings.requestTimeoutMs,
  );
}

async function claimNextCodeAction(
  settings: BackendSettings,
  repoFullName: string,
): Promise<PendingCodeAction | null> {
  if (!settings.sessionId || !settings.codeActionsEnabled) {
    return null;
  }

  const query = `?repoFullName=${encodeURIComponent(repoFullName)}`;
  const response = await fetchJsonWithTimeout(
    `${settings.baseUrl}/api/projects/code-actions/next${query}`,
    {
      method: 'GET',
      headers: buildSessionHeaders(settings, false),
    },
    settings.requestTimeoutMs,
  );

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
  };
}

async function completeCodeAction(
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

async function failCodeAction(
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

function mimeTypeForDocument(extension: string) {
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

function bytesToBase64(bytes: Uint8Array) {
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

function shouldUseModelForDocument(document: ScannedDocument, index: number) {
  return index < 3 || scoreDocumentName(document.path) >= 25;
}

async function sendDocumentClassification(
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
      headers: buildWorkerHeaders(settings, true),
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

async function classifyScannedDocuments(
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

async function sendScanFailure(
  settings: BackendSettings,
  requestId: string,
  errorMessage: string,
) {
  try {
    await fetchJsonWithTimeout(
      `${settings.baseUrl}/api/projects/scan/request/${encodeURIComponent(requestId)}/fail`,
      {
        method: 'POST',
        headers: buildWorkerHeaders(settings, true),
        body: JSON.stringify({ error: errorMessage.slice(0, 1200) }),
      },
      settings.requestTimeoutMs,
    );
  } catch {
    // No-op: el worker intenta reportar, pero no debe romper el ciclo si esto falla.
  }
}

function pathBaseName(value: string) {
  const clean = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return clean[clean.length - 1] || value || 'archivo';
}

function pathExtension(value: string) {
  const baseName = pathBaseName(value).toLowerCase();
  const index = baseName.lastIndexOf('.');
  return index >= 0 ? baseName.slice(index + 1) : '';
}

function inferActiveLanguage(filePath: string, languageId: string) {
  const cleanLanguageId = toOptionalString(languageId);
  if (cleanLanguageId && cleanLanguageId !== 'plaintext') {
    return cleanLanguageId;
  }

  switch (pathExtension(filePath)) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'py':
      return 'python';
    case 'java':
      return 'java';
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'c':
    case 'hpp':
    case 'h':
      return 'cpp';
    case 'cs':
      return 'csharp';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'php':
      return 'php';
    case 'rb':
      return 'ruby';
    case 'html':
      return 'html';
    case 'css':
    case 'scss':
      return 'css';
    case 'json':
      return 'json';
    case 'md':
    case 'markdown':
      return 'markdown';
    default:
      return 'general';
  }
}

function truncateInline(value: string, max = 120) {
  const text = toOptionalString(value) || '';
  if (!text || max <= 0) {
    return '';
  }
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function uniqueCompactStrings(items: string[], limit: number) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const clean = item.replace(/\s+/g, ' ').trim();
    if (!clean) {
      continue;
    }
    const key = clean.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(clean);
    if (output.length >= limit) {
      break;
    }
  }
  return output;
}

function firstPositiveNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return number;
    }
  }
  return null;
}

function normalizeCourseCode(value: unknown) {
  return (toOptionalString(value) || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
}

function parseRagPageRangeFromLabel(label: unknown) {
  const match = (toOptionalString(label) || '').match(/\bp\.\s*(\d+)(?:\s*-\s*(\d+))?/i);
  if (!match) {
    return { pageStart: null as number | null, pageEnd: null as number | null };
  }
  const pageStart = firstPositiveNumber(match[1]);
  const pageEnd = firstPositiveNumber(match[2]) || pageStart;
  return { pageStart, pageEnd };
}

function normalizeRagSources(value: unknown): ActiveSuggestionRagSource[] {
  const items = Array.isArray(value) ? value : [];
  return items.map((item) => {
    const source = asRecord(item);
    const citation = asRecord(source.citation);
    const metadata = asRecord(source.metadata);
    const citationLabel = toOptionalString(source.citationLabel) ||
      toOptionalString(citation.label) ||
      toOptionalString(citation.marker) ||
      '';
    const labelPageRange = parseRagPageRangeFromLabel(citationLabel);
    const sourceId = toOptionalString(source.sourceId) || toOptionalString(citation.sourceId) || toOptionalString(source.id) || '';
    const chunkId = toOptionalString(source.chunkId) || toOptionalString(citation.chunkId) || '';
    return {
      id: toOptionalString(source.id) || sourceId || chunkId || citationLabel,
      sourceId,
      chunkId,
      title: toOptionalString(source.title) || toOptionalString(citation.title) || 'Fuente RAG',
      fileName: toOptionalString(source.fileName) || toOptionalString(citation.fileName) || '',
      scope: toOptionalString(source.scope) || '',
      knowledgeTier: toOptionalString(source.knowledgeTier) ||
        toOptionalString(metadata.knowledgeTier) ||
        toOptionalString(metadata.knowledge_tier) ||
        '',
      contextDomain: toOptionalString(source.contextDomain) ||
        toOptionalString(metadata.contextDomain) ||
        toOptionalString(metadata.context_domain) ||
        '',
      courseCode: normalizeCourseCode(source.courseCode) ||
        normalizeCourseCode(source.course_code) ||
        normalizeCourseCode(metadata.courseCode) ||
        normalizeCourseCode(metadata.course_code),
      citationLabel,
      pageStart: firstPositiveNumber(
        source.pageStart,
        source.page_start,
        source.page,
        source.pageNumber,
        source.page_number,
        citation.pageStart,
        citation.page_start,
        citation.page,
        citation.pageNumber,
        citation.page_number,
        metadata.pageStart,
        metadata.page_start,
        metadata.page,
        metadata.pageNumber,
        metadata.page_number,
        labelPageRange.pageStart,
      ),
      pageEnd: firstPositiveNumber(
        source.pageEnd,
        source.page_end,
        citation.pageEnd,
        citation.page_end,
        metadata.pageEnd,
        metadata.page_end,
        labelPageRange.pageEnd,
      ),
      excerpt: toOptionalString(source.excerpt) || '',
      url: toOptionalString(source.url) || toOptionalString(citation.url) || '',
    };
  })
    .filter((item) => item.title || item.fileName || item.citationLabel)
    .slice(0, 5);
}

function optionalFiniteInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : null;
}

function normalizePolicyApplied(value: unknown): SuggestionPolicyApplied | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const data = asRecord(value);
  const text = (key: string) => (toOptionalString(data[key]) || '').slice(0, 200);
  return {
    name: text('name'),
    eventType: text('eventType'),
    interventionType: text('interventionType'),
    detailLevel: text('detailLevel'),
    helpStage: text('helpStage'),
    blocked: data.blocked === true,
    reason: (toOptionalString(data.reason) || '').slice(0, 600),
    reasonCode: text('reasonCode'),
  };
}

function normalizeSuggestionCodeApplication(value: unknown): SuggestionCodeApplication | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const data = asRecord(value);
  return {
    allowed: data.allowed !== false,
    maxLines: optionalFiniteInt(data.maxLines),
    remaining: optionalFiniteInt(data.remaining),
    requireConfirmation: data.requireConfirmation === true,
    countsAsHint: data.countsAsHint === true,
    reason: (toOptionalString(data.reason) || '').slice(0, 600),
  };
}

function normalizeBackendSuggestionResult(value: unknown, latencyMs: number | null = null): BackendSuggestionResult {
  const data = asRecord(value);
  const policyApplied = normalizePolicyApplied(data.policy_applied ?? data.policyApplied);
  return {
    outputText: toOptionalString(data.output_text) || toOptionalString(data.outputText) || '',
    ragSources: normalizeRagSources(data.rag_sources || data.ragSources),
    ragCourseCode: normalizeCourseCode(data.rag_course_code) || normalizeCourseCode(data.ragCourseCode),
    decisionId: (toOptionalString(data.decision_id) || toOptionalString(data.decisionId) || '').slice(0, 80),
    blocked: data.blocked === true || policyApplied?.blocked === true,
    policyApplied,
    codeApplication: normalizeSuggestionCodeApplication(data.code_application ?? data.codeApplication),
    latencyMs,
  };
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function isAbortLikeError(error: unknown) {
  const message = String(error);
  return error instanceof Error && error.name === 'AbortError'
    || /AbortError|aborted|abortado|operaci[oó]n.*abort/i.test(message);
}

function formatBackendSuggestionError(error: unknown) {
  if (isAbortLikeError(error)) {
    return 'El backend tardo demasiado; se mantiene la sugerencia local mientras llega una respuesta nueva.';
  }

  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/^Error:\s*/i, '')
    .replace(/\bAbortError:\s*/gi, '')
    .replace(/The operation was aborted\.?/gi, 'El backend tardo demasiado.')
    .trim() || 'Backend no disponible para sugerencias.';
}

function withActiveSuggestionDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Backend tardo mas de ${Math.round(timeoutMs / 1000)}s; se muestra fallback local.`));
    }, timeoutMs);

    promise.then(
      (value) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve(value);
      },
      (error) => {
        if (timeout) {
          clearTimeout(timeout);
        }
        reject(error);
      },
    );
  });
}

function createEmptyBackendSuggestionResult(): BackendSuggestionResult {
  return {
    outputText: '',
    ragSources: [],
    ragCourseCode: '',
    decisionId: '',
    blocked: false,
    policyApplied: null,
    codeApplication: null,
    latencyMs: null,
  };
}

async function settleBackendSuggestionResult(
  promise: Promise<BackendSuggestionResult>,
): Promise<BackendSuggestionSettledResult> {
  try {
    return { ok: true, result: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function stableStringHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function getWorkspaceProjectIndexIdentity() {
  const folders = vscode.workspace.workspaceFolders || [];
  return folders
    .map((folder) => `${folder.uri.scheme}:${folder.uri.toString()}`)
    .sort()
    .join('|');
}

function prioritizeWorkspaceIndexEntry(entry: WorkspaceProjectIndexEntry, activePath: string) {
  const lowerPath = entry.path.toLowerCase();
  const lowerActive = activePath.toLowerCase();
  const activeDir = lowerActive.includes('/') ? lowerActive.slice(0, lowerActive.lastIndexOf('/')) : '';
  let score = 0;

  if (lowerPath === lowerActive) {
    score += 1000;
  }
  if (activeDir && lowerPath.startsWith(`${activeDir}/`)) {
    score += 130;
  }
  if (/(^|\/)(readme|package|pyproject|requirements|pom|build\.gradle|angular|vite|next|tsconfig|webpack)\b/i.test(lowerPath)) {
    score += 70;
  }
  if (/(^|\/)(src|app|lib|services|components|routes|models|controllers)\//i.test(lowerPath)) {
    score += 45;
  }
  if (/(^|\/)(test|tests|__tests__|spec|specs)\//i.test(lowerPath) || /\.(test|spec)\./i.test(lowerPath)) {
    score += 20;
  }
  if (entry.preview) {
    score += 10;
  }
  return score;
}

async function buildWorkspaceProjectIndexForSuggestions(output: vscode.OutputChannel): Promise<WorkspaceProjectIndex | null> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders?.length) {
    return null;
  }

  const options = resolveScanOptions({
    maxFiles: ACTIVE_SUGGESTION_INDEX_MAX_FILES,
    maxFileKB: ACTIVE_SUGGESTION_INDEX_MAX_FILE_KB,
    maxDocuments: 0,
  });
  const selection = selectFolders(options.mode, workspaceFolders);
  const files = await findWorkspaceFiles(selection.folders, options);
  const entries: WorkspaceProjectIndexEntry[] = [];

  for (const uri of files) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > options.maxFileBytes) {
        continue;
      }

      const document = await vscode.workspace.openTextDocument(uri);
      const text = document.getText();
      const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
      entries.push({
        path: relativePath,
        language: inferActiveLanguage(relativePath, document.languageId),
        bytes: stat.size,
        lines: text.length ? text.split(/\r?\n/).length : 0,
        preview: text.slice(0, ACTIVE_SUGGESTION_INDEX_PREVIEW_CHARS).replace(/\s+/g, ' ').trim(),
      });
    } catch (error) {
      output.appendLine(`[Suggestions] No se pudo indexar ${vscode.workspace.asRelativePath(uri, false)}: ${String(error)}`);
    }
  }

  const signature = entries
    .map((entry) => `${entry.path}|${entry.bytes}|${entry.lines}|${entry.preview}`)
    .join('\n');

  return {
    cacheKey: stableStringHash(`${getWorkspaceProjectIndexIdentity()}\n${signature}`),
    generatedAt: new Date().toISOString(),
    totalFiles: entries.length,
    files: entries,
    folders: selection.folders.map((folder) => `${folder.name} [${folder.uri.scheme}]`),
  };
}

function formatWorkspaceProjectIndexForPrompt(index: WorkspaceProjectIndex | null, activePath: string) {
  if (!index || index.files.length === 0) {
    return "Mapa local del proyecto: no disponible.";
  }

  const ranked = [...index.files]
    .sort((left, right) => {
      const scoreDiff = prioritizeWorkspaceIndexEntry(right, activePath) - prioritizeWorkspaceIndexEntry(left, activePath);
      return scoreDiff || left.path.localeCompare(right.path);
    })
    .slice(0, ACTIVE_SUGGESTION_PROMPT_INDEX_MAX_FILES);

  return [
    `Mapa local del proyecto generado por VS Code: ${index.totalFiles} archivo(s) indexado(s).`,
    `Carpetas: ${index.folders.join(', ') || '(sin carpetas)'}`,
    "Archivos relevantes del workspace:",
    ...ranked.map((entry) => [
      `- ${entry.path}`,
      `${entry.language}`,
      `${entry.lines} lineas`,
      `${entry.bytes} bytes`,
      entry.preview ? `preview: ${truncateInline(entry.preview, ACTIVE_SUGGESTION_PROMPT_INDEX_PREVIEW_CHARS)}` : "sin preview",
    ].join(' | ')),
  ].join('\n');
}

function extractSymbolNames(code: string, language: string) {
  const cleanLanguage = language.toLowerCase();
  const classNames = new Set<string>();
  const functionNames = new Set<string>();
  const importNames = new Set<string>();

  for (const match of code.matchAll(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    classNames.add(match[1]);
  }

  if (cleanLanguage === 'python') {
    for (const match of code.matchAll(/\bdef\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      functionNames.add(match[1]);
    }
    for (const match of code.matchAll(/^\s*(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.,\s]+))/gm)) {
      importNames.add((match[1] || match[2] || '').split(',')[0].trim());
    }
  } else {
    for (const match of code.matchAll(/\b(?:function\s+|const\s+|let\s+|var\s+|public\s+|private\s+|protected\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*(?:async\s*)?\([^)]*\)\s*=>|\([^)]*\)\s*\{)/g)) {
      functionNames.add(match[1]);
    }
    for (const match of code.matchAll(/^\s*import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/gm)) {
      importNames.add(match[1]);
    }
  }

  return {
    classes: [...classNames].slice(0, 5),
    functions: [...functionNames].filter((name) => !['if', 'for', 'while', 'switch'].includes(name)).slice(0, 8),
    imports: [...importNames].filter(Boolean).slice(0, 5),
  };
}

function inferFileRoleFromPath(filePath: string) {
  const lowerPath = filePath.toLowerCase();
  if (/(^|\/)(test|tests|__tests__|spec|specs)\//i.test(lowerPath) || /\.(test|spec)\./i.test(lowerPath)) {
    return "contiene pruebas o validaciones del proyecto";
  }
  if (/requirements\.txt$|pyproject\.toml$|package\.json$|pom\.xml$|build\.gradle$/i.test(lowerPath)) {
    return "declara dependencias, scripts o configuracion de construccion";
  }
  if (/readme|\.md$/i.test(lowerPath)) {
    return "documenta informacion del proyecto";
  }
  if (/routes?|controllers?|views?/.test(lowerPath)) {
    return "coordina rutas, vistas o entrada de peticiones";
  }
  if (/services?|api|client/.test(lowerPath)) {
    return "concentra logica de servicio o comunicacion con otras capas";
  }
  if (/models?|entities|schema/.test(lowerPath)) {
    return "define datos, entidades o estructura del dominio";
  }
  if (/components?|pages?/.test(lowerPath)) {
    return "forma parte de la interfaz o de una pagina visible";
  }
  if (/\.css$|\.scss$|styles?/.test(lowerPath)) {
    return "define estilos visuales";
  }
  return "aporta logica o configuracion al proyecto";
}

function findRelatedWorkspacePaths(index: WorkspaceProjectIndex | null, filePath: string) {
  if (!index) {
    return [];
  }
  const lowerPath = filePath.toLowerCase();
  const activeDir = lowerPath.includes('/') ? lowerPath.slice(0, lowerPath.lastIndexOf('/')) : '';
  return index.files
    .filter((entry) => entry.path.toLowerCase() !== lowerPath)
    .filter((entry) => {
      const entryPath = entry.path.toLowerCase();
      return activeDir ? entryPath.startsWith(`${activeDir}/`) : pathExtension(entryPath) === pathExtension(lowerPath);
    })
    .map((entry) => entry.path)
    .slice(0, 4);
}

function buildLocalFileOverview(snapshot: ActiveEditorSnapshot, index: WorkspaceProjectIndex | null = null) {
  const symbols = extractSymbolNames(snapshot.content, snapshot.language);
  const parts = [
    `${snapshot.fileName} es un archivo ${snapshot.language} que ${inferFileRoleFromPath(snapshot.filePath)}.`,
  ];

  if (symbols.classes.length > 0) {
    parts.push(`Define clase(s) como ${symbols.classes.join(', ')}.`);
  }
  if (symbols.functions.length > 0) {
    parts.push(`Incluye funciones/metodos como ${symbols.functions.join(', ')}.`);
  }
  if (symbols.imports.length > 0) {
    parts.push(`Se apoya en ${symbols.imports.join(', ')}.`);
  }

  const relatedPaths = findRelatedWorkspacePaths(index, snapshot.filePath);
  if (relatedPaths.length > 0) {
    parts.push(`En el contexto local se relaciona con ${relatedPaths.join(', ')}.`);
  } else if (index?.totalFiles) {
    parts.push(`Se analizo dentro de un workspace con ${index.totalFiles} archivo(s) indexado(s).`);
  }

  return truncateInline(parts.join(' '), 420);
}

function getBackendSuggestionScopeLabel(scope: BackendSuggestionScope) {
  return scope === 'cursor' ? 'cursor' : 'archivo';
}

function cleanBackendSuggestionLine(value: string) {
  return value
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/g, '')
    .replace(/^#+\s*/g, '')
    .replace(/\*\*/g, '')
    .trim();
}

function parseBackendSuggestionSections(output: string): BackendSuggestionSections {
  const sections: BackendSuggestionSections = {
    resumen: [],
    sugerencias: [],
    riesgos: [],
    all: [],
  };
  let current: keyof Omit<BackendSuggestionSections, 'all'> | '' = '';

  for (const rawLine of output.split(/\r?\n/)) {
    const clean = cleanBackendSuggestionLine(rawLine);
    if (!clean) {
      continue;
    }

    const normalized = clean
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    if (/^1\s*[).:-]?\s*resumen\b/.test(normalized) || /^resumen\b/.test(normalized)) {
      current = 'resumen';
      continue;
    }
    if (/^2\s*[).:-]?\s*sugerencias?\b/.test(normalized) || /^sugerencias?\b/.test(normalized)) {
      current = 'sugerencias';
      continue;
    }
    if (/^\d?\s*[).:-]?\s*accion\b/.test(normalized) || /^(accion|aplicar|modo)\s*:/.test(normalized)) {
      current = '';
      continue;
    }
    if (/^\d?\s*[).:-]?\s*(dudas?|riesgos?)/.test(normalized) || /^(dudas?|riesgos?)/.test(normalized)) {
      current = 'riesgos';
      continue;
    }
    if (/^enlaces?\s+relevantes?\b/.test(normalized)) {
      current = '';
      continue;
    }
    if (clean.length < 8) {
      continue;
    }

    sections.all.push(clean);
    if (current) {
      sections[current].push(clean);
    }
  }

  return {
    resumen: uniqueCompactStrings(sections.resumen, 5),
    sugerencias: uniqueCompactStrings(sections.sugerencias, 5),
    riesgos: uniqueCompactStrings(sections.riesgos, 4),
    all: uniqueCompactStrings(sections.all, 8),
  };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildCommandUri(command: string, args: unknown[] = []) {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

function withRagViewerSessionParam(rawUrl: string) {
  const text = toOptionalString(rawUrl) || '';
  if (!text) {
    return '';
  }
  const settings = resolveBackendSettings();
  try {
    const parsed = new URL(text, settings.baseUrl || undefined);
    const isAdaceenViewer = /\/api\/rag\/sources\/[^/]+\/view\b/i.test(parsed.pathname);
    if (isAdaceenViewer && settings.sessionId && !parsed.searchParams.get('sessionId')) {
      parsed.searchParams.set('sessionId', settings.sessionId);
    }
    return isAdaceenViewer ? parsed.toString() : text;
  } catch {
    return text;
  }
}

function buildRagSourceTargetUrl(source: ActiveSuggestionRagSource) {
  const rawUrl = withRagViewerSessionParam(toOptionalString(source.url) || '');
  if (!rawUrl || !/^[a-z][a-z0-9+.-]*:/i.test(rawUrl)) {
    return '';
  }
  if (/\/api\/rag\/sources\/[^/]+\/view\b/i.test(rawUrl)) {
    return rawUrl;
  }
  if (!source.pageStart || rawUrl.includes('#')) {
    return rawUrl;
  }
  return `${rawUrl}#page=${source.pageStart}`;
}

function buildRagSourceMarkdown(source: ActiveSuggestionRagSource) {
  const targetUrl = buildRagSourceTargetUrl(source);
  const pageText = source.pageStart
    ? (source.pageEnd && source.pageEnd !== source.pageStart
      ? `Paginas ${source.pageStart}-${source.pageEnd}`
      : `Pagina ${source.pageStart}`)
    : '';
  const details = [
    source.courseCode ? `Curso: ${source.courseCode}` : '',
    source.scope ? `Ambito: ${source.scope}` : '',
    source.fileName ? `Archivo: ${source.fileName}` : '',
    pageText,
    source.citationLabel ? `Cita: ${source.citationLabel}` : '',
    targetUrl ? `URL: ${targetUrl}` : '',
  ].filter(Boolean);
  const lines = [
    `# ${source.title || 'Fuente RAG'}`,
    '',
    ...details,
  ];
  if (source.excerpt) {
    lines.push('', '## Fragmento', source.excerpt);
  }
  return lines.join('\n');
}

function isSupportedActiveDocument(document: vscode.TextDocument) {
  if (document.uri.scheme === 'output' || document.uri.scheme === 'debug' || document.uri.scheme === 'vscode-chat') {
    return false;
  }
  if (document.isUntitled && !document.getText().trim()) {
    return false;
  }
  return true;
}

function getVisibleEditorText(editor: vscode.TextEditor, maxChars: number) {
  const chunks: string[] = [];
  let size = 0;
  for (const range of editor.visibleRanges) {
    const text = editor.document.getText(range);
    if (!text) {
      continue;
    }
    chunks.push(text);
    size += text.length + 1;
    if (size >= maxChars) {
      break;
    }
  }
  return chunks.join('\n').slice(0, maxChars);
}

function effectiveSelectionEndLine(selection: vscode.Selection) {
  if (!selection.isEmpty && selection.end.character === 0 && selection.end.line > selection.start.line) {
    return selection.end.line - 1;
  }
  return selection.end.line;
}

function buildSelectionRangeKey(editor: vscode.TextEditor) {
  const selection = editor.selection;
  return [
    selection.start.line,
    selection.start.character,
    selection.end.line,
    selection.end.character,
    selection.active.line,
    selection.active.character,
    selection.isEmpty ? 'empty' : 'selection',
  ].join(':');
}

function getSelectedEditorSnippet(editor: vscode.TextEditor, maxChars: number) {
  const selection = editor.selection;
  if (selection.isEmpty) {
    return {
      text: '',
      startLine: 0,
      endLine: 0,
      lineCount: 0,
      originalLineCount: 0,
      truncated: false,
      rangeKey: buildSelectionRangeKey(editor),
    };
  }

  const startLine = Math.max(0, Math.min(selection.start.line, editor.document.lineCount - 1));
  const effectiveEndLine = Math.max(startLine, Math.min(effectiveSelectionEndLine(selection), editor.document.lineCount - 1));
  const originalLineCount = Math.max(1, effectiveEndLine - startLine + 1);
  const limitedEndLine = Math.min(effectiveEndLine, startLine + ACTIVE_SUGGESTION_SELECTION_MAX_LINES - 1);
  const truncatedByLines = limitedEndLine < effectiveEndLine;
  const endPosition = truncatedByLines
    ? editor.document.lineAt(limitedEndLine).range.end
    : selection.end;
  const range = new vscode.Range(selection.start, endPosition);
  const rawText = editor.document.getText(range);
  const text = rawText.slice(0, maxChars);

  return {
    text,
    startLine: startLine + 1,
    endLine: limitedEndLine + 1,
    lineCount: Math.max(1, limitedEndLine - startLine + 1),
    originalLineCount,
    truncated: truncatedByLines,
    rangeKey: buildSelectionRangeKey(editor),
  };
}

function diagnosticSeverityName(severity: vscode.DiagnosticSeverity): DiagnosticLike['severity'] {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'information';
    default:
      return 'hint';
  }
}

/** Errores y avisos que VS Code muestra ahora mismo para el documento. */
function collectDocumentDiagnostics(uri: vscode.Uri): DiagnosticsSummary {
  let diagnostics: readonly vscode.Diagnostic[] = [];
  try {
    diagnostics = vscode.languages.getDiagnostics(uri);
  } catch {
    diagnostics = [];
  }
  return summarizeDiagnostics(diagnostics.map((item) => ({
    message: typeof item.message === 'string' ? item.message : String(item.message),
    severity: diagnosticSeverityName(item.severity),
    line: item.range.start.line + 1,
    character: item.range.start.character,
  })));
}

async function buildActiveEditorSnapshot(settings: ActiveSuggestionSettings): Promise<ActiveEditorSnapshot | null> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isSupportedActiveDocument(editor.document)) {
    return null;
  }

  const document = editor.document;
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const workspaceName = workspaceFolder?.name || workspaceFolders[0]?.name || '';
  const repoFullName = workspaceFolders.length
    ? (await detectRepoFullName(workspaceFolders).catch(() => undefined)) || ''
    : '';
  const filePath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
  const fileName = pathBaseName(filePath);
  const content = document.getText().slice(0, settings.maxCodeChars);
  const activeLine = editor.selection.active.line;
  const currentLineText = activeLine >= 0 && activeLine < document.lineCount
    ? document.lineAt(activeLine).text
    : '';
  const selection = getSelectedEditorSnippet(editor, ACTIVE_SUGGESTION_PROMPT_SELECTION_CHARS);
  const visibleText = getVisibleEditorText(editor, Math.min(settings.maxCodeChars, 12000));
  const language = inferActiveLanguage(filePath, document.languageId);
  const generatedAt = new Date().toISOString();
  const line = editor.selection.active.line + 1;
  const column = editor.selection.active.character + 1;
  const fileSummaryCacheKey = stableStringHash([
    repoFullName,
    filePath,
    language,
    content,
  ].join('\n---adaceen-file-summary---\n'));
  const cacheKey = stableStringHash([
    repoFullName,
    filePath,
    language,
    line,
    column,
    selection.startLine,
    selection.endLine,
    selection.lineCount,
    selection.originalLineCount,
    selection.truncated,
    selection.text,
    content,
  ].join('\n---adaceen---\n'));

  return {
    uriString: document.uri.toString(),
    filePath,
    fileName,
    language,
    repoFullName,
    workspaceName,
    line,
    column,
    lineCount: document.lineCount,
    selectionText: selection.text,
    selectionStartLine: selection.startLine,
    selectionEndLine: selection.endLine,
    selectionLineCount: selection.lineCount,
    selectionOriginalLineCount: selection.originalLineCount,
    selectionTruncated: selection.truncated,
    selectionRangeKey: selection.rangeKey,
    visibleText,
    content,
    currentLineText,
    generatedAt,
    fileSummaryCacheKey,
    cacheKey,
    diagnostics: collectDocumentDiagnostics(document.uri),
  };
}

/** El archivo de la sugerencia sigue abierto en algun grupo del editor. */
function isSuggestionModelDocumentVisible(model: ActiveSuggestionModel | null) {
  if (!model) {
    return false;
  }
  return vscode.window.visibleTextEditors.some((editor) => editor.document.uri.toString() === model.uriString);
}

function isSnapshotStillActive(snapshot: ActiveEditorSnapshot, scope: BackendSuggestionScope) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== snapshot.uriString) {
    return false;
  }

  if (scope !== 'cursor') {
    return true;
  }

  return editor.selection.active.line + 1 === snapshot.line
    && editor.selection.active.character + 1 === snapshot.column
    && buildSelectionRangeKey(editor) === snapshot.selectionRangeKey;
}

function getCursorIdleAnchor(): CursorIdleAnchor | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isSupportedActiveDocument(editor.document)) {
    return null;
  }

  return {
    uriString: editor.document.uri.toString(),
    version: editor.document.version,
    line: editor.selection.active.line,
    column: editor.selection.active.character,
    selectionRangeKey: buildSelectionRangeKey(editor),
  };
}

function isCursorIdleAnchorStillActive(anchor: CursorIdleAnchor | null) {
  if (!anchor) {
    return false;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== anchor.uriString) {
    return false;
  }

  return editor.document.version === anchor.version
    && editor.selection.active.line === anchor.line
    && editor.selection.active.character === anchor.column
    && buildSelectionRangeKey(editor) === anchor.selectionRangeKey;
}

function countMatches(value: string, pattern: RegExp) {
  return (value.match(pattern) || []).length;
}

function lineIndent(value: string) {
  return value.match(/^\s*/)?.[0] || '';
}

function commentPrefixForLanguage(language: string, filePath: string) {
  const normalized = language.toLowerCase();
  const lowerPath = filePath.toLowerCase();
  if (normalized === 'html' || lowerPath.endsWith('.html') || lowerPath.endsWith('.xml')) {
    return { open: '<!-- ', close: ' -->' };
  }
  if (normalized === 'css' || normalized === 'scss' || lowerPath.endsWith('.css') || lowerPath.endsWith('.scss')) {
    return { open: '/* ', close: ' */' };
  }
  return { open: '// ', close: '' };
}

function normalizeSuggestionForCode(value: string) {
  return truncateInline(value.replace(/\s+/g, ' ').replace(/[.;]\s*$/g, ''), 120);
}

function extractFirstCodeFence(value: string) {
  const match = value.match(/```(?:[A-Za-z0-9_+-]+)?\s*\r?\n([\s\S]*?)```/);
  return match?.[1]?.trimEnd() || '';
}

function buildSuggestedCompletion(snapshot: ActiveEditorSnapshot, suggestion = '', mode: 'insert' | 'replace' = 'insert') {
  const currentLine = snapshot.currentLineText || '';
  const indent = lineIndent(currentLine);
  const nestedIndent = `${indent}  `;
  const normalizedLanguage = snapshot.language.toLowerCase();
  const lowerPath = snapshot.filePath.toLowerCase();
  const cleanSuggestion = normalizeSuggestionForCode(suggestion || `continuar en ${snapshot.fileName}`);
  const currentTrimmed = currentLine.trimEnd();

  if ((normalizedLanguage === 'python' || lowerPath.endsWith('.py')) && currentTrimmed.endsWith(':')) {
    return `${indent}    # TODO: ${cleanSuggestion}\n${indent}    pass`;
  }

  if (
    (normalizedLanguage.includes('javascript') || normalizedLanguage.includes('typescript') || /\.(mjs|cjs|jsx|tsx?)$/i.test(lowerPath))
    && /[{\[]\s*$/.test(currentTrimmed)
  ) {
    return `${nestedIndent}// TODO: ${cleanSuggestion}`;
  }

  if (normalizedLanguage === 'python' || lowerPath.endsWith('.py')) {
    return `${indent}# TODO: ${cleanSuggestion}`;
  }

  const comment = commentPrefixForLanguage(snapshot.language, snapshot.filePath);
  const prefix = mode === 'replace' ? indent : indent;
  return `${prefix}${comment.open}TODO: ${cleanSuggestion}${comment.close}`;
}

function getDocumentEol(document: vscode.TextDocument) {
  return document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

function normalizeCompletionTextForEditor(rawText: string, indent: string, eol: string) {
  const normalized = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
  if (!normalized.trim()) {
    return '';
  }

  const lines = normalized.split('\n');
  const firstCodeLine = lines.find((line) => line.trim().length > 0) || '';
  if (indent && firstCodeLine && !/^\s/.test(firstCodeLine)) {
    return lines.map((line) => line.trim() ? `${indent}${line}` : '').join(eol);
  }

  return lines.join(eol);
}

function buildCompletionFallbackForModel(model: ActiveSuggestionModel, lineText: string) {
  const indent = lineIndent(lineText);
  const comment = commentPrefixForLanguage(model.language, model.filePath);
  const suggestion = normalizeSuggestionForCode(
    model.suggestions[0] || model.nextSteps[0] || `continuar en ${model.fileName}`,
  );
  return `${indent}${comment.open}TODO: ${suggestion}${comment.close}`;
}

function normalizeActionProbe(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // "insert_after_line" -> "insert after line": sin esto \b no separa
    // "insert" de "_after" y la accion se aplicaba como reemplazo.
    .replace(/[_-]+/g, ' ');
}

function actionModeFromText(value: string): SuggestionApplyMode | '' {
  const probe = normalizeActionProbe(value);
  const explicit = probe.match(/\b(?:accion|aplicar|modo|action|apply)\s*:\s*(insert|insertar|add|replace|reemplazar|modificar|update|delete|eliminar|borrar|remove)\b/);
  const token = explicit?.[1] || '';
  if (/^(delete|eliminar|borrar|remove)$/.test(token)) {
    return 'delete';
  }
  if (/^(replace|reemplazar|modificar|update)$/.test(token)) {
    return 'replace';
  }
  if (/^(insert|insertar|add)$/.test(token)) {
    return 'insert';
  }

  if (/\b(elimina|eliminar|borra|borrar|quita|quitar|remueve|remover|retira|retirar|delete|remove)\b/.test(probe)) {
    return 'delete';
  }
  if (/\b(modifica|modificar|reemplaza|reemplazar|cambia|cambiar|actualiza|actualizar|corrige|corregir|refactoriza|refactorizar|replace|update|fix)\b/.test(probe)) {
    return 'replace';
  }
  if (/\b(agrega|agregar|anade|anadir|inserta|insertar|crea|crear|implementa|implementar|add|insert|append)\b/.test(probe)) {
    return 'insert';
  }
  return '';
}

function inferSuggestionApplyMode(snapshot: ActiveEditorSnapshot, suggestionText: string, completionText: string): SuggestionApplyMode {
  const explicitMode = actionModeFromText(`${suggestionText}\n${completionText}`);
  if (explicitMode) {
    return explicitMode;
  }

  return 'insert';
}

function suggestionApplyModeLabel(mode: SuggestionApplyMode) {
  if (mode === 'delete') {
    return 'Eliminar';
  }
  if (mode === 'replace') {
    return 'Modificar';
  }
  return 'Insertar';
}

function actionTypeToApplyMode(actionType: string): SuggestionApplyMode {
  const probe = normalizeActionProbe(actionType);
  if (/\b(delete|remove|eliminar|borrar)\b/.test(probe)) {
    return 'delete';
  }
  if (/\b(insert|append|add|agregar|anadir|insertar)\b/.test(probe)) {
    return 'insert';
  }
  return 'replace';
}

function buildAppliedSuggestionModel(
  model: ActiveSuggestionModel,
  mode: SuggestionApplyMode,
  finalPosition: vscode.Position,
): ActiveSuggestionModel {
  const appliedLine = finalPosition.line + 1;
  const appliedColumn = finalPosition.character + 1;
  const modeLabel = suggestionApplyModeLabel(mode).toLowerCase();
  const appliedMessage = `Ayuda aplicada (${modeLabel}) en la linea ${appliedLine}.`;
  const validationStep = mode === 'delete'
    ? 'Revisa que la eliminacion no haya quitado una condicion o cierre necesario.'
    : 'Ejecuta una validacion corta o revisa el resaltado del editor antes de pedir otra pista.';

  return {
    ...model,
    summary: model.summary || appliedMessage,
    lineSummary: appliedMessage,
    suggestions: uniqueCompactStrings([
      appliedMessage,
      ...model.suggestions,
    ], 5),
    lineSuggestions: uniqueCompactStrings([
      validationStep,
      ...model.lineSuggestions,
    ], 3),
    nextSteps: uniqueCompactStrings([
      validationStep,
      'Si el resultado no encaja, usa Deshacer y actualiza la sugerencia.',
      ...model.nextSteps,
    ], 4),
    updatedAt: new Date().toISOString(),
    line: appliedLine,
    column: appliedColumn,
    completionText: '',
    actionsVisible: false,
    loading: false,
    applied: true,
    appliedMode: mode,
  };
}

function getSelectedFullLineRange(editor: vscode.TextEditor) {
  const selection = editor.selection;
  const startLine = Math.max(0, Math.min(selection.start.line, editor.document.lineCount - 1));
  let endLine = Math.max(0, Math.min(selection.end.line, editor.document.lineCount - 1));
  if (!selection.isEmpty && selection.end.character === 0 && endLine > startLine) {
    endLine -= 1;
  }

  return new vscode.Range(
    new vscode.Position(startLine, 0),
    editor.document.lineAt(endLine).range.end,
  );
}

function getSelectedFullLineRangeIncludingBreak(editor: vscode.TextEditor) {
  const range = getSelectedFullLineRange(editor);
  if (range.end.line < editor.document.lineCount - 1) {
    return new vscode.Range(range.start, new vscode.Position(range.end.line + 1, 0));
  }
  return range;
}

function getSuggestionDeleteRange(editor: vscode.TextEditor, modelLineIndex: number) {
  if (!editor.selection.isEmpty) {
    return getSelectedFullLineRangeIncludingBreak(editor);
  }
  return editor.document.lineAt(modelLineIndex).rangeIncludingLineBreak;
}

type SuggestionEditPlan =
  | { ok: false; message: string }
  | {
    ok: true;
    mode: SuggestionApplyMode;
    /** Operacion real sobre el documento (insertar en una linea vacia es un replace). */
    operation: 'delete' | 'replace' | 'insert';
    /** Rango afectado; al insertar, rango vacio en el punto de insercion. */
    range: vscode.Range;
    /** Texto que se escribe tal cual (con el salto de linea previo al insertar). */
    text: string;
    /** Texto que desaparece del archivo. */
    removedText: string;
    /** Codigo propuesto por el tutor, sin el salto de linea previo. */
    proposedText: string;
    /** Codigo de contexto para el quiz tras aceptar. */
    quizOriginalCode: string;
  };

/**
 * Calcula que cambio hace "aplicar sugerencia" en el editor, sin tocarlo.
 * Es la misma logica de siempre, separada para poder medir el cambio y
 * pasarlo por el guard de aplicacion antes de editar.
 */
function planSuggestionEdit(
  editor: vscode.TextEditor,
  model: ActiveSuggestionModel,
  mode: SuggestionApplyMode,
): SuggestionEditPlan {
  const document = editor.document;
  const modelLineIndex = Math.max(
    0,
    Math.min(document.lineCount - 1, (Number(model.line) || editor.selection.active.line + 1) - 1),
  );
  const targetLine = document.lineAt(modelLineIndex);
  const eol = getDocumentEol(document);

  if (mode === 'delete') {
    const range = getSuggestionDeleteRange(editor, modelLineIndex);
    const deletedText = document.getText(range);
    if (!deletedText.trim()) {
      return { ok: false, message: 'ADACEEN: no hay codigo seleccionado o linea con contenido para eliminar.' };
    }
    return {
      ok: true,
      mode,
      operation: 'delete',
      range,
      text: '',
      removedText: deletedText,
      proposedText: '',
      quizOriginalCode: deletedText,
    };
  }

  const rawCompletion = model.completionText || buildCompletionFallbackForModel(model, targetLine.text);
  const completionText = normalizeCompletionTextForEditor(rawCompletion, lineIndent(targetLine.text), eol);
  if (!completionText.trim()) {
    return { ok: false, message: 'ADACEEN: la sugerencia no trae codigo aplicable.' };
  }

  if (mode === 'replace') {
    const range = editor.selection.isEmpty
      ? new vscode.Range(new vscode.Position(modelLineIndex, 0), targetLine.range.end)
      : getSelectedFullLineRange(editor);
    const originalCode = document.getText(range);
    return {
      ok: true,
      mode,
      operation: 'replace',
      range,
      text: completionText,
      removedText: originalCode,
      proposedText: completionText,
      quizOriginalCode: originalCode,
    };
  }

  const insertLineIndex = editor.selection.isEmpty
    ? modelLineIndex
    : Math.min(document.lineCount - 1, getSelectedFullLineRange(editor).end.line);
  const insertLine = document.lineAt(insertLineIndex);
  const quizOriginalCode = editor.selection.isEmpty
    ? insertLine.text
    : document.getText(getSelectedFullLineRange(editor));
  if (editor.selection.isEmpty && !insertLine.text.trim()) {
    const range = new vscode.Range(new vscode.Position(insertLineIndex, 0), insertLine.range.end);
    return {
      ok: true,
      mode,
      operation: 'replace',
      range,
      text: completionText,
      removedText: document.getText(range),
      proposedText: completionText,
      quizOriginalCode,
    };
  }

  const insertPosition = insertLine.range.end;
  return {
    ok: true,
    mode,
    operation: 'insert',
    range: new vscode.Range(insertPosition, insertPosition),
    text: `${eol}${completionText}`,
    removedText: '',
    proposedText: completionText,
    quizOriginalCode,
  };
}

function splitRelativePath(value: string) {
  const clean = value.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = clean.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.')) {
    return [];
  }
  return parts;
}

async function uriExists(uri: vscode.Uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function resolveWorkspaceFileUri(filePath: string): Promise<vscode.Uri | null> {
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  const parts = splitRelativePath(filePath);
  if (!workspaceFolders.length || !parts.length) {
    return null;
  }

  for (const folder of workspaceFolders) {
    const candidates: string[][] = [parts];
    if (parts[0] === folder.name && parts.length > 1) {
      candidates.push(parts.slice(1));
    }

    for (const candidate of candidates) {
      const uri = vscode.Uri.joinPath(folder.uri, ...candidate);
      if (await uriExists(uri)) {
        return uri;
      }
    }
  }

  return null;
}

function rangeForFirstTextMatch(document: vscode.TextDocument, needle: string): vscode.Range | null {
  if (!needle) {
    return null;
  }
  const index = document.getText().indexOf(needle);
  if (index < 0) {
    return null;
  }
  const start = document.positionAt(index);
  const end = document.positionAt(index + needle.length);
  return new vscode.Range(start, end);
}

function metadataLineNumber(metadata: Record<string, unknown>) {
  const value = metadata.line;
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function rangeForCodeActionFallback(editor: vscode.TextEditor, action: PendingCodeAction): vscode.Range {
  const document = editor.document;
  const lineFromMetadata = metadataLineNumber(action.metadata);
  const actionType = action.actionType.toLowerCase();
  if (lineFromMetadata > 0 || actionType.includes('line')) {
    const lineIndex = Math.max(0, Math.min(document.lineCount - 1, (lineFromMetadata || editor.selection.active.line + 1) - 1));
    return document.lineAt(lineIndex).range;
  }

  if (!editor.selection.isEmpty) {
    return getSelectedFullLineRange(editor);
  }

  const activeLine = Math.max(0, Math.min(document.lineCount - 1, editor.selection.active.line));
  return document.lineAt(activeLine).range;
}

/** La aplicacion no se hizo por decision del guard (politica, regla offline o cancelacion). */
class CodeApplicationBlockedError extends Error {
  constructor(message: string, readonly verdict: CodeApplicationVerdict) {
    super(message);
    this.name = 'CodeApplicationBlockedError';
  }
}

/** POST /api/suggestions/apply-check. Lanza ante red caida, HTTP no 2xx o tiempo agotado. */
async function requestApplyCheck(request: ApplyCheckRequest): Promise<unknown> {
  const settings = resolveBackendSettings();
  if (!settings.baseUrl) {
    throw new Error('sin backend configurado (adaceen.backend.baseUrl)');
  }
  return fetchJsonWithTimeout(
    `${settings.baseUrl}/api/suggestions/apply-check`,
    {
      method: 'POST',
      headers: buildSessionHeaders(settings, true),
      body: JSON.stringify(request),
    },
    APPLY_CHECK_TIMEOUT_MS,
  );
}

/** Dependencias reales (VS Code + backend + telemetria) del guard de aplicacion de codigo. */
function createCodeApplicationGuardDeps(
  telemetry: TelemetryClient,
  output: vscode.OutputChannel,
): CodeApplicationGuardDeps {
  return {
    // Indicador discreto en la barra de estado mientras responde el backend.
    requestApplyCheck: (request) => Promise.resolve(vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'ADACEEN: comprobando si se puede aplicar el cambio' },
      () => requestApplyCheck(request),
    )),
    confirm: async (message, detail) => {
      const accept = 'Aplicar';
      const answer = await vscode.window.showInformationMessage(message, { modal: true, detail }, accept);
      return answer === accept;
    },
    notify: (message) => {
      void vscode.window.showInformationMessage(message);
    },
    track: (event: TelemetryEventInput) => {
      telemetry.track({
        pageContext: editorPageContext(),
        branch: detectBranchName(),
        ...event,
      });
    },
    offlineMaxLines: () => resolveCodeApplicationSettings().offlineMaxLines,
    log: (line) => output.appendLine(line),
  };
}

async function applyPendingCodeAction(
  action: PendingCodeAction,
  settings: BackendSettings,
  output: vscode.OutputChannel,
  guardDeps: CodeApplicationGuardDeps,
) {
  const uri = await resolveWorkspaceFileUri(action.filePath);
  if (!uri) {
    throw new Error(`No se encontro el archivo ${action.filePath} en el workspace abierto.`);
  }

  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  const label = truncateInline(action.title || 'Reemplazo sugerido', 80);
  const applyMode = actionTypeToApplyMode(action.actionType);
  const planRange = () => {
    const directMatch = applyMode === 'insert' ? null : rangeForFirstTextMatch(editor.document, action.originalText);
    return { directMatch, target: directMatch || rangeForCodeActionFallback(editor, action) };
  };

  // Guard de aplicacion (A10.8): los reemplazos del navegador tambien pasan por apply-check.
  const measured = planRange();
  const verdict = await guardCodeApplication({
    decisionId: toOptionalString(action.metadata.decisionId) || toOptionalString(action.metadata.decision_id),
    filePath: action.filePath,
    language: inferActiveLanguage(action.filePath, editor.document.languageId),
    applyMode,
    originalText: applyMode === 'insert' ? '' : editor.document.getText(measured.target),
    newText: applyMode === 'delete' ? '' : action.replacementText,
    trigger: toOptionalString(action.metadata.trigger) || 'browser_code_action',
    origin: 'browser_code_action',
    fileLabel: pathBaseName(action.filePath),
    repoFullName: action.repoFullName,
  }, guardDeps);
  if (!verdict.allowed) {
    throw new CodeApplicationBlockedError(
      verdict.cancelled
        ? 'Reemplazo omitido por el usuario en VS Code.'
        : `Aplicacion bloqueada (${verdict.reasonCode}): ${verdict.reason}`,
      verdict,
    );
  }

  if (!verdict.confirmed && !settings.autoApplyCodeActions) {
    const answer = await vscode.window.showInformationMessage(
      `ADACEEN: ${label}`,
      { modal: false },
      DEFAULT_CODE_ACTION_CONFIRM_LABEL,
      'Omitir',
    );
    if (answer !== DEFAULT_CODE_ACTION_CONFIRM_LABEL) {
      throw new Error('Reemplazo omitido por el usuario en VS Code.');
    }
  }

  // El rango se calcula justo antes de editar, como antes (la confirmacion pudo tardar).
  const { directMatch: directRange, target: range } = planRange();
  const eol = getDocumentEol(editor.document);
  let editStart = range.start;
  let appliedTextLength = action.replacementText.length;
  const applied = await editor.edit((editBuilder) => {
    if (applyMode === 'delete') {
      appliedTextLength = 0;
      editBuilder.delete(range);
      return;
    }

    if (applyMode === 'insert') {
      const selectionEndLine = Number(action.metadata.selectionEndLine) || 0;
      const anchorLine = selectionEndLine > 0
        ? Math.min(document.lineCount - 1, selectionEndLine - 1)
        : range.end.line;
      const line = document.lineAt(anchorLine);
      const insertPosition = line.range.end;
      const prefix = line.text.trim() ? eol : '';
      const insertedText = `${prefix}${action.replacementText}`;
      editStart = insertPosition;
      appliedTextLength = insertedText.length;
      editBuilder.insert(insertPosition, insertedText);
      return;
    }

    editBuilder.replace(range, action.replacementText);
  });
  if (!applied) {
    throw new Error(`No se pudo aplicar el cambio en ${action.filePath}.`);
  }

  const finalOffset = editor.document.offsetAt(editStart) + appliedTextLength;
  const finalPosition = editor.document.positionAt(finalOffset);
  editor.selection = new vscode.Selection(finalPosition, finalPosition);
  output.appendLine(`[CodeActions] Cambio aplicado: ${action.filePath} (${action.id}, ${applyMode}).`);

  return {
    filePath: action.filePath,
    replacedByMatch: !!directRange,
    line: range.start.line + 1,
    character: range.start.character + 1,
    appliedAt: new Date().toISOString(),
    linesChanged: verdict.linesChanged,
    charsChanged: verdict.charsChanged,
    applyCheck: verdict.offline ? 'offline' : 'server',
    ...(verdict.decisionId ? { decisionId: verdict.decisionId } : {}),
  };
}

async function processNextCodeActionForRepo(
  settings: BackendSettings,
  repoFullName: string,
  output: vscode.OutputChannel,
  guardDeps: CodeApplicationGuardDeps,
  manual = false,
) {
  if (!settings.sessionId) {
    if (manual) {
      vscode.window.showWarningMessage(
        'ADACEEN: configura adaceen.backend.sessionId para sincronizar reemplazos con el navegador.',
      );
    }
    return false;
  }

  if (!settings.codeActionsEnabled) {
    if (manual) {
      vscode.window.showInformationMessage('ADACEEN: la cola de reemplazos del navegador esta desactivada.');
    }
    return false;
  }

  const action = await claimNextCodeAction(settings, repoFullName);
  if (!action) {
    if (manual) {
      vscode.window.showInformationMessage(`ADACEEN: no hay reemplazos pendientes para ${repoFullName}.`);
    }
    return false;
  }

  try {
    output.appendLine(`[CodeActions] Reemplazo reclamado: ${action.id} | ${action.filePath}.`);
    const metadata = await applyPendingCodeAction(action, settings, output, guardDeps);
    await completeCodeAction(settings, action.id, {
      ...action.metadata,
      ...metadata,
      workerId: settings.workerId,
    });
    if (manual) {
      vscode.window.showInformationMessage(`ADACEEN: reemplazo aplicado en ${action.filePath}.`);
    }
  } catch (error) {
    const blockedByGuard = error instanceof CodeApplicationBlockedError;
    const message = blockedByGuard ? error.message : String(error);
    output.appendLine(`[CodeActions] No se pudo aplicar ${action.id}: ${message}`);
    await failCodeAction(settings, action.id, message).catch((failError) => {
      output.appendLine(`[CodeActions] No se pudo reportar fallo ${action.id}: ${String(failError)}`);
    });
    // Si lo freno el guard, el estudiante ya vio el motivo (o cancelo el mismo).
    if (manual && !blockedByGuard) {
      vscode.window.showWarningMessage(`ADACEEN: ${message}`);
    }
  }

  return true;
}

function buildSelectionSpecificGuidance(snapshot: ActiveEditorSnapshot) {
  const selected = snapshot.selectionText.trim();
  if (!selected) {
    return '';
  }

  const lowerPath = snapshot.filePath.toLowerCase();
  const language = snapshot.language.toLowerCase();
  if (/export\s+const\s+metadata\b|metadata\s*:\s*metadata\b/i.test(selected)) {
    return 'La seleccion define metadata exportada; revisa que title, description y generator describan exactamente esta pantalla antes de tocar el layout.';
  }
  if (/^import\s.+from\s+['"]/m.test(selected) || selected.split(/\r?\n/).every((line) => /^\s*import\b/.test(line) || !line.trim())) {
    return 'La seleccion contiene imports; valida cuales se usan realmente y evita cambiar dependencias sin confirmar referencias en el archivo.';
  }
  if (/\bfunction\s+\w+|=>\s*[{(]|return\s*\(/.test(selected)) {
    return 'La seleccion contiene logica ejecutable; identifica entradas, estado usado y salida renderizada antes de modificar el bloque.';
  }
  if (/<[A-Z][A-Za-z0-9]*|className=|children\b/.test(selected)) {
    return 'La seleccion contiene JSX; revisa jerarquia, props y clases aplicadas antes de insertar o reemplazar UI.';
  }
  if (language.includes('typescript') || /\.(tsx?|jsx?)$/i.test(lowerPath)) {
    return 'La seleccion es codigo de TypeScript/React; valida tipos, imports y efecto en render antes de cambiarla.';
  }
  if (selected.length <= 280) {
    return `La seleccion concreta es: ${truncateInline(selected.replace(/\s+/g, ' '), 220)}.`;
  }
  return 'ADACEEN ya capturo el bloque seleccionado; enfoca la ayuda en ese recorte y no en el archivo completo.';
}

function buildLocalActiveSuggestion(
  snapshot: ActiveEditorSnapshot,
  projectIndex: WorkspaceProjectIndex | null = null,
): ActiveSuggestionModel {
  const code = snapshot.content;
  const lowerPath = snapshot.filePath.toLowerCase();
  const language = snapshot.language.toLowerCase();
  const suggestions: string[] = [];
  const nextSteps: string[] = [];
  const fileOverview = buildLocalFileOverview(snapshot, projectIndex);
  const hasSelection = !!snapshot.selectionText.trim();
  const selectionLimitNote = snapshot.selectionTruncated
    ? ` La seleccion original tenia ${snapshot.selectionOriginalLineCount} lineas; ADACEEN analizo las primeras ${snapshot.selectionLineCount} lineas.`
    : '';
  const selectionSpecificGuidance = buildSelectionSpecificGuidance(snapshot);

  if (hasSelection) {
    if (selectionSpecificGuidance) {
      suggestions.push(selectionSpecificGuidance);
    }
    suggestions.push(
      `Analiza el bloque seleccionado completo (${snapshot.selectionLineCount} linea(s), ${snapshot.selectionStartLine}-${snapshot.selectionEndLine}) antes de proponer cambios.${selectionLimitNote}`,
    );
    nextSteps.push('Trabaja sobre la seleccion como unidad: identifica entrada, efecto y salida del bloque antes de editar.');
  } else if (snapshot.currentLineText.trim()) {
    suggestions.push(`El cursor quedo en la linea ${snapshot.line}; revisa ese punto como posible bloqueo antes de cambiar mas codigo.`);
    nextSteps.push(`Trabaja desde la linea ${snapshot.line}: completa una intencion pequena y valida el resultado.`);
  }

  if (/\b(TODO|FIXME)\b/i.test(code)) {
    const todoCount = countMatches(code, /\b(TODO|FIXME)\b/gi);
    suggestions.push(`Hay ${todoCount} marcador(es) TODO/FIXME; conviertelos en pasos pequenos y verificables.`);
  }

  if (language === 'python' || lowerPath.endsWith('.py')) {
    if (/except\s+Exception\s*:\s*\n\s*pass\b/i.test(code) || /except\s*:\s*\n\s*pass\b/i.test(code)) {
      suggestions.push('Hay un bloque que silencia excepciones con pass; agrega al menos un comentario, log o condicion para no ocultar errores reales.');
    }
    if (/\bclass\s+\w+/.test(code) && !/\bdef\s+__repr__\b/.test(code)) {
      suggestions.push('Si esta clase representa datos del dominio, considera un __repr__ breve para depurar mejor en terminal.');
    }
    if (/urlpatterns\s*=/.test(code)) {
      suggestions.push('Archivo de rutas detectado: verifica que cada vista tenga nombre claro y que el flujo principal este cubierto.');
    }
    if (lowerPath.endsWith('manage.py')) {
      suggestions.push('Este parece el punto de entrada Django; valida settings, migraciones y comando de arranque antes de cambiar logica.');
    }
    if (lowerPath.endsWith('sitecustomize.py')) {
      suggestions.push('Este archivo parchea compatibilidad del entorno; mantenlo minimo y evita que esconda fallos de dependencias.');
    }
  }

  if (language.includes('javascript') || language.includes('typescript') || /\.(mjs|cjs|jsx|tsx?)$/i.test(lowerPath)) {
    if (/\bany\b/.test(code) && language.includes('typescript')) {
      suggestions.push('Hay tipos any visibles; reemplaza uno por un tipo concreto donde mas reduzca incertidumbre.');
    }
    if (/\bfetch\s*\(/.test(code) && !/catch\s*\(/.test(code)) {
      suggestions.push('Hay llamadas fetch; confirma manejo de error y estado de carga para evitar fallos silenciosos.');
    }
    if (/\buseEffect\s*\(/.test(code)) {
      suggestions.push('Revisa dependencias de useEffect y separa efectos de datos, eventos y render cuando sea posible.');
    }
  }

  if (/requirements\.txt$|pyproject\.toml$|package\.json$/i.test(lowerPath)) {
    suggestions.push('Archivo de dependencias detectado: compara versiones, scripts de arranque y librerias realmente usadas.');
    nextSteps.push('Ejecuta el comando minimo de instalacion o arranque y observa el primer error concreto.');
  }

  if (/(^|\/)(test|tests|__tests__|spec|specs)\//i.test(lowerPath) || /\.(test|spec)\./i.test(lowerPath)) {
    suggestions.push('Estas en pruebas: agrega un caso pequeno que falle primero y luego corrige la implementacion.');
  } else if (/\b(function|def|class|public\s+\w+|private\s+\w+)\b/.test(code) && !/\b(describe\(|it\(|pytest|unittest|assert\s|@Test)\b/i.test(code)) {
    suggestions.push('No se ven pruebas cerca; agrega una verificacion minima para proteger el siguiente cambio.');
  }

  const functionCount = countMatches(code, /\b(function|def|public\s+\w+|private\s+\w+)\b/g);
  if (functionCount >= 12 || snapshot.lineCount >= 350) {
    suggestions.push('El archivo se ve cargado; busca una funcion pequena que puedas extraer o probar sin reestructurar todo.');
  }

  if (suggestions.length === 0) {
    suggestions.push(`Trabaja sobre ${snapshot.fileName}: identifica entrada, estado que cambia y salida antes del siguiente cambio.`);
  }
  if (nextSteps.length === 0) {
    nextSteps.push('Haz un cambio pequeno, ejecuta una validacion corta y vuelve a leer el resultado.');
    nextSteps.push('Si aparece error, copia la primera linea util y enfoca la siguiente pista alli.');
  }

  const chips = uniqueCompactStrings([
    snapshot.repoFullName ? `repo ${snapshot.repoFullName}` : snapshot.workspaceName || 'workspace',
    snapshot.language,
    `${snapshot.lineCount} lineas`,
    hasSelection
      ? `seleccion ${snapshot.selectionLineCount}${snapshot.selectionTruncated ? `/${snapshot.selectionOriginalLineCount}` : ''} lineas`
      : `cursor linea ${snapshot.line}`,
    isCodespaceRuntime() ? 'Codespaces' : 'VS Code',
  ], 5);
  const compactSuggestions = uniqueCompactStrings(suggestions, 4);
  const focusLine = hasSelection ? snapshot.selectionStartLine : snapshot.line;
  const focusColumn = hasSelection ? 1 : snapshot.column;
  const completionText = buildSuggestedCompletion(snapshot, compactSuggestions[0] || nextSteps[0] || '');
  const applyMode = inferSuggestionApplyMode(
    snapshot,
    `${compactSuggestions.join('\n')}\n${nextSteps.join('\n')}`,
    completionText,
  );

  return {
    uriString: snapshot.uriString,
    filePath: snapshot.filePath,
    fileName: snapshot.fileName,
    language: snapshot.language,
    repoFullName: snapshot.repoFullName,
    title: `Sugerencias para ${snapshot.fileName}`,
    summary: fileOverview || `Archivo activo: ${snapshot.filePath} (${snapshot.language}, linea ${snapshot.line}).`,
    fileOverview,
    lineSummary: hasSelection
      ? `Foco actual: seleccion lineas ${snapshot.selectionStartLine}-${snapshot.selectionEndLine} (${snapshot.selectionLineCount} linea(s) analizadas${snapshot.selectionTruncated ? ` de ${snapshot.selectionOriginalLineCount}` : ''}).`
      : snapshot.currentLineText.trim()
        ? `Foco actual: linea ${snapshot.line}.`
      : '',
    suggestions: compactSuggestions,
    fileSuggestions: compactSuggestions,
    lineSuggestions: snapshot.currentLineText.trim() ? compactSuggestions.slice(0, 2) : [],
    nextSteps: uniqueCompactStrings(nextSteps, 3),
    chips,
    source: 'local',
    backendError: '',
    ragSources: [],
    ragCourseCode: '',
    updatedAt: new Date().toISOString(),
    line: focusLine,
    column: focusColumn,
    selectionLineCount: snapshot.selectionLineCount,
    selectionOriginalLineCount: snapshot.selectionOriginalLineCount,
    selectionTruncated: snapshot.selectionTruncated,
    selectionRangeKey: snapshot.selectionRangeKey,
    fileSummaryCacheKey: snapshot.fileSummaryCacheKey,
    metricId: stableStringHash([
      snapshot.cacheKey,
      fileOverview,
      compactSuggestions.join('\n'),
      'local',
    ].join('\n---adaceen-metric---\n')),
    completionText,
    applyMode,
    triggerKind: 'cursor',
    actionsVisible: false,
  };
}

function formatDiagnosticsForPrompt(diagnostics: SuggestDiagnostic[], max = 5) {
  if (!diagnostics.length) {
    return '';
  }
  return [
    'Errores y avisos del editor en este archivo:',
    ...diagnostics.slice(0, max).map((item) => `- Linea ${item.line} (${item.severity === 'error' ? 'error' : 'aviso'}): ${item.message}`),
  ].join('\n');
}

function buildBackendSuggestionContent(
  snapshot: ActiveEditorSnapshot,
  projectIndex: WorkspaceProjectIndex | null = null,
  scope: BackendSuggestionRequestScope = 'file_summary',
  trigger?: SuggestionTrigger,
) {
  const isFileSummary = scope === 'file_summary';
  const blockingFocus = scope === 'cursor' && trigger === 'blocking';
  const selectionBlock = !isFileSummary && snapshot.selectionText.trim()
    ? [
      `Bloque seleccionado por el usuario: lineas ${snapshot.selectionStartLine}-${snapshot.selectionEndLine}`,
      `Lineas analizadas de la seleccion: ${snapshot.selectionLineCount}${snapshot.selectionTruncated ? ` de ${snapshot.selectionOriginalLineCount}` : ''}`,
      snapshot.selectionTruncated
        ? `Aviso: la seleccion supero el limite de ${ACTIVE_SUGGESTION_SELECTION_MAX_LINES} lineas; analiza solo este recorte inicial y menciona esa limitacion si afecta la respuesta.`
        : '',
      'El foco principal es todo este bloque seleccionado, no solamente la linea del cursor.',
      snapshot.selectionText.slice(0, ACTIVE_SUGGESTION_PROMPT_SELECTION_CHARS),
    ].filter(Boolean).join('\n')
    : '';

  return [
    `Repositorio: ${snapshot.repoFullName || '(sin repo detectado)'}`,
    `Workspace: ${snapshot.workspaceName || '(sin workspace)'}`,
    `Archivo activo: ${snapshot.filePath}`,
    `Lenguaje: ${snapshot.language}`,
    isFileSummary ? '' : `Cursor: linea ${snapshot.line}, columna ${snapshot.column}`,
    blockingFocus
      ? 'Disparador: bloqueo detectado; el mismo error del editor sigue presente o se repite.'
      : scope === 'cursor' ? 'Disparador: cursor quieto durante 3 segundos; posible bloqueo del estudiante.' : '',
    blockingFocus ? formatDiagnosticsForPrompt(snapshot.diagnostics.items) : '',
    selectionBlock,
    `Lineas del archivo: ${snapshot.lineCount}`,
    !isFileSummary && snapshot.currentLineText ? `Linea actual:\n${snapshot.currentLineText}` : '',
    !isFileSummary && snapshot.visibleText ? `Texto visible del editor:\n${snapshot.visibleText.slice(0, ACTIVE_SUGGESTION_PROMPT_VISIBLE_CHARS)}` : '',
    `Codigo del archivo activo (recorte local):\n${snapshot.content.slice(0, ACTIVE_SUGGESTION_PROMPT_CODE_CHARS)}`,
    formatWorkspaceProjectIndexForPrompt(projectIndex, snapshot.filePath),
  ].filter(Boolean).join('\n\n');
}

function buildBackendSuggestionQuestion(
  snapshot: ActiveEditorSnapshot,
  scope: BackendSuggestionRequestScope,
  trigger?: SuggestionTrigger,
) {
  if (scope === 'file_summary') {
    return [
      'Describe en 1 a 3 bullets que hace el archivo activo y cual parece ser su papel dentro del proyecto usando el mapa local del workspace.',
      'Despues da 3 sugerencias breves y accionables para continuar en ese archivo.',
      'No des la solucion completa ni inventes datos que no esten en el contexto.',
    ].join(' ');
  }

  const visibleError = snapshot.diagnostics.firstError;
  if (trigger === 'blocking' && visibleError) {
    return [
      `El estudiante lleva un rato bloqueado con este error del editor en la linea ${visibleError.line}: "${truncateInline(visibleError.message, 300)}".`,
      'Explica en 1 bullet la causa probable con palabras sencillas y da 2 pistas breves para que lo corrija por su cuenta.',
      'Al final, si es seguro, incluye un unico bloque de codigo corto que ayude a corregirlo. Si no es seguro, usa un comentario TODO del lenguaje.',
      'Incluye una linea "Aplicar: insert", "Aplicar: replace" o "Aplicar: delete" segun corresponda; usa delete solo si la mejor ayuda es eliminar codigo.',
      'No des la solucion completa ni inventes datos que no esten en el contexto.',
    ].join(' ');
  }

  if (snapshot.selectionText.trim()) {
    return [
      `El estudiante selecciono un bloque del editor; analiza la seleccion completa recibida, con limite maximo de ${ACTIVE_SUGGESTION_SELECTION_MAX_LINES} lineas, como foco principal.`,
      'No reduzcas el analisis a la linea del cursor si hay varias lineas seleccionadas.',
      'Describe en 1 bullet que parece estar intentando hacer el bloque seleccionado y da 2 sugerencias breves para continuar desde esa seleccion.',
      'Al final, si es seguro, incluye un unico bloque de codigo corto para continuar. Si no es seguro, usa un comentario TODO del lenguaje.',
      'Incluye una linea "Aplicar: insert", "Aplicar: replace" o "Aplicar: delete" segun corresponda; usa delete solo si la mejor ayuda es eliminar codigo.',
      'No des la solucion completa ni inventes datos que no esten en el contexto.',
    ].join(' ');
  }

  return [
    'El cursor quedo quieto 3 segundos en la linea indicada; interpreta esto como posible bloqueo del estudiante.',
    'Describe en 1 bullet que parece estar intentando hacer y da 2 sugerencias breves para continuar desde esa linea.',
    'Al final, si es seguro, incluye un unico bloque de codigo corto para continuar. Si no es seguro, usa un comentario TODO del lenguaje.',
    'Incluye una linea "Aplicar: insert", "Aplicar: replace" o "Aplicar: delete" segun corresponda; usa delete solo si la mejor ayuda es eliminar codigo.',
    'No des la solucion completa ni inventes datos que no esten en el contexto.',
  ].join(' ');
}

async function fetchBackendSuggestionText(
  settings: ActiveSuggestionSettings,
  snapshot: ActiveEditorSnapshot,
  projectIndex: WorkspaceProjectIndex | null = null,
  scope: BackendSuggestionRequestScope,
  requestContext: BackendSuggestionRequestContext,
): Promise<BackendSuggestionResult> {
  const backend = resolveBackendSettings();
  if (!backend.baseUrl) {
    return createEmptyBackendSuggestionResult();
  }

  const visibleError = snapshot.diagnostics.firstError?.message || '';
  const startedAt = Date.now();
  const response = await fetchJsonWithTimeout(
    `${backend.baseUrl}/suggest-tab`,
    {
      method: 'POST',
      headers: buildSessionHeaders(backend, true),
      body: JSON.stringify({
        tab_content: buildBackendSuggestionContent(snapshot, projectIndex, scope, requestContext.trigger),
        question: buildBackendSuggestionQuestion(snapshot, scope, requestContext.trigger),
        tab_title: snapshot.filePath,
        tab_url: `vscode://${snapshot.repoFullName || snapshot.workspaceName || 'workspace'}/${snapshot.filePath}`,
        suggestion_scope: scope,
        repoFullName: snapshot.repoFullName,
        filePath: snapshot.filePath,
        languageHint: snapshot.language,
        selection: snapshot.selectionText,
        selectionStartLine: snapshot.selectionStartLine,
        selectionEndLine: snapshot.selectionEndLine,
        selectionLineCount: snapshot.selectionLineCount,
        selectionOriginalLineCount: snapshot.selectionOriginalLineCount,
        selectionTruncated: snapshot.selectionTruncated,
        selectionMaxLines: ACTIVE_SUGGESTION_SELECTION_MAX_LINES,
        cursorLine: snapshot.line,
        cursorColumn: snapshot.column,
        currentLineText: snapshot.currentLineText,
        courseCode: settings.ragCourseCode,
        ragCourseCode: settings.ragCourseCode,
        // Contrato v1.1 (A9.10): origen real de la peticion y errores del editor.
        trigger: requestContext.trigger,
        ...(visibleError ? { visibleError: visibleError.slice(0, 2000) } : {}),
        ...(snapshot.diagnostics.items.length ? { diagnostics: snapshot.diagnostics.items } : {}),
        clientSessionId: requestContext.clientSessionId,
      }),
    },
    settings.backendTimeoutMs,
  );

  return normalizeBackendSuggestionResult(response, Date.now() - startedAt);
}

const DEFAULT_BLOCKED_TUTOR_MESSAGE =
  'Tu docente configuró que en este momento el tutor responda sin código. Intenta el siguiente paso por tu cuenta y vuelve a pedir ayuda si sigues con dudas.';

/**
 * Respuesta bloqueada por la politica del docente (blocked=true): el
 * output_text es un mensaje controlado en Markdown y no se ofrece aplicar
 * codigo (completionText vacio, blocked=true).
 */
function buildBlockedSuggestionModel(
  snapshot: ActiveEditorSnapshot,
  projectIndex: WorkspaceProjectIndex | null,
  scope: BackendSuggestionScope,
  blockedResult: BackendSuggestionResult,
  otherResult: BackendSuggestionResult,
  backendError: string,
  trigger?: SuggestionTrigger,
): ActiveSuggestionModel {
  const localFallback = buildLocalActiveSuggestion(snapshot, projectIndex);
  const message = blockedResult.outputText.trim()
    || blockedResult.policyApplied?.reason
    || DEFAULT_BLOCKED_TUTOR_MESSAGE;
  const sections = parseBackendSuggestionSections(message);
  const lines = uniqueCompactStrings(sections.all.length ? sections.all : [message.replace(/\s+/g, ' ')], 5);
  const headline = truncateInline(lines[0] || 'Mensaje del tutor', 260);
  const otherSections = otherResult.outputText && !otherResult.blocked
    ? parseBackendSuggestionSections(otherResult.outputText)
    : null;
  const otherLines = otherSections
    ? (otherSections.sugerencias.length ? otherSections.sugerencias : otherSections.all)
    : [];
  const fileOverview = otherSections?.resumen.length
    ? truncateInline(otherSections.resumen.join(' '), 420)
    : localFallback.fileOverview;
  const ragCourseCode = blockedResult.ragCourseCode || otherResult.ragCourseCode;
  return {
    ...localFallback,
    title: `ADACEEN en ${snapshot.fileName}`,
    summary: headline,
    fileOverview,
    lineSummary: scope === 'cursor' ? headline : '',
    suggestions: lines,
    fileSuggestions: scope === 'cursor'
      ? uniqueCompactStrings(otherLines.length ? otherLines : localFallback.fileSuggestions, 4)
      : lines.slice(0, 4),
    lineSuggestions: scope === 'cursor' ? lines.slice(0, 3) : [],
    nextSteps: lines.slice(1, 4).length ? lines.slice(1, 4) : localFallback.nextSteps,
    source: 'backend',
    backendError: backendError ? truncateInline(backendError, 180) : '',
    ragSources: blockedResult.ragSources.length ? blockedResult.ragSources : otherResult.ragSources,
    ragCourseCode,
    updatedAt: new Date().toISOString(),
    metricId: stableStringHash([
      snapshot.cacheKey,
      scope,
      'blocked',
      message,
      blockedResult.decisionId,
      ragCourseCode,
    ].join('\n---adaceen-metric---\n')),
    completionText: '',
    triggerKind: scope === 'cursor' ? 'cursor' : 'file',
    actionsVisible: false,
    decisionId: blockedResult.decisionId || undefined,
    policyApplied: blockedResult.policyApplied,
    codeApplication: blockedResult.codeApplication,
    blocked: true,
    tutorMessage: message,
    trigger,
  };
}

function buildBackendActiveSuggestionModel(
  snapshot: ActiveEditorSnapshot,
  projectIndex: WorkspaceProjectIndex | null,
  scope: BackendSuggestionScope,
  focusResult: BackendSuggestionResult,
  fileSummaryResult: BackendSuggestionResult = createEmptyBackendSuggestionResult(),
  backendError = '',
  trigger?: SuggestionTrigger,
): ActiveSuggestionModel | null {
  const focusOutputText = focusResult.outputText;
  const fileSummaryOutputText = fileSummaryResult.outputText;
  // La decision que manda es la del foco; si el foco fallo, la del resumen.
  const primaryResult = focusOutputText || focusResult.blocked ? focusResult : fileSummaryResult;
  if (primaryResult.blocked) {
    const otherResult = primaryResult === focusResult ? fileSummaryResult : focusResult;
    return buildBlockedSuggestionModel(snapshot, projectIndex, scope, primaryResult, otherResult, backendError, trigger);
  }
  if (!focusOutputText && !fileSummaryOutputText) {
    return null;
  }

  const emptySections: BackendSuggestionSections = { resumen: [], sugerencias: [], riesgos: [], all: [] };
  const focusSections = focusOutputText
    ? parseBackendSuggestionSections(focusOutputText)
    : emptySections;
  // Sin resumen de archivo del backend se usa la pista local del archivo,
  // nunca las secciones del foco: eso hacia que el "resumen de archivo"
  // repitiera palabra por palabra lo dicho sobre la seleccion.
  const fileSummarySections = fileSummaryOutputText
    ? parseBackendSuggestionSections(fileSummaryOutputText)
    : emptySections;
  const focusLines = focusSections.sugerencias.length > 0 ? focusSections.sugerencias : focusSections.all;
  const fileLines = fileSummarySections.sugerencias.length > 0
    ? fileSummarySections.sugerencias
    : fileSummarySections.all;
  if (focusLines.length === 0 && fileLines.length === 0) {
    return null;
  }

  const localFallback = buildLocalActiveSuggestion(snapshot, projectIndex);
  const fileOverview = fileSummarySections.resumen.length > 0
    ? truncateInline(fileSummarySections.resumen.join(' '), 420)
    : localFallback.fileOverview;
  const focusSummary = focusSections.resumen.length > 0
    ? truncateInline(focusSections.resumen.join(' '), 420)
    : '';
  const completionSeed = focusLines[0]
    || (scope === 'cursor' ? localFallback.lineSuggestions[0] : fileLines[0])
    || fileLines[0]
    || localFallback.suggestions[0]
    || '';
  const completionText = extractFirstCodeFence(focusOutputText)
    || buildSuggestedCompletion(snapshot, completionSeed);
  const applyMode = inferSuggestionApplyMode(
    snapshot,
    `${focusOutputText}\n${fileSummaryResult.outputText}`,
    completionText,
  );
  const fileSuggestions = uniqueCompactStrings(
    fileLines.length ? fileLines : localFallback.fileSuggestions,
    4,
  );
  const lineSuggestions = scope === 'cursor'
    ? uniqueCompactStrings(focusLines.length ? focusLines : localFallback.lineSuggestions, 3)
    : [];
  const combinedSuggestions = uniqueCompactStrings([
    ...(lineSuggestions.length ? lineSuggestions : focusLines),
    ...fileSuggestions,
  ], 5);
  const ragSources = focusResult.ragSources.length ? focusResult.ragSources : fileSummaryResult.ragSources;
  const ragCourseCode = focusResult.ragCourseCode || fileSummaryResult.ragCourseCode;
  return {
    ...localFallback,
    title: `ADACEEN en ${snapshot.fileName}`,
    summary: scope === 'cursor'
      ? focusSummary || fileOverview || truncateInline(focusOutputText.replace(/\s+/g, ' '), 260)
      : fileOverview || truncateInline(focusOutputText.replace(/\s+/g, ' '), 260),
    fileOverview,
    lineSummary: scope === 'cursor'
      ? focusSummary || localFallback.lineSummary || `Foco actual: linea ${snapshot.line}.`
      : '',
    suggestions: combinedSuggestions,
    fileSuggestions,
    lineSuggestions,
    nextSteps: combinedSuggestions.slice(1, 4).length > 0 ? combinedSuggestions.slice(1, 4) : localFallback.nextSteps,
    source: 'backend',
    backendError: backendError ? truncateInline(backendError, 180) : '',
    ragSources,
    ragCourseCode,
    updatedAt: new Date().toISOString(),
    metricId: stableStringHash([
      snapshot.cacheKey,
      scope,
      focusOutputText,
      fileSummaryResult.outputText,
      ragCourseCode,
    ].join('\n---adaceen-metric---\n')),
    completionText,
    applyMode,
    triggerKind: scope === 'cursor' ? 'cursor' : 'file',
    actionsVisible: false,
    decisionId: primaryResult.decisionId || focusResult.decisionId || fileSummaryResult.decisionId || undefined,
    policyApplied: primaryResult.policyApplied,
    codeApplication: primaryResult.codeApplication,
    blocked: false,
    trigger,
  };
}

/** Se ofrece aplicar codigo para este modelo (no bloqueado y permitido por la politica). */
function isSuggestionApplyOffered(model: ActiveSuggestionModel) {
  return !model.blocked && model.codeApplication?.allowed !== false;
}

/** Nota discreta sobre la aplicacion de codigo para mostrar junto a la sugerencia. */
function suggestionApplicationNote(model: ActiveSuggestionModel) {
  const codeApplication = model.codeApplication;
  if (!codeApplication || model.blocked) {
    return '';
  }
  if (codeApplication.allowed === false) {
    return codeApplication.reason || 'Tu docente no permite aplicar código aquí; úsalo como guía y escríbelo tú.';
  }
  if (codeApplication.remaining !== null) {
    return codeApplication.remaining === 1
      ? 'Te queda 1 aplicación en este archivo.'
      : `Te quedan ${codeApplication.remaining} aplicaciones en este archivo.`;
  }
  return '';
}

function detectBranchName() {
  return toOptionalString(getEnv('ADACEEN_BRANCH')) ??
    toOptionalString(getEnv('GITHUB_REF_NAME')) ??
    toOptionalString(getEnv('BRANCH_NAME')) ??
    '';
}

function summarizeActiveSuggestion(model: ActiveSuggestionModel) {
  return uniqueCompactStrings([
    model.lineSummary,
    ...model.lineSuggestions,
    ...model.fileSuggestions,
  ], 5).join('\n');
}

function primarySuggestionText(model: ActiveSuggestionModel) {
  return model.lineSuggestions[0] ||
    model.fileSuggestions[0] ||
    model.suggestions[0] ||
    model.summary ||
    model.fileOverview;
}

/**
 * Lo que el widget flotante necesita del modelo activo. Solo tiene sentido
 * cuando hay seleccion: sin seleccion no hay a que anclarlo.
 */
function toSelectionWidgetModel(model: ActiveSuggestionModel | null): SelectionWidgetModel | null {
  if (!model || model.selectionLineCount <= 0) {
    return null;
  }
  const startLine = Math.max(1, Number(model.line) || 1);
  const endLine = startLine + Math.max(0, model.selectionLineCount - 1);
  return {
    uriString: model.uriString,
    startLine,
    endLine,
    headline: model.lineSummary || primarySuggestionText(model) || '',
    completionText: model.completionText || '',
    language: model.language || '',
    recommendedMode: model.applyMode || 'insert',
    source: model.source,
    ragCourseCode: model.ragCourseCode || '',
    loading: !!model.loading,
    applied: !!model.applied,
    blocked: !!model.blocked,
    tutorMessage: model.tutorMessage || '',
    applyAllowed: isSuggestionApplyOffered(model),
    applicationNote: suggestionApplicationNote(model),
  };
}

function normalizeHistoryText(value: string, max = 360) {
  return truncateInline(value.replace(/\s+/g, ' ').trim(), max);
}

function normalizeHistoryEntry(value: unknown): ActiveSuggestionHistoryEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const source = value as Partial<ActiveSuggestionHistoryEntry>;
  const kind = source.kind === 'line' || source.kind === 'file' ? source.kind : null;
  const id = toOptionalString(source.id);
  const filePath = toOptionalString(source.filePath);
  if (!kind || !id || !filePath || source.source === 'local-fallback') {
    return null;
  }

  const suggestions = Array.isArray(source.suggestions)
    ? uniqueCompactStrings(source.suggestions.map((item) => toOptionalString(item) || ''), 6)
    : [];
  const updatedAt = toOptionalString(source.updatedAt) || toOptionalString(source.createdAt) || new Date().toISOString();
  return {
    id,
    kind,
    filePath,
    fileName: toOptionalString(source.fileName) || filePath.split('/').filter(Boolean).pop() || filePath,
    language: toOptionalString(source.language) || 'general',
    repoFullName: toOptionalString(source.repoFullName) || '',
    title: normalizeHistoryText(toOptionalString(source.title) || (kind === 'line' ? 'Recomendacion de linea' : 'Resumen de archivo'), 160),
    summary: normalizeHistoryText(toOptionalString(source.summary) || suggestions[0] || '', 420),
    suggestions,
    source: source.source === 'backend' ? 'backend' : 'local',
    triggerKind: source.triggerKind === 'cursor' ? 'cursor' : 'file',
    applyMode: source.applyMode === 'replace' || source.applyMode === 'delete' ? source.applyMode : 'insert',
    line: firstPositiveNumber(source.line) || 0,
    column: firstPositiveNumber(source.column) || 0,
    selectionStartLine: firstPositiveNumber(source.selectionStartLine) || 0,
    selectionEndLine: firstPositiveNumber(source.selectionEndLine) || 0,
    selectionLineCount: firstPositiveNumber(source.selectionLineCount) || 0,
    selectionOriginalLineCount: firstPositiveNumber(source.selectionOriginalLineCount) || 0,
    selectionTruncated: source.selectionTruncated === true,
    ragCourseCode: toOptionalString(source.ragCourseCode) || '',
    backendError: normalizeHistoryText(toOptionalString(source.backendError) || '', 180),
    metricId: toOptionalString(source.metricId) || id,
    createdAt: toOptionalString(source.createdAt) || updatedAt,
    updatedAt,
  };
}

function readSuggestionHistory(storage: vscode.Memento): ActiveSuggestionHistoryEntry[] {
  const raw = storage.get<unknown>(ACTIVE_SUGGESTION_HISTORY_STORAGE_KEY);
  const items = Array.isArray(raw) ? raw : [];
  return items
    .map(normalizeHistoryEntry)
    .filter((entry): entry is ActiveSuggestionHistoryEntry => !!entry)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, ACTIVE_SUGGESTION_HISTORY_LIMIT);
}

async function writeSuggestionHistory(storage: vscode.Memento, history: ActiveSuggestionHistoryEntry[]) {
  await storage.update(
    ACTIVE_SUGGESTION_HISTORY_STORAGE_KEY,
    history.filter((entry) => entry.source !== 'local-fallback').slice(0, ACTIVE_SUGGESTION_HISTORY_LIMIT),
  );
}

function buildSuggestionHistoryEntryId(model: ActiveSuggestionModel, kind: ActiveSuggestionHistoryKind, suggestions: string[]) {
  return stableStringHash([
    kind,
    model.metricId,
    model.filePath,
    model.selectionRangeKey,
    model.line,
    model.column,
    suggestions.join('\n'),
  ].join('\n---history---\n'));
}

function buildSuggestionHistoryEntries(model: ActiveSuggestionModel): ActiveSuggestionHistoryEntry[] {
  if (model.loading || model.applied || model.source === 'local-fallback') {
    return [];
  }

  const base = {
    filePath: model.filePath,
    fileName: model.fileName,
    language: model.language,
    repoFullName: model.repoFullName,
    source: model.source,
    triggerKind: model.triggerKind,
    applyMode: model.applyMode,
    line: model.line,
    column: model.column,
    selectionLineCount: model.selectionLineCount,
    selectionOriginalLineCount: model.selectionOriginalLineCount,
    selectionTruncated: model.selectionTruncated,
    ragCourseCode: model.ragCourseCode,
    backendError: model.backendError,
    metricId: model.metricId,
    createdAt: model.updatedAt,
    updatedAt: model.updatedAt,
  };
  const entries: ActiveSuggestionHistoryEntry[] = [];
  const hasLineFocus = model.triggerKind === 'cursor' || model.selectionLineCount > 0 || model.lineSuggestions.length > 0;
  const lineSuggestions = uniqueCompactStrings([
    model.lineSummary,
    ...model.lineSuggestions,
    ...(model.triggerKind === 'cursor' ? model.suggestions : []),
  ], 6);

  if (hasLineFocus && lineSuggestions.length > 0) {
    const selectionStartLine = model.selectionLineCount > 0 ? model.line : 0;
    const selectionEndLine = model.selectionLineCount > 0
      ? model.line + Math.max(0, model.selectionLineCount - 1)
      : 0;
    const title = model.selectionLineCount > 0
      ? `Seleccion lineas ${selectionStartLine}-${selectionEndLine}`
      : `Linea ${model.line}`;
    entries.push({
      ...base,
      id: buildSuggestionHistoryEntryId(model, 'line', lineSuggestions),
      kind: 'line',
      title,
      summary: normalizeHistoryText(model.lineSummary || lineSuggestions[0] || primarySuggestionText(model), 420),
      suggestions: lineSuggestions,
      selectionStartLine,
      selectionEndLine,
    });
  }

  const fileSuggestions = uniqueCompactStrings([
    model.fileOverview,
    ...model.fileSuggestions,
  ], 6);
  if (model.triggerKind === 'file' && fileSuggestions.length > 0) {
    entries.push({
      ...base,
      id: buildSuggestionHistoryEntryId(model, 'file', fileSuggestions),
      kind: 'file',
      title: `Resumen de ${model.fileName}`,
      summary: normalizeHistoryText(model.fileOverview || model.summary || fileSuggestions[0], 420),
      suggestions: fileSuggestions,
      selectionStartLine: 0,
      selectionEndLine: 0,
    });
  }

  return entries;
}

async function rememberSuggestionHistory(
  storage: vscode.Memento,
  model: ActiveSuggestionModel,
): Promise<ActiveSuggestionHistoryEntry[]> {
  const nextEntries = buildSuggestionHistoryEntries(model);
  if (nextEntries.length === 0) {
    return readSuggestionHistory(storage);
  }

  const history = readSuggestionHistory(storage);
  for (const entry of nextEntries) {
    const index = history.findIndex((item) => item.id === entry.id);
    if (index >= 0) {
      history.splice(index, 1, {
        ...history[index],
        ...entry,
        createdAt: history[index].createdAt || entry.createdAt,
        updatedAt: entry.updatedAt || new Date().toISOString(),
      });
    } else {
      history.unshift(entry);
    }
  }

  const compacted = history
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, ACTIVE_SUGGESTION_HISTORY_LIMIT);
  await writeSuggestionHistory(storage, compacted);
  return compacted;
}

function historyEntryTargetLabel(entry: ActiveSuggestionHistoryEntry) {
  if (entry.kind === 'file') {
    return 'Resumen de archivo';
  }
  if (entry.selectionLineCount > 0 && entry.selectionStartLine > 0) {
    const endLine = entry.selectionEndLine > entry.selectionStartLine ? `-${entry.selectionEndLine}` : '';
    return `Seleccion ${entry.selectionStartLine}${endLine}`;
  }
  return entry.line > 0 ? `Linea ${entry.line}` : 'Linea activa';
}

function formatSuggestionHistoryMarkdown(history: ActiveSuggestionHistoryEntry[]) {
  const renderGroup = (title: string, entries: ActiveSuggestionHistoryEntry[]) => {
    if (entries.length === 0) {
      return `## ${title}\n\nSin entradas todavia.\n`;
    }

    return [
      `## ${title}`,
      ...entries.map((entry) => [
        `### ${entry.title}`,
        `- Archivo: ${entry.filePath}`,
        `- Foco: ${historyEntryTargetLabel(entry)}`,
        `- Fuente: ${entry.source}${entry.ragCourseCode ? ` | RAG ${entry.ragCourseCode}` : ''}`,
        `- Fecha: ${entry.updatedAt}`,
        '',
        entry.summary,
        '',
        ...entry.suggestions.map((item) => `- ${item}`),
      ].join('\n')),
    ].join('\n\n');
  };

  const lineEntries = history.filter((entry) => entry.kind === 'line');
  const fileEntries = history.filter((entry) => entry.kind === 'file');
  return [
    '# Historial ADACEEN',
    '',
    'Recomendaciones recientes guardadas en este workspace.',
    '',
    renderGroup('Por linea o seleccion', lineEntries),
    '',
    renderGroup('Por resumen de archivo', fileEntries),
  ].join('\n');
}

function buildSuggestionMetricMetadata(
  model: ActiveSuggestionModel,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    metricId: model.metricId,
    triggerKind: model.triggerKind,
    applyMode: model.applyMode,
    source: model.source,
    line: model.line,
    column: model.column,
    selectionLineCount: model.selectionLineCount,
    selectionOriginalLineCount: model.selectionOriginalLineCount,
    selectionTruncated: model.selectionTruncated,
    selectionMaxLines: ACTIVE_SUGGESTION_SELECTION_MAX_LINES,
    fileSummaryCacheKey: model.fileSummaryCacheKey,
    ragCourseCode: model.ragCourseCode,
    ragSourceCount: model.ragSources.length,
    ragSources: model.ragSources.slice(0, 5).map((source) => ({
      sourceId: source.sourceId,
      chunkId: source.chunkId,
      title: source.title,
      citationLabel: source.citationLabel,
      pageStart: source.pageStart,
      pageEnd: source.pageEnd,
      courseCode: source.courseCode,
    })),
    suggestionPreview: truncateInline(primarySuggestionText(model), 240),
    backendError: model.backendError,
    trigger: model.trigger || '',
    blocked: !!model.blocked,
    ...(model.policyApplied
      ? {
        policyName: model.policyApplied.name,
        policyReasonCode: model.policyApplied.reasonCode,
        helpStage: model.policyApplied.helpStage,
      }
      : {}),
    ...(model.codeApplication
      ? {
        codeApplicationAllowed: model.codeApplication.allowed,
        codeApplicationRemaining: model.codeApplication.remaining,
      }
      : {}),
    ...extra,
  };
}

function buildActionCommentText(snapshot: ActiveEditorSnapshot, model: ActiveSuggestionModel) {
  const baseLine = snapshot.selectionText
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.trim())
    || snapshot.currentLineText
    || '';
  const indent = lineIndent(baseLine);
  const comment = commentPrefixForLanguage(snapshot.language, snapshot.filePath);
  const suggestion = normalizeSuggestionForCode(primarySuggestionText(model) || 'revisar este bloque con ADACEEN');
  return `${indent}${comment.open}TODO: ${suggestion}${comment.close}`;
}

function appendActionCommentToTarget(targetText: string, commentText: string) {
  const cleanTarget = targetText.replace(/\s+$/g, '');
  if (!cleanTarget) {
    return commentText;
  }
  return `${cleanTarget}\n${commentText}`;
}

function looksLikeCommentOnlyCompletion(value: string, snapshot: ActiveEditorSnapshot) {
  const clean = value.trim();
  if (!clean) {
    return false;
  }
  const comment = commentPrefixForLanguage(snapshot.language, snapshot.filePath);
  if (comment.open === '// ') {
    return clean.split(/\r?\n/).every((line) => !line.trim() || line.trim().startsWith('//'));
  }
  return clean.startsWith(comment.open.trim()) && (!comment.close || clean.endsWith(comment.close.trim()));
}

function actionOptionMetadata(
  model: ActiveSuggestionModel,
  snapshot: ActiveEditorSnapshot,
  applyMode: SuggestionApplyMode,
): Record<string, unknown> {
  return {
    source: model.source,
    triggerKind: model.triggerKind,
    applyMode,
    line: model.line,
    column: model.column,
    selectionLineCount: snapshot.selectionLineCount,
    selectionOriginalLineCount: snapshot.selectionOriginalLineCount,
    selectionTruncated: snapshot.selectionTruncated,
    selectionMaxLines: ACTIVE_SUGGESTION_SELECTION_MAX_LINES,
    generatedAt: model.updatedAt,
    language: model.language,
    generatedBy: model.source === 'backend'
      ? 'vscode_extension_agent_decision'
      : 'vscode_extension_local_fallback',
    // Si el navegador devuelve esta opcion como reemplazo, VS Code la valida
    // con apply-check usando la misma decision del tutor.
    ...(model.decisionId ? { decisionId: model.decisionId } : {}),
    ...(model.trigger ? { trigger: model.trigger } : {}),
  };
}

function actionTypeForApplyMode(snapshot: ActiveEditorSnapshot, applyMode: SuggestionApplyMode) {
  if (applyMode === 'delete') {
    return snapshot.selectionText.trim() ? 'delete_selection' : 'delete_line';
  }
  if (applyMode === 'replace') {
    return snapshot.selectionText.trim() ? 'replace_selection' : 'replace_line';
  }
  return 'insert_after_line';
}

function optionLabelForApplyMode(snapshot: ActiveEditorSnapshot, applyMode: SuggestionApplyMode) {
  if (applyMode === 'delete') {
    return snapshot.selectionText.trim() ? 'Eliminar seleccion' : 'Eliminar linea actual';
  }
  if (applyMode === 'replace') {
    return snapshot.selectionText.trim() ? 'Modificar seleccion' : 'Modificar linea actual';
  }
  return 'Agregar codigo o comentario';
}

/** Campos de primer nivel (contrato v1.1) que acompanan a una metrica de sugerencia. */
type SuggestionMetricFields = {
  category?: TelemetryCategory;
  durationMs?: number | null;
  latencyMs?: number | null;
  count?: number | null;
  /** Por defecto el decisionId del modelo. */
  decisionId?: string;
};

function editorPageContext() {
  return isCodespaceRuntime() ? 'codespace' : 'vscode';
}

/**
 * Metrica de sugerencia hacia /api/behavior/events (telemetria v1.1).
 * Ya no exige sesion: sin sesion viaja con x-adaceen-client-id. El cliente
 * de telemetria agrega schemaVersion, seq y clientSessionId, y hace un
 * reintento ante error de red.
 */
function recordVscodeSuggestionMetric(
  telemetry: TelemetryClient,
  model: ActiveSuggestionModel,
  eventType: string,
  value = "",
  extra: Record<string, unknown> = {},
  fields: SuggestionMetricFields = {},
) {
  telemetry.track({
    source: 'vscode_extension',
    category: fields.category || 'suggestion',
    eventType,
    pageContext: editorPageContext(),
    repoFullName: model.repoFullName,
    branch: detectBranchName(),
    filePath: model.filePath,
    language: model.language,
    subjectId: model.metricId,
    value: value || model.applyMode,
    decisionId: fields.decisionId || model.decisionId,
    durationMs: fields.durationMs,
    latencyMs: fields.latencyMs,
    count: fields.count,
    metadata: buildSuggestionMetricMetadata(model, extra),
  });
}

function buildRackReplacementOptions(
  snapshot: ActiveEditorSnapshot,
  model: ActiveSuggestionModel,
): VscodeReplacementOption[] {
  if (!isSuggestionApplyOffered(model)) {
    // Respuesta bloqueada o aplicacion no permitida: el navegador tampoco ofrece reemplazos.
    return [];
  }
  const applyMode = model.applyMode || inferSuggestionApplyMode(snapshot, summarizeActiveSuggestion(model), model.completionText);
  const targetText = snapshot.selectionText.trim() ? snapshot.selectionText : snapshot.currentLineText;
  const actionCommentText = buildActionCommentText(snapshot, model);
  if (applyMode === 'delete') {
    if (!targetText.trim()) {
      return [];
    }
    return [{
      id: 'agent-delete-focused-code',
      label: optionLabelForApplyMode(snapshot, applyMode),
      description: 'ADACEEN decidio que la ayuda aplicable es eliminar el bloque enfocado.',
      actionType: actionTypeForApplyMode(snapshot, applyMode),
      originalText: targetText,
      replacementText: '',
      metadata: {
        ...actionOptionMetadata(model, snapshot, applyMode),
        selectionStartLine: snapshot.selectionStartLine,
        selectionEndLine: snapshot.selectionEndLine,
      },
    }];
  }

  const fallback = buildSuggestedCompletion(snapshot, model.suggestions[0] || model.summary, applyMode === 'replace' ? 'replace' : 'insert');
  const primaryReplacementText = (model.completionText || fallback || actionCommentText).trimEnd();
  if (!primaryReplacementText.trim()) {
    return [];
  }

  const replacementText = applyMode === 'replace'
    && looksLikeCommentOnlyCompletion(primaryReplacementText, snapshot)
    ? appendActionCommentToTarget(targetText, primaryReplacementText)
    : primaryReplacementText;

  return [{
    id: `agent-${applyMode}-focused-code`,
    label: optionLabelForApplyMode(snapshot, applyMode),
    description: `ADACEEN decidio ${suggestionApplyModeLabel(applyMode).toLowerCase()} usando el foco actual del editor.`,
    actionType: actionTypeForApplyMode(snapshot, applyMode),
    originalText: applyMode === 'replace' ? targetText : snapshot.currentLineText,
    replacementText,
    metadata: {
      ...actionOptionMetadata(model, snapshot, applyMode),
      selectionStartLine: snapshot.selectionStartLine,
      selectionEndLine: snapshot.selectionEndLine,
    },
  }];
}

function buildRackFileList(snapshot: ActiveEditorSnapshot, projectIndex: WorkspaceProjectIndex | null) {
  const files = projectIndex?.files.map((entry) => entry.path).filter(Boolean) || [];
  if (!files.includes(snapshot.filePath)) {
    files.unshift(snapshot.filePath);
  }
  return [...new Set(files)].slice(0, 120000);
}

async function publishActiveEditorRack(
  snapshot: ActiveEditorSnapshot,
  model: ActiveSuggestionModel,
  projectIndex: WorkspaceProjectIndex | null,
) {
  const settings = resolveBackendSettings();
  if (!settings.baseUrl || !settings.sessionId) {
    return;
  }

  const files = buildRackFileList(snapshot, projectIndex);
  const folders = [...new Set(projectIndex?.folders || [])].slice(0, 120000);
  await fetchJsonWithTimeout(
    `${settings.baseUrl}/api/projects/rack`,
    {
      method: 'POST',
      headers: buildSessionHeaders(settings, true),
      body: JSON.stringify({
        source: 'vscode_extension',
        repoFullName: snapshot.repoFullName,
        branch: detectBranchName(),
        generatedAt: model.updatedAt || snapshot.generatedAt,
        totalEntries: files.length + folders.length,
        totalFiles: files.length,
        totalFolders: folders.length,
        files,
        folders,
        activeFilePath: snapshot.filePath,
        activeCodeSnippet: snapshot.selectionText || snapshot.visibleText || snapshot.currentLineText,
        activeSuggestion: summarizeActiveSuggestion(model),
        replacementOptions: buildRackReplacementOptions(snapshot, model),
      }),
    },
    settings.requestTimeoutMs,
  );
}

/** Historial en el formato compacto que muestra la vista de quiz. */
function toQuizHistoryItems(history: ActiveSuggestionHistoryEntry[]): QuizHistoryItem[] {
  const seen = new Set<string>();
  return history
    .filter((entry) => {
      const key = `${entry.filePath}\u0000${normalizeHistoryText(entry.summary, 120).toLowerCase()}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, ACTIVE_SUGGESTION_HISTORY_PANEL_LIMIT * 2)
    .map((entry) => ({
      id: entry.id,
      fileName: entry.fileName,
      meta: [historyEntryTargetLabel(entry), entry.ragCourseCode ? `RAG ${entry.ragCourseCode}` : entry.source]
        .filter(Boolean)
        .join(' · '),
      summary: truncateInline(entry.summary || entry.suggestions[0] || '', 140),
    }));
}

class AdaceenSuggestionCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private model: ActiveSuggestionModel | null = null;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  update(model: ActiveSuggestionModel | null) {
    this.model = model;
    this.changeEmitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.model || document.uri.toString() !== this.model.uriString) {
      return [];
    }

    const headline = this.model.loading
      ? 'Cargando sugerencias...'
      : this.model.suggestions[0] || this.model.fileOverview || this.model.title;
    const lineIndex = Math.max(0, (Number(this.model.line) || 1) - 2);
    const range = new vscode.Range(lineIndex, 0, lineIndex, 0);
    const lenses = [
      new vscode.CodeLens(
        range,
        {
          title: `ADACEEN: ${truncateInline(headline, 96)}`,
          command: 'adaceen.openAssistant',
        },
      ),
    ];
    if (
      this.model.actionsVisible &&
      !this.model.loading &&
      !this.model.applied &&
      this.model.source !== 'local-fallback' &&
      isSuggestionApplyOffered(this.model)
    ) {
      const recommendedMode = this.model.applyMode || 'insert';
      const note = suggestionApplicationNote(this.model);
      lenses.push(new vscode.CodeLens(range, {
        title: `$(check) Aceptar ayuda: ${suggestionApplyModeLabel(recommendedMode)}`,
        command: 'adaceen.applySuggestionCompletion',
        arguments: [recommendedMode, 'codelens'],
        ...(note ? { tooltip: note } : {}),
      }));
    }
    return lenses;
  }

  dispose() {
    this.changeEmitter.dispose();
  }
}

function isSuggestionCodeActionRequestFocused(
  model: ActiveSuggestionModel,
  document: vscode.TextDocument,
  range?: vscode.Range,
) {
  if (document.uri.toString() !== model.uriString) {
    return false;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== model.uriString) {
    return false;
  }

  if (model.selectionLineCount > 0) {
    return buildSelectionRangeKey(editor) === model.selectionRangeKey;
  }

  const modelLineIndex = Math.max(0, (Number(model.line) || 1) - 1);
  if (!range) {
    return editor.selection.active.line === modelLineIndex;
  }

  return range.start.line <= modelLineIndex && range.end.line >= modelLineIndex;
}

function suggestionCodeActionTitle(mode: SuggestionApplyMode, focusLabel: string, preferred: boolean) {
  const suffix = preferred ? ' (recomendado)' : '';
  if (mode === 'delete') {
    return `ADACEEN: Aceptar ayuda - eliminar ${focusLabel}${suffix}`;
  }
  if (mode === 'replace') {
    return `ADACEEN: Aceptar ayuda - modificar ${focusLabel}${suffix}`;
  }
  return `ADACEEN: Aceptar ayuda - agregar debajo${suffix}`;
}

function buildSuggestionCodeActions(model: ActiveSuggestionModel) {
  const recommendedMode = model.applyMode || 'insert';
  const focusLabel = model.selectionLineCount ? 'seleccion' : 'linea';
  const action = new vscode.CodeAction(
    suggestionCodeActionTitle(recommendedMode, focusLabel, true),
    vscode.CodeActionKind.QuickFix,
  );
  action.command = {
    title: action.title,
    command: 'adaceen.applySuggestionCompletion',
    arguments: [recommendedMode, 'quick_fix'],
  };
  action.isPreferred = true;
  return [action];
}

class AdaceenSuggestionCodeActionProvider implements vscode.CodeActionProvider, vscode.Disposable {
  private model: ActiveSuggestionModel | null = null;

  update(model: ActiveSuggestionModel | null) {
    this.model = model;
  }

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (
      !this.model ||
      this.model.loading ||
      this.model.applied ||
      this.model.source === 'local-fallback' ||
      !this.model.actionsVisible ||
      !isSuggestionApplyOffered(this.model) ||
      !isSuggestionCodeActionRequestFocused(this.model, document, range)
    ) {
      return [];
    }

    if (context.only && !context.only.contains(vscode.CodeActionKind.QuickFix)) {
      return [];
    }

    return buildSuggestionCodeActions(this.model);
  }

  dispose() {
    this.model = null;
  }
}

function isSuggestionInlineHintFocused(model: ActiveSuggestionModel, document: vscode.TextDocument) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== document.uri.toString()) {
    return false;
  }

  if (model.selectionLineCount > 0) {
    return buildSelectionRangeKey(editor) === model.selectionRangeKey;
  }

  return editor.selection.active.line + 1 === model.line;
}

function isSuggestionInlineHintVisible(model: ActiveSuggestionModel, document: vscode.TextDocument) {
  if (
    model.loading ||
    model.applied ||
    model.source === 'local-fallback' ||
    !isSuggestionApplyOffered(model) ||
    document.uri.toString() !== model.uriString
  ) {
    return false;
  }

  if (!isSuggestionInlineHintFocused(model, document)) {
    return false;
  }

  return model.actionsVisible || model.selectionLineCount > 0;
}

function getSuggestionInlineHintPosition(model: ActiveSuggestionModel, document: vscode.TextDocument) {
  const editor = vscode.window.activeTextEditor;
  if (
    editor &&
    editor.document.uri.toString() === model.uriString &&
    model.selectionLineCount > 0 &&
    buildSelectionRangeKey(editor) === model.selectionRangeKey
  ) {
    const range = getSelectedFullLineRange(editor);
    const lineIndex = Math.max(0, Math.min(document.lineCount - 1, range.end.line));
    return document.lineAt(lineIndex).range.end;
  }

  const lineIndex = Math.max(0, Math.min(document.lineCount - 1, (Number(model.line) || 1) - 1));
  return document.lineAt(lineIndex).range.end;
}

class AdaceenSuggestionInlayHintProvider implements vscode.InlayHintsProvider, vscode.Disposable {
  private model: ActiveSuggestionModel | null = null;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeInlayHints = this.changeEmitter.event;

  update(model: ActiveSuggestionModel | null) {
    this.model = model;
    this.changeEmitter.fire();
  }

  provideInlayHints(
    document: vscode.TextDocument,
    range: vscode.Range,
    _token: vscode.CancellationToken,
  ): vscode.InlayHint[] {
    if (!this.model || !isSuggestionInlineHintVisible(this.model, document)) {
      return [];
    }

    const position = getSuggestionInlineHintPosition(this.model, document);
    if (!range.contains(position)) {
      return [];
    }

    const applyMode = this.model.applyMode || 'insert';
    const modeLabel = suggestionApplyModeLabel(applyMode);
    const labelPart = new vscode.InlayHintLabelPart(`Aceptar ayuda: ${modeLabel}`);
    labelPart.tooltip = buildSuggestionHoverMarkdown(this.model);
    labelPart.command = {
      title: `ADACEEN: Aceptar ayuda (${modeLabel})`,
      command: 'adaceen.applySuggestionCompletion',
      arguments: [applyMode, 'inlay_hint'],
    };

    const hint = new vscode.InlayHint(position, [labelPart], vscode.InlayHintKind.Parameter);
    hint.tooltip = buildSuggestionHoverMarkdown(this.model);
    hint.paddingLeft = true;
    hint.paddingRight = true;
    return [hint];
  }

  dispose() {
    this.changeEmitter.dispose();
  }
}

type BackendOrigin = {
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
};

const UNKNOWN_BACKEND_ORIGIN: BackendOrigin = {
  mode: '',
  label: 'sin consultar',
  id: '',
  provider: 'unknown',
  reachable: false,
  detail: '',
  noWorker: false,
  aliveWorkers: null,
  listeningCount: null,
};

/**
 * Lectura de listening / alive_workers de /api/agent/backend. Solo cuenta
 * como "sin worker" si listening es un arreglo y alive_workers es 0; en modo
 * local o azure no hay workers con latido, asi que no se avisa. Con un
 * backend viejo (sin esos campos) todo sigue como antes.
 */
function readWorkerHeartbeat(data: Record<string, unknown>) {
  const listening = Array.isArray(data.listening) ? data.listening : null;
  const aliveRaw = data.alive_workers;
  const aliveWorkers = typeof aliveRaw === 'number' && Number.isFinite(aliveRaw) ? Math.max(0, Math.floor(aliveRaw)) : null;
  const mode = (toOptionalString(data.mode) || '').toLowerCase();
  const heartbeatMode = mode !== 'local' && mode !== 'azure';
  return {
    listeningCount: listening ? listening.length : null,
    aliveWorkers,
    noWorker: !!listening && aliveWorkers === 0 && heartbeatMode,
  };
}

function backendOriginIcon(origin: BackendOrigin): string {
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
async function fetchBackendOrigin(settings: BackendSettings): Promise<BackendOrigin> {
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

function updateBackendOriginStatusBar(
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
    `Backend: ${settings.baseUrl}`,
    origin.detail,
  ]
    .filter(Boolean)
    .join('\n');
  statusBar.backgroundColor = origin.reachable && !origin.noWorker
    ? undefined
    : new vscode.ThemeColor('statusBarItem.warningBackground');
  statusBar.show();
}

function updateSuggestionStatusBar(statusBar: vscode.StatusBarItem, model: ActiveSuggestionModel | null, enabled: boolean) {
  if (!enabled) {
    statusBar.hide();
    return;
  }

  if (!model) {
    statusBar.text = '$(lightbulb) ADACEEN';
    statusBar.tooltip = 'Abrir panel ADACEEN. Abre un archivo para recibir sugerencias.';
    statusBar.show();
    return;
  }

  if (model.loading) {
    statusBar.text = `$(sync~spin) ADACEEN: cargando`;
    statusBar.tooltip = [
      `Cargando sugerencias para ${model.fileName}...`,
      model.fileOverview ? `Descripcion: ${model.fileOverview}` : '',
    ].filter(Boolean).join('\n');
    statusBar.show();
    return;
  }

  statusBar.text = `$(lightbulb) ADACEEN: ${truncateInline(model.fileName, 22)}`;
  statusBar.tooltip = [
    model.fileOverview ? `Descripcion: ${model.fileOverview}` : '',
    model.summary,
    model.selectionTruncated
      ? `Seleccion limitada: primeras ${ACTIVE_SUGGESTION_SELECTION_MAX_LINES} lineas de ${model.selectionOriginalLineCount}.`
      : '',
	    '',
	    'Clic: abrir panel ADACEEN.',
	    ...(model.suggestions || []).map((item) => `- ${item}`),
    model.backendError ? `Backend: ${model.backendError}` : '',
  ].filter(Boolean).join('\n');
  statusBar.show();
}

function escapeMarkdown(value: string) {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');
}

function buildInlineSuggestionLabel(model: ActiveSuggestionModel) {
  if (model.loading) {
    return "ADACEEN: cargando pista";
  }
  if (model.applied) {
    return `ADACEEN aplicado: ${truncateInline(model.lineSummary || primarySuggestionText(model), 82)}`;
  }
  if (model.blocked) {
    return `ADACEEN tutor: ${truncateInline(primarySuggestionText(model), 82)}`;
  }
  const action = suggestionApplyModeLabel(model.applyMode).toLowerCase();
  const focus = primarySuggestionText(model);
  const scope = model.selectionLineCount ? 'seleccion' : action;
  return `ADACEEN ${scope}: ${truncateInline(focus, 82)}`;
}

function buildSuggestionHoverMarkdown(model: ActiveSuggestionModel) {
  const markdown = new vscode.MarkdownString('', true);
  markdown.isTrusted = {
    enabledCommands: [
      'adaceen.openAssistant',
      'adaceen.applySuggestionCompletion',
      'adaceen.openRagSource',
    ],
  };

  const focusLabel = model.selectionLineCount
    ? `seleccion (${model.selectionLineCount}${model.selectionTruncated ? `/${model.selectionOriginalLineCount || model.selectionLineCount}` : ''} lineas)`
    : `linea ${model.line}`;
  markdown.appendMarkdown(`**ADACEEN en ${escapeMarkdown(focusLabel)}**\n\n`);
  if (model.selectionTruncated) {
    markdown.appendMarkdown(
      `> Seleccion limitada: se analizaron las primeras ${ACTIVE_SUGGESTION_SELECTION_MAX_LINES} lineas de ${model.selectionOriginalLineCount || 'la seleccion'}.\n\n`,
    );
  }
  const openPanelUri = buildCommandUri('adaceen.openAssistant');
  if (model.blocked) {
    // Mensaje controlado del tutor: se muestra tal cual (Markdown) y sin enlace de aplicar.
    markdown.appendMarkdown(`${sanitizeTutorMarkdown(model.tutorMessage || primarySuggestionText(model))}\n\n`);
    markdown.appendMarkdown(`[Ver panel](${openPanelUri})`);
  } else {
    markdown.appendMarkdown(`${escapeMarkdown(primarySuggestionText(model))}\n\n`);
    markdown.appendMarkdown(`**Accion:** ${escapeMarkdown(suggestionApplyModeLabel(model.applyMode))}\n\n`);

    const applyUri = buildCommandUri('adaceen.applySuggestionCompletion', [model.applyMode, 'hover']);
    const applicationNote = suggestionApplicationNote(model);
    markdown.appendMarkdown(`[Ver panel](${openPanelUri})`);
    if (!model.loading && !model.applied && model.source !== 'local-fallback' && isSuggestionApplyOffered(model)) {
      markdown.appendMarkdown(` · [Aceptar ayuda: ${escapeMarkdown(suggestionApplyModeLabel(model.applyMode))}](${applyUri})`);
    } else if (model.applied) {
      markdown.appendMarkdown(`\n\n_Ayuda aplicada. Mantengo el contexto para que puedas validar el cambio._`);
    }
    if (applicationNote && !model.applied && !model.loading) {
      markdown.appendMarkdown(`\n\n_${escapeMarkdown(applicationNote)}_`);
    }
  }

  const ragSource = model.ragSources[0];
  if (ragSource) {
    const ragUri = buildCommandUri('adaceen.openRagSource', [ragSource]);
    const pageText = ragSource.pageStart
      ? ` p. ${ragSource.pageEnd && ragSource.pageEnd !== ragSource.pageStart ? `${ragSource.pageStart}-${ragSource.pageEnd}` : ragSource.pageStart}`
      : '';
    const ragLabel = ragSource.knowledgeTier === 'supplemental' || ragSource.contextDomain === 'bitacora'
      ? 'Contexto suplementario'
      : 'Fuente RAG';
    markdown.appendMarkdown(`\n\n**${ragLabel}:** ${escapeMarkdown(ragSource.title)}${escapeMarkdown(pageText)} ${escapeMarkdown(ragSource.citationLabel || '')}`);
    markdown.appendMarkdown(`\n\n[Abrir fuente o detalle](${ragUri})`);
  }

  if (model.fileOverview) {
    markdown.appendMarkdown(`\n\n---\n${escapeMarkdown(truncateInline(model.fileOverview, 260))}`);
  }

  return markdown;
}

function clearSuggestionDecorations(decorationType: vscode.TextEditorDecorationType) {
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(decorationType, []);
  }
}

function applySuggestionDecoration(
  decorationType: vscode.TextEditorDecorationType,
  model: ActiveSuggestionModel | null,
) {
  clearSuggestionDecorations(decorationType);
  if (!model) {
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== model.uriString) {
    return;
  }

  const lineIndex = Math.max(0, Math.min(editor.document.lineCount - 1, (Number(model.line) || 1) - 1));
  const line = editor.document.lineAt(lineIndex);
  const range = model.selectionLineCount > 0 && buildSelectionRangeKey(editor) === model.selectionRangeKey
    ? editor.selection
    : new vscode.Range(line.range.end, line.range.end);
  const showPassiveLabel = model.loading || model.applied || model.source === 'local-fallback' || !!model.blocked;
  const decoration: vscode.DecorationOptions = {
    range,
    hoverMessage: buildSuggestionHoverMarkdown(model),
  };

  if (showPassiveLabel) {
    decoration.renderOptions = {
      after: {
        contentText: `  ${buildInlineSuggestionLabel(model)}`,
        color: model.loading
          ? new vscode.ThemeColor('editorCodeLens.foreground')
          : new vscode.ThemeColor('editorInfo.foreground'),
        fontStyle: 'italic',
        margin: '0 0 0 1rem',
      },
    };
  }

  editor.setDecorations(decorationType, [decoration]);
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('ADACEEN');
  const safeLog = (line: string) => {
    try {
      output.appendLine(line);
    } catch {
      // Canal ya cerrado (desactivacion): se descarta la linea.
    }
  };
  // Identidad unica para TODAS las llamadas al backend (x-adaceen-client-id);
  // es el mismo id persistente que usaba la vista de quiz.
  initClientIdentity(context.globalState);
  const telemetry = new TelemetryClient({
    getEndpoint: () => {
      const settings = resolveBackendSettings();
      return { baseUrl: settings.baseUrl, sessionId: settings.sessionId, clientId: currentClientId() };
    },
    log: safeLog,
  });
  const codeApplicationGuardDeps = createCodeApplicationGuardDeps(telemetry, output);
  context.subscriptions.push({ dispose: () => telemetry.dispose() });
  const startupSettings = resolveBackendSettings();
  output.appendLine(
    `[Worker] Inicializado | auto=${startupSettings.autoWorkerEnabled} | backend=${startupSettings.baseUrl} | pollMs=${startupSettings.workerPollMs} | workerId=${startupSettings.workerId}`,
  );
  output.appendLine(`[Identidad] clientId=${currentClientId()} | clientSessionId=${telemetry.clientSessionId}`);

  let latestSuggestionHistory = readSuggestionHistory(context.workspaceState);
  // Vista movible "Quiz y seguimiento" (reemplaza el panel de sugerencias):
  // quiz tras aceptar una sugerencia o lanzado por el docente, e historial.
  const quizView = new AdaceenQuizViewProvider({
    memento: context.globalState,
    output,
    getRequestContext: () => {
      const settings = resolveBackendSettings();
      return settings.baseUrl ? { baseUrl: settings.baseUrl, headers: buildSessionHeaders(settings, false) } : null;
    },
    openHistoryEntry: (id) => {
      void vscode.commands.executeCommand('adaceen.openSuggestionHistoryEntry', id);
    },
    openAllHistory: () => {
      void vscode.commands.executeCommand('adaceen.openSuggestionHistory');
    },
  });
  quizView.updateHistory(toQuizHistoryItems(latestSuggestionHistory));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AdaceenQuizViewProvider.viewType, quizView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('adaceen.quiz.checkPending', () => quizView.checkPending(true)),
  );
  const suggestionCodeLensProvider = new AdaceenSuggestionCodeLensProvider();
  const suggestionCodeActionProvider = new AdaceenSuggestionCodeActionProvider();
  const suggestionInlayHintProvider = new AdaceenSuggestionInlayHintProvider();
  // Ventana flotante anclada a la seleccion: una sola sugerencia, en un solo sitio.
  const selectionWidget = new AdaceenSelectionWidget();
  const suggestionStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  suggestionStatusBar.command = 'adaceen.openAssistant';
  updateSuggestionStatusBar(suggestionStatusBar, null, resolveActiveSuggestionSettings().enabled);

  // Indicador de origen de la GPU: PC, Mac, Google Cloud o Colab.
  const backendOriginStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99,
  );
  backendOriginStatusBar.command = 'adaceen.refreshBackendOrigin';
  updateBackendOriginStatusBar(
    backendOriginStatusBar,
    UNKNOWN_BACKEND_ORIGIN,
    resolveBackendSettings(),
  );
  let backendOriginTimer: ReturnType<typeof setInterval> | null = null;

  const refreshBackendOrigin = async (announce = false) => {
    const settings = resolveBackendSettings();
    const origin = await fetchBackendOrigin(settings);
    updateBackendOriginStatusBar(backendOriginStatusBar, origin, settings);
    if (announce) {
      const message = !origin.reachable
        ? `ADACEEN: no se pudo consultar el backend. ${origin.detail}`
        : origin.noWorker
          ? `ADACEEN: GPU sin worker activo. ${origin.detail}`
          : `ADACEEN: la inferencia sale de ${origin.label}${origin.id ? ` (${origin.id})` : ''}.`;
      if (origin.reachable && !origin.noWorker) {
        void vscode.window.showInformationMessage(message);
      } else {
        void vscode.window.showWarningMessage(message);
      }
    }
    return origin;
  };

  context.subscriptions.push(
    backendOriginStatusBar,
    vscode.commands.registerCommand('adaceen.refreshBackendOrigin', () =>
      refreshBackendOrigin(true),
    ),
    new vscode.Disposable(() => {
      if (backendOriginTimer) {
        clearInterval(backendOriginTimer);
        backendOriginTimer = null;
      }
    }),
  );

  void refreshBackendOrigin();
  backendOriginTimer = setInterval(() => {
    void refreshBackendOrigin();
  }, 30000);
  const suggestionDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'normal',
      margin: '0 0 0 1rem',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const backendSuggestionCache: Record<BackendSuggestionRequestScope, Map<string, BackendSuggestionResult>> = {
    cursor: new Map(),
    file_summary: new Map(),
  };
  const backendSuggestionInFlight = new Map<string, BackendSuggestionInFlight>();
  let activeSuggestionModel: ActiveSuggestionModel | null = null;
  let suggestionTimer: ReturnType<typeof setTimeout> | null = null;
  let cursorIdleSuggestionTimer: ReturnType<typeof setTimeout> | null = null;
  let cursorActionTimer: ReturnType<typeof setTimeout> | null = null;
  const recordedSuggestionMetricKeys = new Set<string>();
  let suppressSuggestionRefreshUntil = 0;
  let suppressSuggestionRefreshUri = '';
  let autoRevealedSuggestionUri = '';
  let autoOpenedSelectionActionKey = '';
  let selectionInlinePanelTimer: ReturnType<typeof setTimeout> | null = null;
  let rackSyncErrorNotified = false;
  let workspaceProjectIndexCache: {
    identity: string;
    expiresAt: number;
    value: WorkspaceProjectIndex | null;
  } | null = null;
  let workspaceProjectIndexInFlight: Promise<WorkspaceProjectIndex | null> | null = null;
  // Cuanto estuvo a la vista cada sugerencia, para vscode_suggestion_ignored.
  const suggestionExposure = new SuggestionExposureTracker<ActiveSuggestionModel>();
  // Origen real de las peticiones (trigger): archivo recien abierto y bloqueo pendiente.
  let lastActiveDocumentUri = vscode.window.activeTextEditor?.document.uri.toString() || '';
  let pendingFileOpenUri = lastActiveDocumentUri;
  let pendingBlocking: { uriString: string; key: string; text: string; detectedAt: number } | null = null;
  let applyInProgress = false;
  let lastKnownRepoFullName = '';

  const recordIgnoredSuggestion = (model: ActiveSuggestionModel, durationMs: number, reason: 'replaced' | 'dismissed' | 'closed') => {
    recordVscodeSuggestionMetric(telemetry, model, 'vscode_suggestion_ignored', reason, { reason }, { durationMs });
  };

  const maybeOpenSelectionInlinePanel = (model: ActiveSuggestionModel | null) => {
    const settings = resolveActiveSuggestionSettings();
    if (settings.selectionWidget) {
      // El widget flotante ya muestra la sugerencia y las tres acciones; abrir
      // ademas el hover y el menu de quick fix era lo que "esparcia" la informacion.
      return;
    }
    if (
      !settings.enabled ||
      !settings.autoOpenSelectionActions ||
      !model ||
      model.applied ||
      model.selectionLineCount <= 0
    ) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSuggestionCodeActionRequestFocused(model, editor.document, editor.selection)) {
      return;
    }

    const key = [
      model.uriString,
      model.selectionRangeKey,
      model.applyMode,
      model.updatedAt,
      model.loading ? 'loading' : 'ready',
      model.actionsVisible ? 'actions' : 'preview',
    ].join(':');
    if (autoOpenedSelectionActionKey === key) {
      return;
    }
    autoOpenedSelectionActionKey = key;

    if (selectionInlinePanelTimer) {
      clearTimeout(selectionInlinePanelTimer);
    }
    selectionInlinePanelTimer = setTimeout(() => {
      selectionInlinePanelTimer = null;
      if (
        activeSuggestionModel &&
        activeSuggestionModel.selectionLineCount > 0 &&
        [
          activeSuggestionModel.uriString,
          activeSuggestionModel.selectionRangeKey,
          activeSuggestionModel.applyMode,
          activeSuggestionModel.updatedAt,
          activeSuggestionModel.loading ? 'loading' : 'ready',
          activeSuggestionModel.actionsVisible ? 'actions' : 'preview',
        ].join(':') === key
      ) {
        void vscode.commands.executeCommand('editor.action.showHover');
        if (activeSuggestionModel.actionsVisible && !activeSuggestionModel.loading) {
          setTimeout(() => {
            void vscode.commands.executeCommand('editor.action.quickFix');
          }, 220);
        }
      }
    }, model.loading ? 160 : 80);
  };

  const publishSuggestionModel = (model: ActiveSuggestionModel | null, enabled = true) => {
    // Una sugerencia mostrada que se reemplaza por otra o desaparece sin
    // aplicarse cuenta como ignorada (con el tiempo que estuvo a la vista).
    const ignored = suggestionExposure.onPublish(
      model ? { id: model.metricId, loading: !!model.loading, applied: !!model.applied } : null,
      Date.now(),
    );
    if (ignored) {
      recordIgnoredSuggestion(ignored.item, ignored.durationMs, model ? 'replaced' : 'dismissed');
    }
    activeSuggestionModel = model;
    updateSuggestionStatusBar(suggestionStatusBar, model, enabled);
    quizView.updateHistory(toQuizHistoryItems(latestSuggestionHistory));
    suggestionCodeLensProvider.update(model);
    suggestionCodeActionProvider.update(model);
    const widgetModel = resolveActiveSuggestionSettings().selectionWidget && enabled
      ? toSelectionWidgetModel(model)
      : null;
    selectionWidget.show(widgetModel);
    // Con el widget a la vista, el inlay hint y la decoracion de fin de linea
    // repetirian lo mismo a dos centimetros: se apagan mientras dure.
    suggestionInlayHintProvider.update(widgetModel ? null : model);
    applySuggestionDecoration(suggestionDecorationType, widgetModel ? null : model);
    maybeOpenSelectionInlinePanel(model);
    if (model && !model.loading && !model.applied) {
      void rememberSuggestionHistory(context.workspaceState, model)
        .then((history) => {
          latestSuggestionHistory = history;
          quizView.updateHistory(toQuizHistoryItems(latestSuggestionHistory));
        })
        .catch((error) => {
          output.appendLine(`[Suggestions] No se pudo guardar historial: ${String(error)}`);
        });
    }
  };

  const recordSuggestionMetric = (
    model: ActiveSuggestionModel | null,
    eventType: string,
    value = "",
    extra: Record<string, unknown> = {},
    once = false,
    fields: SuggestionMetricFields = {},
  ) => {
    if (!model || model.loading) {
      return;
    }
    const key = `${eventType}:${model.metricId}:${value || model.applyMode}`;
    if (once && recordedSuggestionMetricKeys.has(key)) {
      return;
    }
    if (once) {
      recordedSuggestionMetricKeys.add(key);
    }
    recordVscodeSuggestionMetric(telemetry, model, eventType, value, extra, fields);
  };

  const clearWorkspaceProjectIndexCache = () => {
    workspaceProjectIndexCache = null;
    workspaceProjectIndexInFlight = null;
  };

  const clearBackendSuggestionCaches = () => {
    backendSuggestionCache.cursor.clear();
    backendSuggestionCache.file_summary.clear();
    backendSuggestionInFlight.clear();
  };

  const buildBackendSuggestionTextCacheKey = (
    snapshot: ActiveEditorSnapshot,
    projectIndex: WorkspaceProjectIndex | null,
    scope: BackendSuggestionRequestScope,
    trigger: SuggestionTrigger,
  ) => {
    const projectKey = projectIndex?.cacheKey || 'sin-mapa';
    const backend = resolveBackendSettings();
    const activeRagCourse = normalizeCourseCode(resolveActiveSuggestionSettings().ragCourseCode);
    const sessionKey = stableStringHash(`${backend.sessionId || 'sin-sesion'}:${activeRagCourse || 'curso-backend'}`);
    if (scope === 'file_summary') {
      return `${sessionKey}:${snapshot.fileSummaryCacheKey}:${projectKey}`;
    }
    // Un bloqueo siempre llega al backend (su pregunta y su politica son otras).
    const triggerKey = trigger === 'blocking' ? ':blocking' : '';
    return `${sessionKey}:${snapshot.cacheKey}:${projectKey}${triggerKey}`;
  };

  const getBackendSuggestionText = async (
    settings: ActiveSuggestionSettings,
    snapshot: ActiveEditorSnapshot,
    projectIndex: WorkspaceProjectIndex | null,
    scope: BackendSuggestionRequestScope,
    requestContext: BackendSuggestionRequestContext,
  ): Promise<BackendSuggestionResult> => {
    const cacheKey = buildBackendSuggestionTextCacheKey(snapshot, projectIndex, scope, requestContext.trigger);
    const cached = backendSuggestionCache[scope].get(cacheKey);
    if (cached) {
      // Sale de la cache local: no hubo viaje al backend, asi que no hay latencia que medir.
      return { ...cached, latencyMs: null };
    }

    const inFlightKey = `${scope}:${cacheKey}`;
    let inFlight = backendSuggestionInFlight.get(inFlightKey);
    if (!inFlight) {
      const request = fetchBackendSuggestionText(settings, snapshot, projectIndex, scope, requestContext);
      inFlight = { key: cacheKey, request };
      backendSuggestionInFlight.set(inFlightKey, inFlight);
      request.then(
        () => backendSuggestionInFlight.delete(inFlightKey),
        () => backendSuggestionInFlight.delete(inFlightKey),
      );
    }

    const result = await inFlight.request;
    if (result.outputText) {
      backendSuggestionCache[scope].set(cacheKey, result);
    }
    return result;
  };

  const getWorkspaceProjectIndex = async () => {
    const identity = getWorkspaceProjectIndexIdentity();
    if (!identity) {
      return null;
    }

    const now = Date.now();
    if (
      workspaceProjectIndexCache &&
      workspaceProjectIndexCache.identity === identity &&
      workspaceProjectIndexCache.expiresAt > now
    ) {
      return workspaceProjectIndexCache.value;
    }

    if (!workspaceProjectIndexInFlight) {
      workspaceProjectIndexInFlight = buildWorkspaceProjectIndexForSuggestions(output)
        .catch((error) => {
          output.appendLine(`[Suggestions] No se pudo construir el mapa local del proyecto: ${String(error)}`);
          return null;
        });
    }

    try {
      const value = await workspaceProjectIndexInFlight;
      workspaceProjectIndexCache = {
        identity,
        expiresAt: Date.now() + ACTIVE_SUGGESTION_INDEX_TTL_MS,
        value,
      };
      return value;
    } finally {
      workspaceProjectIndexInFlight = null;
    }
  };

  const resolveBackendScopeForSnapshot = (
    reason: string,
    snapshot: ActiveEditorSnapshot,
    trigger?: SuggestionTrigger,
  ): BackendSuggestionScope => {
    if (hasActiveSelection(snapshot)) {
      return 'cursor';
    }
    return reason === 'cursor-idle' || trigger === 'blocking' ? 'cursor' : 'file';
  };

  /** Hay un bloqueo detectado en este archivo que todavia no recibio su sugerencia. */
  const hasPendingBlocking = (uriString: string) => {
    if (!pendingBlocking) {
      return false;
    }
    if (Date.now() - pendingBlocking.detectedAt >= BLOCKING_TRIGGER_TTL_MS || !resolveTriggerSettings().suggestOnBlocking) {
      pendingBlocking = null;
      return false;
    }
    return pendingBlocking.uriString === uriString;
  };

  /**
   * Origen real de la peticion (campo trigger de /suggest-tab). Las acciones
   * explicitas del estudiante mandan; despues un bloqueo pendiente, la
   * seleccion, el archivo recien abierto y por ultimo el cursor quieto.
   */
  const resolveSuggestionTrigger = (reason: string, snapshot: ActiveEditorSnapshot): SuggestionTrigger => {
    if (reason === 'manual-refresh') {
      return 'manual';
    }
    if (reason === 'open-panel') {
      return 'panel';
    }
    if (reason === 'blocking' || hasPendingBlocking(snapshot.uriString)) {
      return 'blocking';
    }
    if (hasActiveSelection(snapshot)) {
      return 'selection';
    }
    if (pendingFileOpenUri && pendingFileOpenUri === snapshot.uriString) {
      return 'file_open';
    }
    return 'cursor_idle';
  };

  const publishActiveRackSnapshot = (
    snapshot: ActiveEditorSnapshot,
    model: ActiveSuggestionModel,
    projectIndex: WorkspaceProjectIndex | null,
    reason: string,
  ) => {
    void publishActiveEditorRack(snapshot, model, projectIndex)
      .then(() => {
        rackSyncErrorNotified = false;
      })
      .catch((error) => {
        if (!rackSyncErrorNotified) {
          rackSyncErrorNotified = true;
          output.appendLine(`[Sync] No se pudo publicar el archivo activo hacia el navegador (${reason}): ${String(error)}`);
        }
      });
  };

  const refreshActiveSuggestion = async (reason = 'auto') => {
    const settings = resolveActiveSuggestionSettings();

    if (!settings.enabled) {
      publishSuggestionModel(null, false);
      return null;
    }

    const snapshot = await buildActiveEditorSnapshot(settings);
    if (!snapshot) {
      if (isSuggestionModelDocumentVisible(activeSuggestionModel)) {
        return activeSuggestionModel;
      }
      publishSuggestionModel(null, true);
      return null;
    }

    if (snapshot.repoFullName) {
      lastKnownRepoFullName = snapshot.repoFullName;
    }
    const trigger = resolveSuggestionTrigger(reason, snapshot);
    if (pendingFileOpenUri === snapshot.uriString) {
      // "file_open" solo describe la primera peticion tras abrir el archivo.
      pendingFileOpenUri = '';
    }
    const requestContext: BackendSuggestionRequestContext = {
      trigger,
      clientSessionId: telemetry.clientSessionId,
    };
    const backendScope = resolveBackendScopeForSnapshot(reason, snapshot, trigger);
    const backendStartedAt = Date.now();
    let backendLatencyMs: number | null = null;
    const fallbackDelayMs = Math.min(settings.backendTimeoutMs, ACTIVE_SUGGESTION_FALLBACK_DELAY_MS);
    let model = buildLocalActiveSuggestion(snapshot);
    model = {
      ...model,
      triggerKind: backendScope === 'cursor' ? 'cursor' : 'file',
      actionsVisible: false,
      loading: settings.useBackend,
      trigger,
    };
    publishSuggestionModel(model, true);
    publishActiveRackSnapshot(snapshot, model, null, `${reason}:local`);
    if (settings.autoRevealPanel && backendScope === 'file' && autoRevealedSuggestionUri !== snapshot.uriString) {
      void quizView.reveal(true);
      autoRevealedSuggestionUri = snapshot.uriString;
    }

    let projectIndex: WorkspaceProjectIndex | null = null;
    if (settings.useBackend) {
      projectIndex = await getWorkspaceProjectIndex();
      if (!isSnapshotStillActive(snapshot, backendScope)) {
        return activeSuggestionModel;
      }
      model = {
        ...buildLocalActiveSuggestion(snapshot, projectIndex),
        triggerKind: backendScope === 'cursor' ? 'cursor' : 'file',
        actionsVisible: false,
        loading: true,
        trigger,
      };
      publishSuggestionModel(model, true);
      publishActiveRackSnapshot(snapshot, model, projectIndex, `${reason}:indexed-local`);
    }

    if (settings.useBackend) {
      try {
        const selectedFocus = hasActiveSelection(snapshot);
        const fileSummaryRequest = selectedFocus
          ? null
          : withActiveSuggestionDeadline(
            getBackendSuggestionText(settings, snapshot, projectIndex, 'file_summary', requestContext),
            fallbackDelayMs,
          );
        let focusResult: BackendSuggestionResult;
        let fileSummaryResult: BackendSuggestionResult = createEmptyBackendSuggestionResult();
        let partialBackendError = '';

        if (backendScope === 'cursor') {
          const cursorRequest = withActiveSuggestionDeadline(
            getBackendSuggestionText(settings, snapshot, projectIndex, 'cursor', requestContext),
            fallbackDelayMs,
          );
          const cursorSettled = await settleBackendSuggestionResult(cursorRequest);
          const fileSummarySettled = fileSummaryRequest
            ? await settleBackendSuggestionResult(fileSummaryRequest)
            : null;
          const backendErrors: string[] = [];

          if (cursorSettled.ok) {
            focusResult = cursorSettled.result;
          } else {
            focusResult = createEmptyBackendSuggestionResult();
            backendErrors.push(`seleccion: ${formatBackendSuggestionError(cursorSettled.error)}`);
          }

          if (fileSummarySettled?.ok) {
            fileSummaryResult = fileSummarySettled.result;
          } else if (fileSummarySettled) {
            backendErrors.push(`resumen archivo: ${formatBackendSuggestionError(fileSummarySettled.error)}`);
          }

          if (!cursorSettled.ok && (!fileSummarySettled || !fileSummarySettled.ok)) {
            throw new Error(backendErrors.join(' | ') || 'Backend no disponible para sugerencias.');
          }

          partialBackendError = backendErrors.join(' | ');
          if (partialBackendError) {
            output.appendLine(
              `[Suggestions] Backend parcial (${reason}, ${getBackendSuggestionScopeLabel(backendScope)}): ${partialBackendError}`,
            );
          }
        } else {
          focusResult = await fileSummaryRequest!;
        }
        backendLatencyMs = focusResult.latencyMs ?? fileSummaryResult.latencyMs;

        const backendModel = buildBackendActiveSuggestionModel(
          snapshot,
          projectIndex,
          backendScope,
          focusResult,
          fileSummaryResult,
          partialBackendError,
          trigger,
        );
        if (backendModel) {
          model = backendModel;
        } else {
          throw new Error('Backend no devolvio sugerencias aplicables.');
        }
      } catch (error) {
        const backendErrorMessage = formatBackendSuggestionError(error);
        const remainingMs = fallbackDelayMs - (Date.now() - backendStartedAt);
        if (remainingMs > 0) {
          await delay(remainingMs);
        }
        if (!isSnapshotStillActive(snapshot, backendScope)) {
          return activeSuggestionModel;
        }
        model = {
          ...model,
          source: 'local-fallback',
          backendError: truncateInline(backendErrorMessage, 180),
          loading: false,
        };
        output.appendLine(
          `[Suggestions] Backend no disponible (${reason}, ${getBackendSuggestionScopeLabel(backendScope)}): ${backendErrorMessage}`,
        );
      }
    }

    if (!isSnapshotStillActive(snapshot, backendScope)) {
      return activeSuggestionModel;
    }
    const keepVisibleActions = backendScope === 'cursor'
      && !!activeSuggestionModel?.actionsVisible
      && activeSuggestionModel.uriString === snapshot.uriString
      && (activeSuggestionModel.selectionRangeKey
        ? activeSuggestionModel.selectionRangeKey === snapshot.selectionRangeKey
        : activeSuggestionModel.line === snapshot.line && activeSuggestionModel.column === snapshot.column);
    const finalModel = keepVisibleActions && isSuggestionApplyOffered(model) ? { ...model, actionsVisible: true } : model;
    const shownLatencyMs = Date.now() - backendStartedAt;
    publishSuggestionModel(finalModel, true);
    if (!finalModel.blocked) {
      // Un mensaje bloqueado no se puede aplicar: no cuenta para "ignorada".
      suggestionExposure.markShown(finalModel.metricId, finalModel, Date.now());
    }
    recordSuggestionMetric(finalModel, 'vscode_suggestion_shown', finalModel.applyMode, {
      reason,
      cacheNamespace: backendScope,
      projectIndexKey: projectIndex?.cacheKey || '',
      backendLatencyMs,
      visibleErrorLine: snapshot.diagnostics.firstError?.line ?? null,
    }, true, { latencyMs: shownLatencyMs });
    if (finalModel.blocked) {
      recordSuggestionMetric(
        finalModel,
        'vscode_suggestion_blocked_by_policy',
        finalModel.policyApplied?.reasonCode || 'controlled_message',
        { reason },
        true,
        { category: 'tutor' },
      );
    }
    if (trigger === 'blocking' && finalModel.source === 'backend' && pendingBlocking?.uriString === finalModel.uriString) {
      // El bloqueo ya recibio su sugerencia; las siguientes vuelven a su trigger normal.
      pendingBlocking = null;
    }
    publishActiveRackSnapshot(snapshot, finalModel, projectIndex, `${reason}:final`);
    if (backendScope === 'file' && settings.autoRevealPanel && autoRevealedSuggestionUri !== finalModel.uriString) {
      void quizView.reveal(true);
      autoRevealedSuggestionUri = finalModel.uriString;
    }
    output.appendLine(
      `[Suggestions] ${finalModel.filePath} | scope=${backendScope} | trigger=${trigger} | fuente=${finalModel.source} | linea=${finalModel.line}${finalModel.decisionId ? ` | decision=${finalModel.decisionId}` : ''}${finalModel.blocked ? ' | bloqueada por politica' : ''}`,
    );
    return finalModel;
  };

  const scheduleActiveSuggestionRefresh = (reason = 'auto') => {
    const settings = resolveActiveSuggestionSettings();
    if (!settings.enabled) {
      publishSuggestionModel(null, false);
      return;
    }
    if (suggestionTimer) {
      clearTimeout(suggestionTimer);
    }
    suggestionTimer = setTimeout(() => {
      suggestionTimer = null;
      void refreshActiveSuggestion(reason);
    }, settings.debounceMs);
  };

  const clearCursorSuggestionTimers = () => {
    if (cursorIdleSuggestionTimer) {
      clearTimeout(cursorIdleSuggestionTimer);
      cursorIdleSuggestionTimer = null;
    }
    if (cursorActionTimer) {
      clearTimeout(cursorActionTimer);
      cursorActionTimer = null;
    }
  };

  const hideSuggestionActions = () => {
    if (!activeSuggestionModel?.actionsVisible) {
      suggestionCodeLensProvider.update(activeSuggestionModel);
      return;
    }
    publishSuggestionModel({ ...activeSuggestionModel, actionsVisible: false }, true);
  };

  const revealSuggestionActions = async (anchor: CursorIdleAnchor | null, idleMs = ACTIVE_SUGGESTION_ACTION_IDLE_MS) => {
    if (!anchor || !isCursorIdleAnchorStillActive(anchor)) {
      return;
    }

    let model = activeSuggestionModel;
    if (
      !model ||
      model.uriString !== anchor.uriString ||
      model.triggerKind !== 'cursor' ||
      (model.selectionRangeKey
        ? model.selectionRangeKey !== anchor.selectionRangeKey
        : model.line !== anchor.line + 1 || model.column !== anchor.column + 1)
    ) {
      model = await refreshActiveSuggestion('cursor-idle');
    }

    if (!model || !isCursorIdleAnchorStillActive(anchor)) {
      return;
    }
    if (!isSuggestionApplyOffered(model)) {
      // Respuesta bloqueada o sin permiso para aplicar: no hay acciones que revelar.
      return;
    }

    const visibleModel = { ...model, actionsVisible: true, triggerKind: 'cursor' as const };
    publishSuggestionModel(visibleModel, true);
    recordSuggestionMetric(visibleModel, 'vscode_suggestion_actions_revealed', visibleModel.applyMode, {
      idleMs,
    }, true);
  };

  const suppressAutoRefreshForActiveApply = (uriString: string) => {
    suppressSuggestionRefreshUri = uriString;
    suppressSuggestionRefreshUntil = Date.now() + ACTIVE_SUGGESTION_POST_APPLY_GRACE_MS;
  };

  const isAutoRefreshSuppressed = () => {
    if (applyInProgress) {
      // Mientras se consulta apply-check o se espera la confirmacion, la
      // sugerencia que el estudiante eligio no debe cambiar por debajo.
      return true;
    }
    const editor = vscode.window.activeTextEditor;
    return !!editor
      && Date.now() < suppressSuggestionRefreshUntil
      && editor.document.uri.toString() === suppressSuggestionRefreshUri;
  };

  const scheduleCursorIdleSuggestionRefresh = () => {
    const settings = resolveActiveSuggestionSettings();
    clearCursorSuggestionTimers();
    if (isAutoRefreshSuppressed()) {
      return;
    }
    if (!settings.enabled) {
      publishSuggestionModel(null, false);
      return;
    }

    const anchor = getCursorIdleAnchor();
    if (!anchor) {
      // Sin editor con foco no se borra la sugerencia mientras su archivo
      // siga a la vista (p. ej. el estudiante esta leyendo el panel).
      if (!isSuggestionModelDocumentVisible(activeSuggestionModel)) {
        publishSuggestionModel(null, true);
      }
      return;
    }
    const hasSelection = !!vscode.window.activeTextEditor && !vscode.window.activeTextEditor.selection.isEmpty;
    const suggestionIdleMs = hasSelection ? ACTIVE_SUGGESTION_SELECTION_IDLE_MS : ACTIVE_SUGGESTION_CURSOR_IDLE_MS;
    const actionIdleMs = hasSelection ? ACTIVE_SUGGESTION_SELECTION_ACTION_IDLE_MS : ACTIVE_SUGGESTION_ACTION_IDLE_MS;

    if (activeSuggestionModel && activeSuggestionModel.uriString !== anchor.uriString) {
      publishSuggestionModel(null, true);
    } else {
      hideSuggestionActions();
    }

    cursorIdleSuggestionTimer = setTimeout(() => {
      cursorIdleSuggestionTimer = null;
      if (!isCursorIdleAnchorStillActive(anchor)) {
        return;
      }
      void refreshActiveSuggestion('cursor-idle');
    }, suggestionIdleMs);

    cursorActionTimer = setTimeout(() => {
      cursorActionTimer = null;
      void revealSuggestionActions(anchor, actionIdleMs);
    }, actionIdleMs);
  };

  const resolveEditorForSuggestion = async (model: ActiveSuggestionModel) => {
    const active = vscode.window.activeTextEditor;
    if (active && active.document.uri.toString() === model.uriString) {
      return active;
    }
    // Pulsado desde el panel: el editor sigue abierto a un lado; se le
    // devuelve el foco (conserva su seleccion) y se aplica ahi.
    const visible = vscode.window.visibleTextEditors.find((item) => item.document.uri.toString() === model.uriString);
    if (visible) {
      return vscode.window.showTextDocument(visible.document, { viewColumn: visible.viewColumn, preserveFocus: false });
    }
    try {
      return await vscode.window.showTextDocument(vscode.Uri.parse(model.uriString), { preview: false });
    } catch {
      return undefined;
    }
  };

  const notifyQuizOfAcceptedChange = (
    model: ActiveSuggestionModel,
    mode: SuggestionApplyMode,
    originalCode: string,
    newCode: string,
  ) => {
    void quizView.onSuggestionAccepted({
      filePath: model.filePath,
      language: model.language,
      applyMode: mode,
      originalCode,
      newCode,
      suggestionText: model.lineSummary || primarySuggestionText(model) || '',
      ragCourseCode: model.ragCourseCode || '',
      repoFullName: model.repoFullName || '',
    });
  };

  /**
   * Aplica la sugerencia activa. Todos los caminos del editor pasan por aqui
   * (ventana flotante, CodeLens "Aceptar ayuda", quick fix, inlay hint, hover,
   * panel y paleta de comandos) y, antes de editar, por el guard de
   * aplicacion (apply-check).
   */
  const applySuggestionCompletionNow = async (modeOverride: SuggestionApplyMode | undefined, origin: string) => {
    const model = activeSuggestionModel;
    const editor = model ? await resolveEditorForSuggestion(model) : undefined;
    if (!editor || !model || editor.document.uri.toString() !== model.uriString) {
      vscode.window.showInformationMessage('ADACEEN: no hay una sugerencia activa para aplicar.');
      return;
    }
    if (model.applied) {
      vscode.window.showInformationMessage('ADACEEN: esta ayuda ya fue aplicada. Valida el cambio o actualiza la sugerencia.');
      return;
    }
    if (model.blocked) {
      vscode.window.showInformationMessage('ADACEEN: esta respuesta del tutor no trae código para aplicar.');
      return;
    }

    const mode = modeOverride || model.applyMode || 'insert';
    output.appendLine(
      `[Apply] ${model.fileName}: modo=${mode} (${modeOverride ? 'elegido' : 'recomendado'}) | `
      + `seleccion=${editor.selection.isEmpty ? 'no' : `${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`}`,
    );
    let plan = planSuggestionEdit(editor, model, mode);
    if (!plan.ok) {
      vscode.window.showInformationMessage(plan.message);
      return;
    }

    const versionBeforeCheck = editor.document.version;
    const verdict = await guardCodeApplication({
      decisionId: model.decisionId,
      filePath: model.filePath,
      language: model.language,
      applyMode: mode,
      originalText: plan.removedText,
      newText: plan.proposedText,
      trigger: model.trigger,
      origin,
      fileLabel: model.fileName,
      repoFullName: model.repoFullName,
    }, codeApplicationGuardDeps);
    if (!verdict.allowed) {
      return;
    }
    if (editor.document.version !== versionBeforeCheck) {
      // El archivo cambio mientras se consultaba o confirmaba: se recalcula sobre el texto actual.
      plan = planSuggestionEdit(editor, model, mode);
      if (!plan.ok) {
        vscode.window.showInformationMessage(plan.message);
        return;
      }
    }

    const readyPlan = plan;
    suppressAutoRefreshForActiveApply(model.uriString);
    const applied = await editor.edit((editBuilder) => {
      if (readyPlan.operation === 'delete') {
        editBuilder.delete(readyPlan.range);
      } else if (readyPlan.operation === 'insert') {
        editBuilder.insert(readyPlan.range.start, readyPlan.text);
      } else {
        editBuilder.replace(readyPlan.range, readyPlan.text);
      }
    });
    if (!applied) {
      suppressSuggestionRefreshUntil = 0;
      vscode.window.showWarningMessage(mode === 'delete'
        ? 'ADACEEN: no se pudo aplicar la eliminacion en el editor.'
        : 'ADACEEN: no se pudo aplicar la sugerencia en el editor.');
      return;
    }

    const finalPosition = readyPlan.operation === 'delete'
      ? readyPlan.range.start
      : editor.document.positionAt(editor.document.offsetAt(readyPlan.range.start) + readyPlan.text.length);
    editor.selection = new vscode.Selection(finalPosition, finalPosition);
    const shownAt = suggestionExposure.shownAt(model.metricId);
    recordSuggestionMetric(model, 'suggestion_completion_applied', mode, {
      appliedMode: mode,
      ...(mode === 'delete'
        ? { deletedCharacters: readyPlan.removedText.length }
        : { insertedCharacters: readyPlan.text.length }),
      linesChanged: verdict.linesChanged,
      charsChanged: verdict.charsChanged,
      origin,
      applyCheck: verdict.offline ? 'offline' : 'server',
      confirmedByStudent: verdict.confirmed,
    }, false, {
      decisionId: verdict.decisionId || model.decisionId,
      durationMs: shownAt === null ? null : Date.now() - shownAt,
    });
    publishSuggestionModel(buildAppliedSuggestionModel(model, mode, finalPosition), true);
    notifyQuizOfAcceptedChange(model, mode, readyPlan.quizOriginalCode, mode === 'delete' ? '' : readyPlan.proposedText);
  };

  const applySuggestionCompletion = async (modeOverride?: SuggestionApplyMode, origin = 'command') => {
    if (applyInProgress) {
      // Doble clic mientras se consulta apply-check o se espera la confirmacion.
      return;
    }
    applyInProgress = true;
    try {
      await applySuggestionCompletionNow(modeOverride, origin);
    } finally {
      applyInProgress = false;
    }
  };

  // Botones de la ventana flotante. Reciben el hilo de comentarios como
  // argumento (lo pone VS Code), que aqui no hace falta: la accion siempre
  // va sobre la sugerencia activa.
  const selectionWidgetDisposables = [
    selectionWidget,
    vscode.commands.registerCommand('adaceen.selectionWidget.insert', () => applySuggestionCompletion('insert', SELECTION_WIDGET_ORIGIN)),
    vscode.commands.registerCommand('adaceen.selectionWidget.replace', () => applySuggestionCompletion('replace', SELECTION_WIDGET_ORIGIN)),
    vscode.commands.registerCommand('adaceen.selectionWidget.delete', () => applySuggestionCompletion('delete', SELECTION_WIDGET_ORIGIN)),
    vscode.commands.registerCommand('adaceen.selectionWidget.close', () => {
      // Cerrar la ventana sin aplicar cuenta como sugerencia descartada.
      const model = activeSuggestionModel;
      const dismissed = model ? suggestionExposure.dismiss(model.metricId, Date.now()) : null;
      if (dismissed) {
        recordIgnoredSuggestion(dismissed.item, dismissed.durationMs, 'closed');
      }
      selectionWidget.hide();
    }),
  ];
  context.subscriptions.push(...selectionWidgetDisposables);

  const openAssistantDisposable = vscode.commands.registerCommand('adaceen.openAssistant', async () => {
    const model = activeSuggestionModel || await refreshActiveSuggestion('open-panel');
    void quizView.reveal(false);
    if (!model) {
      return;
    }
    recordSuggestionMetric(model, 'vscode_suggestion_panel_opened', model.applyMode);
  });

  const refreshSuggestionsDisposable = vscode.commands.registerCommand('adaceen.refreshSuggestions', async () => {
    const model = await refreshActiveSuggestion('manual-refresh');
    if (model) {
      void quizView.reveal(false);
      recordSuggestionMetric(model, 'vscode_suggestion_manual_refresh', model.applyMode);
    }
  });

  const openSuggestionHistoryDisposable = vscode.commands.registerCommand('adaceen.openSuggestionHistory', async () => {
    latestSuggestionHistory = readSuggestionHistory(context.workspaceState);
    quizView.updateHistory(toQuizHistoryItems(latestSuggestionHistory));
    if (latestSuggestionHistory.length === 0) {
      vscode.window.showInformationMessage('ADACEEN: aun no hay recomendaciones guardadas en el historial.');
      return;
    }

    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: formatSuggestionHistoryMarkdown(latestSuggestionHistory),
    });
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  });

  const clearSuggestionHistoryDisposable = vscode.commands.registerCommand('adaceen.clearSuggestionHistory', async () => {
    const answer = await vscode.window.showWarningMessage(
      'ADACEEN: se borrara el historial de recomendaciones guardado para este workspace.',
      'Limpiar historial',
    );
    if (answer !== 'Limpiar historial') {
      return;
    }

    latestSuggestionHistory = [];
    await writeSuggestionHistory(context.workspaceState, latestSuggestionHistory);
    quizView.updateHistory(toQuizHistoryItems(latestSuggestionHistory));
    vscode.window.showInformationMessage('ADACEEN: historial de recomendaciones limpiado.');
  });

  const openSuggestionHistoryEntryDisposable = vscode.commands.registerCommand(
    'adaceen.openSuggestionHistoryEntry',
    async (entryId?: string) => {
      latestSuggestionHistory = readSuggestionHistory(context.workspaceState);
      const entry = latestSuggestionHistory.find((item) => item.id === entryId);
      if (!entry) {
        vscode.window.showInformationMessage('ADACEEN: esa recomendacion ya no esta en el historial.');
        return;
      }

      const uri = await resolveWorkspaceFileUri(entry.filePath);
      if (!uri) {
        vscode.window.showWarningMessage(`ADACEEN: no se encontro ${entry.filePath} en el workspace abierto.`);
        return;
      }

      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
      const startLineNumber = entry.selectionStartLine || entry.line || 1;
      const endLineNumber = entry.selectionEndLine || startLineNumber;
      const startLine = Math.max(0, Math.min(document.lineCount - 1, startLineNumber - 1));
      const endLine = Math.max(startLine, Math.min(document.lineCount - 1, endLineNumber - 1));
      const range = new vscode.Range(new vscode.Position(startLine, 0), document.lineAt(endLine).range.end);
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    },
  );

  const applySuggestionCompletionDisposable = vscode.commands.registerCommand(
    'adaceen.applySuggestionCompletion',
    async (mode?: string, origin?: unknown) => {
      const normalizedMode: SuggestionApplyMode | undefined =
        mode === 'insert' || mode === 'replace' || mode === 'delete' ? mode : undefined;
      // origin lo ponen la ventana flotante, el CodeLens, el quick fix... (solo para metricas).
      const normalizedOrigin = typeof origin === 'string' && /^[a-z_]{1,40}$/.test(origin) ? origin : 'command';
      await applySuggestionCompletion(normalizedMode, normalizedOrigin);
    },
  );

  const openRagSourceDisposable = vscode.commands.registerCommand('adaceen.openRagSource', async (sourceArg?: unknown) => {
    const sourceItem = normalizeRagSources([sourceArg])[0];
    if (!sourceItem) {
      vscode.window.showInformationMessage('ADACEEN: esta sugerencia no trae una fuente RAG abrible.');
      return;
    }

    const targetUrl = buildRagSourceTargetUrl(sourceItem);
    if (targetUrl) {
      await vscode.env.openExternal(vscode.Uri.parse(targetUrl));
      recordSuggestionMetric(activeSuggestionModel, 'vscode_rag_source_opened', sourceItem.citationLabel || sourceItem.title, {
        sourceId: sourceItem.sourceId,
        chunkId: sourceItem.chunkId,
        title: sourceItem.title,
        citationLabel: sourceItem.citationLabel,
        pageStart: sourceItem.pageStart,
        pageEnd: sourceItem.pageEnd,
        courseCode: sourceItem.courseCode,
        url: targetUrl,
      });
      return;
    }

    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: buildRagSourceMarkdown(sourceItem),
    });
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    recordSuggestionMetric(activeSuggestionModel, 'vscode_rag_source_opened', sourceItem.citationLabel || sourceItem.title, {
      sourceId: sourceItem.sourceId,
      chunkId: sourceItem.chunkId,
      title: sourceItem.title,
      citationLabel: sourceItem.citationLabel,
      pageStart: sourceItem.pageStart,
      pageEnd: sourceItem.pageEnd,
      courseCode: sourceItem.courseCode,
      openedAsMarkdown: true,
    });
  });

  const setBackendSessionIdDisposable = vscode.commands.registerCommand('adaceen.setBackendSessionId', async () => {
    const current = resolveBackendSettings().sessionId;
    const sessionId = await vscode.window.showInputBox({
      title: 'ADACEEN: Configurar sesión compartida',
      prompt: 'Pega el sessionId copiado desde el overlay del navegador.',
      value: current,
      ignoreFocusOut: true,
      password: false,
      validateInput: (value) => value.trim().length > 0 ? undefined : 'El sessionId no puede estar vacio.',
    });
    if (sessionId === undefined) {
      return;
    }

    await vscode.workspace
      .getConfiguration('adaceen')
      .update('backend.sessionId', sessionId.trim(), vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('ADACEEN: sesión compartida configurada.');
    scheduleCursorIdleSuggestionRefresh();
  });

  const applyNextCodeActionDisposable = vscode.commands.registerCommand('adaceen.applyNextCodeAction', async () => {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) {
      vscode.window.showWarningMessage('ADACEEN: abre una carpeta o workspace antes de aplicar reemplazos.');
      return;
    }

    const repoFullName = await detectRepoFullName(workspaceFolders);
    if (!repoFullName) {
      vscode.window.showWarningMessage('ADACEEN: no pude detectar el repositorio GitHub owner/repo del workspace.');
      return;
    }

    await processNextCodeActionForRepo(resolveBackendSettings(), repoFullName, output, codeApplicationGuardDeps, true);
  });

  const scanWorkspaceDisposable = vscode.commands.registerCommand(
    'adaceen.scanWorkspace',
    async (args?: ScanCommandArgs) => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) {
        vscode.window.showWarningMessage('ADACEEN: abre una carpeta o workspace antes de escanear.');
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'ADACEEN está leyendo el workspace...',
          cancellable: false,
        },
        async () => {
          const scan = await performWorkspaceScan(args, output);
          renderScanOutput(output, scan);
          output.show(true);
          vscode.window.showInformationMessage(
            `ADACEEN leyó ${scan.payload.totalFiles} archivos (${scan.selection.mode}). Revisa Output.`,
          );
        },
      );
    },
  );

  // --- Senales de error y bloqueo (A6.2): activacion por eventos definidos ---
  const errorSignalSettingsFromConfig = () => ({ blockingMs: resolveTriggerSettings().blockingSeconds * 1000 });
  const errorSignalTracker = new ErrorSignalTracker(errorSignalSettingsFromConfig());
  const lastEditAtByUri = new Map<string, number>();
  let errorSignalTimer: ReturnType<typeof setTimeout> | null = null;

  const clearErrorSignalTimer = () => {
    if (errorSignalTimer) {
      clearTimeout(errorSignalTimer);
      errorSignalTimer = null;
    }
  };

  const rememberEdit = (uriString: string) => {
    lastEditAtByUri.delete(uriString);
    lastEditAtByUri.set(uriString, Date.now());
    while (lastEditAtByUri.size > 50) {
      lastEditAtByUri.delete(lastEditAtByUri.keys().next().value as string);
    }
  };

  const recordErrorSignal = (signal: ErrorSignal, document: vscode.TextDocument, errorCount: number) => {
    const filePath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
    const base: TelemetryEventInput = {
      source: 'vscode_extension',
      category: 'signal',
      eventType: signal.type,
      pageContext: editorPageContext(),
      repoFullName: lastKnownRepoFullName || undefined,
      branch: detectBranchName(),
      filePath,
      language: inferActiveLanguage(filePath, document.languageId),
      // El backend lo convierte en errorHash y no guarda el texto.
      errorText: signal.text.slice(0, ERROR_TEXT_MAX_CHARS),
    };
    if (signal.type === 'compile_error_detected') {
      telemetry.track({ ...base, metadata: { line: signal.line, errorCount } });
      return;
    }
    telemetry.track({
      ...base,
      durationMs: signal.durationMs,
      count: signal.count,
      metadata: {
        line: signal.line,
        reason: signal.reason,
        blockingSeconds: resolveTriggerSettings().blockingSeconds,
        errorCount,
      },
    });
  };

  /** Pide una sugerencia con trigger "blocking" (si adaceen.triggers.suggestOnBlocking lo permite). */
  const requestBlockingSuggestion = (signal: BlockingSignal, document: vscode.TextDocument) => {
    if (!resolveTriggerSettings().suggestOnBlocking || !resolveActiveSuggestionSettings().enabled) {
      return;
    }
    // Las peticiones siguientes de este archivo salen con trigger "blocking" hasta que una responda.
    pendingBlocking = { uriString: document.uri.toString(), key: signal.key, text: signal.text, detectedAt: Date.now() };
    if (isAutoRefreshSuppressed()) {
      return;
    }
    if (cursorIdleSuggestionTimer) {
      clearTimeout(cursorIdleSuggestionTimer);
      cursorIdleSuggestionTimer = null;
    }
    void refreshActiveSuggestion('blocking');
  };

  /** Relee los errores del archivo activo y emite compile_error_detected / blocking_detected. */
  const evaluateErrorSignals = () => {
    clearErrorSignalTimer();
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSupportedActiveDocument(editor.document)) {
      return;
    }
    const document = editor.document;
    const uriString = document.uri.toString();
    const summary = collectDocumentDiagnostics(document.uri);
    const now = Date.now();
    const lastEditAt = lastEditAtByUri.get(uriString) ?? Number.NEGATIVE_INFINITY;
    const signals = errorSignalTracker.observe(uriString, summary.errors, now, lastEditAt);
    if (pendingBlocking?.uriString === uriString && !errorSignalTracker.isPresent(pendingBlocking.key)) {
      // El error que causo el bloqueo ya se corrigio.
      pendingBlocking = null;
    }
    let firstBlocking: BlockingSignal | null = null;
    for (const signal of signals) {
      recordErrorSignal(signal, document, summary.errors.length);
      if (signal.type === 'blocking_detected') {
        output.appendLine(
          `[Signals] Bloqueo en ${vscode.workspace.asRelativePath(document.uri, false)}:${signal.line} (${signal.reason === 'persistent' ? `${Math.round(signal.durationMs / 1000)} s con el mismo error` : `${signal.count} apariciones en 10 min`}): ${truncateInline(signal.text, 140)}`,
        );
        firstBlocking = firstBlocking || signal;
      }
    }
    if (firstBlocking) {
      // Una sola peticion aunque en la misma lectura se bloqueen varios errores.
      requestBlockingSuggestion(firstBlocking, document);
    }
    // Los diagnosticos pueden no cambiar mas: se vuelve a mirar cuando venza el siguiente plazo.
    const deadline = errorSignalTracker.nextDeadline(now, lastEditAt);
    if (deadline !== null) {
      errorSignalTimer = setTimeout(evaluateErrorSignals, Math.min(10 * 60_000, Math.max(250, deadline - now + 50)));
    }
  };

  const textDocumentSelector: vscode.DocumentSelector = [
    { scheme: 'file' },
    { scheme: 'vscode-remote' },
    { scheme: 'untitled' },
  ];

  context.subscriptions.push(
    openAssistantDisposable,
    refreshSuggestionsDisposable,
    openSuggestionHistoryDisposable,
    clearSuggestionHistoryDisposable,
    openSuggestionHistoryEntryDisposable,
    applySuggestionCompletionDisposable,
    openRagSourceDisposable,
    setBackendSessionIdDisposable,
    applyNextCodeActionDisposable,
    quizView,
    suggestionCodeLensProvider,
    suggestionCodeActionProvider,
    suggestionInlayHintProvider,
    suggestionStatusBar,
    suggestionDecorationType,
    vscode.languages.registerCodeLensProvider(textDocumentSelector, suggestionCodeLensProvider),
    vscode.languages.registerInlayHintsProvider(textDocumentSelector, suggestionInlayHintProvider),
    vscode.languages.registerCodeActionsProvider(
      textDocumentSelector,
      suggestionCodeActionProvider,
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) {
        // El foco se fue al panel de ADACEEN, a la terminal o a la salida:
        // el archivo sigue abierto, asi que no se toca nada.
        return;
      }
      if (editor.document.uri.toString() !== selectionWidget.uriString) {
        selectionWidget.hide();
      }
      const activeUri = editor.document.uri.toString();
      if (activeUri !== lastActiveDocumentUri) {
        // La primera peticion de este archivo sale con trigger "file_open".
        lastActiveDocumentUri = activeUri;
        pendingFileOpenUri = activeUri;
      }
      suggestionInlayHintProvider.update(activeSuggestionModel);
      applySuggestionDecoration(suggestionDecorationType, activeSuggestionModel);
      scheduleCursorIdleSuggestionRefresh();
      evaluateErrorSignals();
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      selectionWidget.onSelectionChanged(event.textEditor);
      if (vscode.window.activeTextEditor?.document.uri.toString() === event.textEditor.document.uri.toString()) {
        scheduleCursorIdleSuggestionRefresh();
        suggestionInlayHintProvider.update(activeSuggestionModel);
        applySuggestionDecoration(suggestionDecorationType, activeSuggestionModel);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (vscode.window.activeTextEditor?.document.uri.toString() === event.document.uri.toString()) {
        if (event.contentChanges.length > 0) {
          rememberEdit(event.document.uri.toString());
        }
        suggestionInlayHintProvider.update(activeSuggestionModel);
        applySuggestionDecoration(suggestionDecorationType, activeSuggestionModel);
        scheduleCursorIdleSuggestionRefresh();
      }
    }),
    vscode.languages.onDidChangeDiagnostics((event) => {
      const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
      if (activeUri && event.uris.some((uri) => uri.toString() === activeUri)) {
        evaluateErrorSignals();
      }
    }),
    vscode.workspace.onDidSaveTextDocument(() => {
      clearWorkspaceProjectIndexCache();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearWorkspaceProjectIndexCache();
      clearBackendSuggestionCaches();
      scheduleCursorIdleSuggestionRefresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('adaceen.suggestions') ||
        event.affectsConfiguration('adaceen.backend')
      ) {
        clearBackendSuggestionCaches();
        clearWorkspaceProjectIndexCache();
        scheduleCursorIdleSuggestionRefresh();
      }
      if (event.affectsConfiguration('adaceen.triggers')) {
        errorSignalTracker.updateSettings(errorSignalSettingsFromConfig());
        evaluateErrorSignals();
      }
    }),
    {
      dispose: () => {
        if (suggestionTimer) {
          clearTimeout(suggestionTimer);
          suggestionTimer = null;
        }
        clearCursorSuggestionTimers();
        clearErrorSignalTimer();
        if (selectionInlinePanelTimer) {
          clearTimeout(selectionInlinePanelTimer);
          selectionInlinePanelTimer = null;
        }
        clearSuggestionDecorations(suggestionDecorationType);
      },
    },
  );

  let workerBusy = false;
  let workerNextPollAt = 0;
  let idlePollCount = 0;
  let missingWorkspacePollCount = 0;
  let missingRepoPollCount = 0;
  let authErrorNotified = false;

  const runWorkerCycle = async () => {
    const settings = resolveBackendSettings();
    if (!settings.autoWorkerEnabled) {
      return;
    }

    if (Date.now() < workerNextPollAt) {
      return;
    }
    workerNextPollAt = Date.now() + settings.workerPollMs;

    if (workerBusy) {
      return;
    }
    workerBusy = true;

    let requestId = '';
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) {
        missingWorkspacePollCount += 1;
        if (missingWorkspacePollCount % 15 === 0) {
          output.appendLine('[Worker] Sin workspace abierto; esperando para reclamar solicitudes.');
        }
        return;
      }
      missingWorkspacePollCount = 0;

      const repoFullName = await detectRepoFullName(workspaceFolders);
      if (!repoFullName) {
        missingRepoPollCount += 1;
        if (missingRepoPollCount % 10 === 0) {
          output.appendLine('[Worker] No se pudo detectar repo GitHub (owner/repo) desde este workspace.');
        }
        return;
      }
      missingRepoPollCount = 0;

      const processedCodeAction = await processNextCodeActionForRepo(settings, repoFullName, output, codeApplicationGuardDeps, false);
      if (processedCodeAction) {
        idlePollCount = 0;
        return;
      }

      const request = await claimNextScanRequest(settings, repoFullName);
      if (!request) {
        idlePollCount += 1;
        if (idlePollCount % 15 === 0) {
          output.appendLine(`[Worker] Sin solicitudes pendientes para ${repoFullName}.`);
        }
        return;
      }
      idlePollCount = 0;

      requestId = request.id;
      output.appendLine(`[Worker] Solicitud reclamada: ${request.id} (${request.repoFullName}).`);
      output.show(true);

      const scan = await performWorkspaceScan(undefined, output);
      const payload: ScanPayload = {
        ...scan.payload,
        repoFullName: request.repoFullName,
      };
      const scanResponse = await sendScanResult(settings, request.id, payload);

      output.appendLine(
        `[Worker] Escaneo enviado al backend: ${request.repoFullName} (${payload.totalFiles} archivos).`,
      );

      const snapshotId = toOptionalString(asRecord(scanResponse).snapshotId);
      await classifyScannedDocuments(settings, {
        repoFullName: request.repoFullName,
        requestId: request.id,
        snapshotId: snapshotId || '',
        documents: scan.documents,
      }, output);
    } catch (error) {
      const errorMessage = String(error);
      output.appendLine(`[Worker] Error al procesar solicitud de escaneo: ${errorMessage}`);
      output.show(true);

      const normalized = errorMessage.toLowerCase();
      if (
        !authErrorNotified &&
        (normalized.includes('worker no autorizado') || normalized.includes('http 401') || normalized.includes('401'))
      ) {
        authErrorNotified = true;
        vscode.window.showWarningMessage(
          'ADACEEN Worker: backend rechazó la solicitud (401/no autorizado). Revisa adaceen.backend.scanWorkerKey.',
        );
      }

      if (requestId) {
        await sendScanFailure(settings, requestId, errorMessage);
      }
    } finally {
      workerBusy = false;
    }
  };

  const timer = setInterval(() => {
    void runWorkerCycle();
  }, WORKER_TICK_MS);

  context.subscriptions.push(
    scanWorkspaceDisposable,
    output,
    {
      dispose: () => clearInterval(timer),
    },
  );

  scheduleCursorIdleSuggestionRefresh();
  evaluateErrorSignals();
  void runWorkerCycle();
}

export function deactivate() {}
