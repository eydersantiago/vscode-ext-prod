// ADACEEN (VS Code): secciones de la respuesta, fuentes RAG en Markdown y URIs de comando.
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import { ragViewerUrl } from './rag-viewer-url';
import { resolveCurrentBackendBaseUrl, toOptionalString } from './settings';
import { uniqueCompactStrings } from './suggestion-results';
import type { ActiveSuggestionRagSource, BackendSuggestionScope, BackendSuggestionSections } from './types';

export function getBackendSuggestionScopeLabel(scope: BackendSuggestionScope) {
  return scope === 'cursor' ? 'cursor' : 'archivo';
}

export function cleanBackendSuggestionLine(value: string) {
  return value
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/g, '')
    .replace(/^#+\s*/g, '')
    .replace(/\*\*/g, '')
    .trim();
}

export function parseBackendSuggestionSections(output: string): BackendSuggestionSections {
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

export function buildRagSourceTargetUrl(source: ActiveSuggestionRagSource) {
  // Sin sessionId: el visor no la usa y la URL queda en el historial y en la telemetria.
  const rawUrl = ragViewerUrl(toOptionalString(source.url) || '', resolveCurrentBackendBaseUrl().baseUrl);
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

export function buildRagSourceMarkdown(source: ActiveSuggestionRagSource) {
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
