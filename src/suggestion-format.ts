// ADACEEN (VS Code): secciones de la respuesta, fuentes RAG en Markdown y URIs de comando.
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports). Desde la
// 0.0.38 sin importar vscode (la URL del backend la pasa quien llama), para probarlo con node:test.
import { ragViewerUrl } from './rag-viewer-url';
import { uniqueCompactStrings } from './suggestion-results';
import { toOptionalString } from './values';
import type { ActiveSuggestionRagSource, BackendSuggestionScope, BackendSuggestionSections } from './types';

export function getBackendSuggestionScopeLabel(scope: BackendSuggestionScope) {
  return scope === 'cursor' ? 'cursor' : 'archivo';
}

// --- Notas del backend fuera del bloque (0.0.38) ---------------------------------------------

/**
 * Sin la nota que el backend pone justo despues de un bloque recortado («```» y despues una
 * linea en cursiva, renderCutFence): la extension dice lo mismo con code_application.cut
 * (codeCutNote, policyCutReason) y, si no, la nota salia otra vez como texto de la sugerencia.
 * Solo se llama cuando cut viene; solo quita una linea en cursiva sola, la primera despues del
 * primer bloque.
 */
export function stripCutNoteAfterFence(output: string) {
  const text = String(output || '').replace(/\r\n?/g, '\n');
  const fence = /```[^\n]*\n[\s\S]*?\n```[^\n]*(?:\n|$)/.exec(text);
  if (!fence) {
    return text;
  }
  const after = fence.index + fence[0].length;
  const note = /^[ \t]*\n?[ \t]*(?:_[^_\n][^\n]*_|\*[^*\n][^\n]*\*)[ \t]*(?:\n|$)/.exec(text.slice(after));
  return note ? text.slice(0, after) + text.slice(after + note[0].length) : text;
}

// --- Explicacion del tutor (0.0.39) ------------------------------------------------------------

const FENCE_AT_START = /^\s*(?:```|~~~)/;
const FENCE_ANYWHERE = /```|~~~/;
const APPLY_LINE = /^[ \t>*-]*(?:\d+\s*[).:-]?\s*)?(?:\*\*)?(?:acci[oó]n\s*:?\s*)?`?aplicar\s*:/i;
const ACTION_HEADING = /^[ \t>*-]*(?:#+\s*)?(?:\*\*)?\s*(?:\d+\s*[).:-]?\s*)?acci[oó]n\s*:?\s*(?:\*\*)?\s*(?:`?(?:insert|replace|delete)`?\s*)?$/i;
const LIST_MARKER = /^\s*(?:[-*+]\s+|\d{1,3}[.)]\s+|>\s*)/;
const CODE_STATEMENT_START = /^\s*(?:#\s*(?:include|define|ifndef|ifdef|endif|pragma)\b|import\s+[\w.*{]|using\s+namespace\b|package\s+[\w.]+;|from\s+\w[\w.]*\s+import\b)/;
const PYTHON_BLOCK = /^\s*(?:def|class|for|while|if|elif|else|try|except|finally|with)\b[^\n]*:\s*$/;
const INDENTED_CODE = /^(?: {4,}|\t)(?![-*+]\s|\d{1,3}[.)]\s)\S/;

/** La linea parece una instruccion de codigo escrita fuera de un bloque (la misma regla que el backend). */
export function looksLikeCodeLine(line: string) {
  if (INDENTED_CODE.test(String(line || '')) || PYTHON_BLOCK.test(String(line || ''))) {
    return true;
  }
  const outside = String(line || '').replace(LIST_MARKER, '').replace(/`[^`\n]*`/g, '').trim();
  if (!outside) {
    return false;
  }
  return /[;{}]\s*$/.test(outside) || CODE_STATEMENT_START.test(outside) || /^[{}]+$/.test(outside);
}

/**
 * La explicacion (prosa) de una respuesta del tutor, sin codigo: sin los bloques, sin la linea
 * «Aplicar:» ni el encabezado «Accion», y sin lineas que parecen codigo escrito fuera de un bloque.
 * live: el texto en vivo, que termina en el primer bloque (lo de despues llega en el final) y solo
 * hasta la ultima linea completa; el backend ya lo filtra, esto es una segunda barrera.
 */
export function explanationFromTutorText(output: string, options: { live?: boolean } = {}) {
  let text = String(output || '').replace(/\r\n?/g, '\n');
  if (options.live && !text.endsWith('\n')) {
    const lastNewline = text.lastIndexOf('\n');
    text = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
  }
  const kept: string[] = [];
  let insideFence = false;
  for (const line of text.split('\n')) {
    if (options.live ? FENCE_ANYWHERE.test(line) : FENCE_AT_START.test(line)) {
      if (options.live) {
        break;
      }
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) {
      continue;
    }
    if (!line.trim()) {
      kept.push('');
      continue;
    }
    if (APPLY_LINE.test(line) || ACTION_HEADING.test(line) || looksLikeCodeLine(line)) {
      continue;
    }
    kept.push(line.replace(/\s+$/, ''));
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Una linea entera en cursiva de Markdown (`_texto_` o `*texto*`) como texto: el backend pone sus
 * notas asi fuera del bloque, y la ventana escapa el Markdown (se veian los guiones bajos).
 */
export function unwrapEmphasisLine(line: string) {
  const text = String(line || '').trim();
  const match = /^_([^_].*[^_]|[^_])_$/.exec(text) || /^\*([^*].*[^*]|[^*])\*$/.exec(text);
  return match ? match[1].trim() : text;
}

export function cleanBackendSuggestionLine(value: string) {
  // 0.0.38: una nota en cursiva del backend (`_..._`) se lee como texto, sin los guiones bajos.
  return unwrapEmphasisLine(value
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/g, '')
    .replace(/^#+\s*/g, '')
    .replace(/\*\*/g, '')
    .trim());
}

export function parseBackendSuggestionSections(output: string): BackendSuggestionSections {
  const sections: BackendSuggestionSections = {
    resumen: [],
    sugerencias: [],
    riesgos: [],
    all: [],
  };
  let current: keyof Omit<BackendSuggestionSections, 'all'> | '' = '';
  let insideFence = false;

  for (const rawLine of output.split(/\r?\n/)) {
    // El bloque de codigo no es texto de la sugerencia (0.0.34): sus lineas
    // aparecian como «sugerencias» o «riesgos» en el panel y en el historial.
    if (/^\s*```/.test(rawLine)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) {
      continue;
    }
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

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildCommandUri(command: string, args: unknown[] = []) {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;
}

/** La URL de una fuente RAG para el navegador; `backendBaseUrl` completa una ruta relativa del visor. */
export function buildRagSourceTargetUrl(source: ActiveSuggestionRagSource, backendBaseUrl: string) {
  // Sin sessionId: el visor no la usa y la URL queda en el historial y en la telemetria.
  const rawUrl = ragViewerUrl(toOptionalString(source.url) || '', backendBaseUrl);
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

export function buildRagSourceMarkdown(source: ActiveSuggestionRagSource, backendBaseUrl: string) {
  const targetUrl = buildRagSourceTargetUrl(source, backendBaseUrl);
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
