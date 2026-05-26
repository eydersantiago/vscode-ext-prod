import * as vscode from 'vscode';

export type CoachConfig = {
  backendUrl: string;
  sessionId: string;
  idleThresholdMs: number;
  backendTimeoutMs: number;
  showQuickPickOnSignal: boolean;
  maxCodeChars: number;
  maxProjectFiles: number;
};

function getEnv(name: string): string | undefined {
  const processLike = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return processLike?.env?.[name];
}

function cleanBaseUrl(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || 'http://127.0.0.1:3000').replace(/\/+$/, '');
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function readCoachConfig(): CoachConfig {
  const coach = vscode.workspace.getConfiguration('pdcCoach');
  const legacy = vscode.workspace.getConfiguration('adaceen');
  const backendUrl =
    coach.get<string>('backendUrl') ||
    legacy.get<string>('backend.baseUrl') ||
    getEnv('ADACEEN_BACKEND_URL') ||
    getEnv('PDC_COACH_BACKEND_URL');

  return {
    backendUrl: cleanBaseUrl(backendUrl),
    sessionId: String(coach.get<string>('sessionId') || getEnv('ADACEEN_SESSION_ID') || ''),
    idleThresholdMs: positiveNumber(coach.get<number>('idleThresholdMs'), 45000),
    backendTimeoutMs: positiveNumber(coach.get<number>('backendTimeoutMs'), 12000),
    showQuickPickOnSignal: Boolean(coach.get<boolean>('showQuickPickOnSignal') ?? true),
    maxCodeChars: positiveNumber(coach.get<number>('maxCodeChars'), 6000),
    maxProjectFiles: positiveNumber(coach.get<number>('maxProjectFiles'), 80),
  };
}
