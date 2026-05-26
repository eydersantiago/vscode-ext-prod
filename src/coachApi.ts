import { readCoachConfig } from './coachConfig';
import type {
  GithubMentorContext,
  GithubMentorResult,
  InterventionResponse,
} from './coachTypes';

function fallbackResult(message: string): GithubMentorResult {
  return {
    welcome_message: 'ADACEEN esta listo para ayudarte.',
    analysis_summary: message,
    ideas: [
      'Ubica la senal concreta del bloqueo antes de cambiar codigo.',
      'Haz un cambio pequeno y verificable.',
      'Vuelve a ejecutar o revisar diagnostics antes de tocar mas partes.',
    ],
    searches: [
      'Que error concreto aparece ahora',
      'Que cambio minimo puedo probar',
      'Como validar este archivo paso a paso',
    ],
    guide: [
      'Identifica el archivo, linea o diagnostic relevante.',
      'Aisla el fragmento de codigo relacionado.',
      'Cambia una sola cosa.',
      'Valida si el error o resultado cambia.',
    ],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeResult(value: GithubMentorResult): GithubMentorResult {
  return {
    welcome_message: String(value.welcome_message || ''),
    analysis_summary: String(value.analysis_summary || ''),
    ideas: Array.isArray(value.ideas) ? value.ideas.map(String).filter(Boolean) : [],
    searches: Array.isArray(value.searches) ? value.searches.map(String).filter(Boolean) : [],
    guide: Array.isArray(value.guide) ? value.guide.map(String).filter(Boolean) : [],
  };
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
    const data = text ? JSON.parse(text) as unknown : {};
    if (!response.ok) {
      const error = asRecord(data).error;
      throw new Error(typeof error === 'string' ? error : `HTTP ${response.status}`);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export class CoachBackendClient {
  public lastLatencyMs = 0;

  async mentor(
    question: string,
    context: GithubMentorContext,
    maxItems = 5,
  ): Promise<GithubMentorResult> {
    const cfg = readCoachConfig();
    const started = Date.now();

    try {
      const raw = await fetchJsonWithTimeout(
        `${cfg.backendUrl}/github-mentor`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...(cfg.sessionId ? { 'x-session-id': cfg.sessionId } : {}),
          },
          body: JSON.stringify({
            question,
            max_items: maxItems,
            context,
          }),
        },
        cfg.backendTimeoutMs,
      );

      this.lastLatencyMs = Date.now() - started;
      const data = raw as InterventionResponse;
      if (!data.ok) {
        return fallbackResult(`El backend respondio con error: ${data.error}`);
      }

      return normalizeResult(data.result);
    } catch (error) {
      this.lastLatencyMs = Date.now() - started;
      const label = error instanceof Error ? error.message : String(error);
      return fallbackResult(`No se pudo contactar el backend: ${label}`);
    }
  }

  async saveProjectMemory(payload: unknown): Promise<boolean> {
    const cfg = readCoachConfig();
    const response = await fetchJsonWithTimeout(
      `${cfg.backendUrl}/api/projects/save`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(cfg.sessionId ? { 'x-session-id': cfg.sessionId } : {}),
        },
        body: JSON.stringify(payload),
      },
      cfg.backendTimeoutMs,
    );
    return asRecord(response).ok === true;
  }
}
