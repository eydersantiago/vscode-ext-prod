// ADACEEN (VS Code): constantes de configuracion por defecto, limites y tiempos.
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).

export const DEFAULT_INCLUDE_GLOB =
  '**/*.{ts,tsx,js,jsx,mjs,cjs,py,java,cpp,c,h,hpp,cs,go,rs,php,rb,md,json,yml,yaml,html,css,scss,sql,xml}';

export const DEFAULT_DOCUMENT_INCLUDE_GLOB =
  '**/*.{pdf,docx,txt,md,markdown,png,jpg,jpeg,webp,gif,bmp,tiff}';

export const DEFAULT_EXCLUDE_GLOB =
  '**/{node_modules,.git,dist,build,out,coverage,.next,target,bin,obj,vendor,__pycache__}/**';

export const DEFAULT_MAX_FILES = 200;

export const DEFAULT_MAX_FILE_BYTES = 300 * 1024; // 300 KB por archivo

export const DEFAULT_MAX_DOCUMENTS = 12;

export const DEFAULT_MAX_DOCUMENT_BYTES = 1024 * 1024;

export const DEFAULT_WORKER_POLL_MS = 8000;

export const DEFAULT_ACTIVE_SUGGESTION_DEBOUNCE_MS = 900;

export const DEFAULT_ACTIVE_SUGGESTION_MAX_CODE_CHARS = 24000;

export const DEFAULT_ACTIVE_SUGGESTION_TIMEOUT_MS = 120000;

export const ACTIVE_SUGGESTION_FALLBACK_DELAY_MS = 120000;

export const DEFAULT_CODE_ACTION_CONFIRM_LABEL = 'Aplicar reemplazo';

export const ACTIVE_SUGGESTION_INDEX_TTL_MS = 60_000;

export const ACTIVE_SUGGESTION_INDEX_MAX_FILES = 90;

export const ACTIVE_SUGGESTION_INDEX_MAX_FILE_KB = 96;

export const ACTIVE_SUGGESTION_INDEX_PREVIEW_CHARS = 220;

export const ACTIVE_SUGGESTION_PROMPT_CODE_CHARS = 7200;

export const ACTIVE_SUGGESTION_PROMPT_VISIBLE_CHARS = 1400;

export const ACTIVE_SUGGESTION_PROMPT_SELECTION_CHARS = 12000;

export const ACTIVE_SUGGESTION_SELECTION_MAX_LINES = 20;

export const ACTIVE_SUGGESTION_PROMPT_INDEX_MAX_FILES = 24;

export const ACTIVE_SUGGESTION_PROMPT_INDEX_PREVIEW_CHARS = 110;

export const ACTIVE_SUGGESTION_CURSOR_IDLE_MS = 3000;

export const ACTIVE_SUGGESTION_ACTION_IDLE_MS = 10000;

export const ACTIVE_SUGGESTION_SELECTION_IDLE_MS = 1200;

export const ACTIVE_SUGGESTION_SELECTION_ACTION_IDLE_MS = 2200;

export const ACTIVE_SUGGESTION_POST_APPLY_GRACE_MS = 3500;

export const ACTIVE_SUGGESTION_HISTORY_STORAGE_KEY = 'adaceen.suggestionHistory.v1';

export const ACTIVE_SUGGESTION_HISTORY_LIMIT = 80;

export const ACTIVE_SUGGESTION_HISTORY_PANEL_LIMIT = 5;

export const WORKER_TICK_MS = 4000;

export const DEFAULT_BLOCKING_SECONDS = 90;

export const APPLY_CHECK_TIMEOUT_MS = 8000;

/** Una senal de bloqueo pendiente marca las peticiones siguientes como trigger "blocking" durante este tiempo. */
export const BLOCKING_TRIGGER_TTL_MS = 10 * 60_000;

export const DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'txt', 'md', 'markdown', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff']);
