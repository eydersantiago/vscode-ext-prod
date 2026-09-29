// ADACEEN (VS Code): tipos compartidos (escaneo, ajustes, sugerencia activa, historial, acciones de codigo).
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import * as vscode from 'vscode';
import type { BackendUrlSource } from './backend-url';
import type { DiagnosticsSummary } from './error-signals';

export type ScanMode = 'auto' | 'local' | 'codespace' | 'all';

export type ScannedFile = {
  path: string;
  bytes: number;
  lines: number;
  preview: string;
  content: string;
};

export type ScannedDocument = {
  uri: vscode.Uri;
  path: string;
  fileName: string;
  extension: string;
  bytes: number;
};

export type ScanCommandArgs = Partial<{
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

export type ScanOptions = {
  mode: ScanMode;
  includeGlob: string;
  excludeGlob: string;
  maxFiles: number;
  maxFileBytes: number;
  documentIncludeGlob: string;
  maxDocuments: number;
  maxDocumentBytes: number;
};

export type ScanPayload = {
  repoFullName: string;
  runtime: {
    remoteName: string | null;
    isCodespace: boolean;
  };
  mode: {
    requested: ScanMode;
    applied: Exclude<ScanMode, 'auto'>;
    /** Privacidad del escaneo (0.0.33, A12.12). Va en mode porque el backend acepta ahi campos nuevos. */
    gitignoreApplied?: boolean;
    skippedByGitignore?: number;
    skippedAsSecret?: number;
    skippedByBudget?: number;
    maxTotalBytes?: number;
  };
  workspaceFolders: Array<{ name: string; scheme: string }>;
  selectedFolders: Array<{ name: string; scheme: string }>;
  scannedAt: string;
  totalFiles: number;
  skippedBySize: number;
  files: ScannedFile[];
};

export type ScanComputation = {
  payload: ScanPayload;
  options: ScanOptions;
  selection: {
    mode: Exclude<ScanMode, 'auto'>;
    folders: readonly vscode.WorkspaceFolder[];
    notes: string[];
  };
  documents: ScannedDocument[];
};

export type BackendSettings = {
  baseUrl: string;
  /** De donde salio baseUrl (ajuste, entorno, Codespaces, local detectado o produccion). */
  baseUrlSource: BackendUrlSource;
  scanWorkerKey: string;
  sessionId: string;
  autoWorkerEnabled: boolean;
  workerPollMs: number;
  workerId: string;
  requestTimeoutMs: number;
  codeActionsEnabled: boolean;
  autoApplyCodeActions: boolean;
};

export type ActiveSuggestionSettings = {
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
export type TriggerSettings = {
  blockingSeconds: number;
  suggestOnBlocking: boolean;
};

export type CodeApplicationSettings = {
  /** Sin respuesta de apply-check solo se aplican cambios de hasta estas lineas. */
  offlineMaxLines: number;
};

/** Origen real de una peticion a /suggest-tab (contrato: campo trigger). */
export type SuggestionTrigger = 'cursor_idle' | 'selection' | 'manual' | 'blocking' | 'file_open' | 'panel';

/** policy_applied de /suggest-tab. */
export type SuggestionPolicyApplied = {
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
export type SuggestionCodeApplication = {
  allowed: boolean;
  maxLines: number | null;
  remaining: number | null;
  requireConfirmation: boolean;
  countsAsHint: boolean;
  reason: string;
};

export type ActiveSuggestionRagSource = {
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

export type ActiveEditorSnapshot = {
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

export type ActiveSuggestionModel = {
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

export type VscodeReplacementOption = {
  id: string;
  label: string;
  description: string;
  actionType: string;
  originalText: string;
  replacementText: string;
  metadata: Record<string, unknown>;
};

export type WorkspaceProjectIndexEntry = {
  path: string;
  language: string;
  bytes: number;
  lines: number;
  preview: string;
};

export type WorkspaceProjectIndex = {
  cacheKey: string;
  generatedAt: string;
  totalFiles: number;
  files: WorkspaceProjectIndexEntry[];
  folders: string[];
};

export type BackendSuggestionSections = {
  resumen: string[];
  sugerencias: string[];
  riesgos: string[];
  all: string[];
};

export type BackendSuggestionScope = 'file' | 'cursor';

export type BackendSuggestionRequestScope = 'file_summary' | 'cursor';

export type BackendSuggestionInFlight = {
  key: string;
  request: Promise<BackendSuggestionResult>;
};

export type BackendSuggestionResult = {
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
export type BackendSuggestionRequestContext = {
  trigger: SuggestionTrigger;
  clientSessionId: string;
};

export type BackendSuggestionSettledResult =
  | { ok: true; result: BackendSuggestionResult }
  | { ok: false; error: unknown };

export type SuggestionApplyMode = 'insert' | 'replace' | 'delete';

export type ActiveSuggestionHistoryKind = 'line' | 'file';

export type ActiveSuggestionHistoryEntry = {
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

export type CursorIdleAnchor = {
  uriString: string;
  version: number;
  line: number;
  column: number;
  selectionRangeKey: string;
};

export type PendingScanRequest = {
  id: string;
  repoFullName: string;
};

export type PendingCodeAction = {
  id: string;
  repoFullName: string;
  branch: string;
  filePath: string;
  actionType: string;
  title: string;
  originalText: string;
  replacementText: string;
  metadata: Record<string, unknown>;
  /** 'browser_extension' si lo pidio el overlay (clic del estudiante). */
  source: string;
  /** Horas del servidor (ISO): cuando se pidio en el navegador y cuando VS Code lo reclamo. */
  requestedAt: string;
  claimedAt: string;
  /** Hasta cuando es de este VS Code (lease, A12.12); '' con un backend anterior. */
  leaseUntil: string;
  /** Veces que se reclamo: 2 si el primer reclamo vencio y volvio a la cola. */
  attempts: number;
};
