// ADACEEN (VS Code): utilidades de texto y normalizacion de la respuesta del backend para la sugerencia activa.
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import { asRecord, toOptionalString } from './settings';
import type { ActiveSuggestionRagSource, BackendSuggestionResult, BackendSuggestionSettledResult, SuggestionCodeApplication, SuggestionPolicyApplied } from './types';

export function pathBaseName(value: string) {
  const clean = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return clean[clean.length - 1] || value || 'archivo';
}

export function pathExtension(value: string) {
  const baseName = pathBaseName(value).toLowerCase();
  const index = baseName.lastIndexOf('.');
  return index >= 0 ? baseName.slice(index + 1) : '';
}

export function inferActiveLanguage(filePath: string, languageId: string) {
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

export function truncateInline(value: string, max = 120) {
  const text = toOptionalString(value) || '';
  if (!text || max <= 0) {
    return '';
  }
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

export function uniqueCompactStrings(items: string[], limit: number) {
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

export function firstPositiveNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return number;
    }
  }
  return null;
}

export function normalizeCourseCode(value: unknown) {
  return (toOptionalString(value) || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
}

export function parseRagPageRangeFromLabel(label: unknown) {
  const match = (toOptionalString(label) || '').match(/\bp\.\s*(\d+)(?:\s*-\s*(\d+))?/i);
  if (!match) {
    return { pageStart: null as number | null, pageEnd: null as number | null };
  }
  const pageStart = firstPositiveNumber(match[1]);
  const pageEnd = firstPositiveNumber(match[2]) || pageStart;
  return { pageStart, pageEnd };
}

export function normalizeRagSources(value: unknown): ActiveSuggestionRagSource[] {
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

export function optionalFiniteInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : null;
}

export function normalizePolicyApplied(value: unknown): SuggestionPolicyApplied | null {
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

export function normalizeSuggestionCodeApplication(value: unknown): SuggestionCodeApplication | null {
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

export function normalizeBackendSuggestionResult(value: unknown, latencyMs: number | null = null): BackendSuggestionResult {
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

export function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

export function isAbortLikeError(error: unknown) {
  const message = String(error);
  return error instanceof Error && error.name === 'AbortError'
    || /AbortError|aborted|abortado|operaci[oó]n.*abort/i.test(message);
}

export function formatBackendSuggestionError(error: unknown) {
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

export function withActiveSuggestionDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
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

export function createEmptyBackendSuggestionResult(): BackendSuggestionResult {
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

export async function settleBackendSuggestionResult(
  promise: Promise<BackendSuggestionResult>,
): Promise<BackendSuggestionSettledResult> {
  try {
    return { ok: true, result: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}
