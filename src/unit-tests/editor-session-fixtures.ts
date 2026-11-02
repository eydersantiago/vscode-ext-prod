// ADACEEN (VS Code): datos y dependencias falsas compartidas por las pruebas de editor-session*.
// Movido sin cambios desde src/unit-tests/editor-session.test.ts (solo se agrego "export" y los imports).
import * as assert from 'node:assert/strict';
import type { PairingEditorHost } from '../backend-url';
import {
  EditorSessionManager,
  EditorSessionManagerDeps,
} from '../editor-session';
import type { EditorSessionLabel, EditorSessionRecord } from '../editor-session-records';
import type { EditorClaimKind, EditorClaimResult, SessionCheck } from '../editor-session-claim';

export const NOW = Date.parse('2026-09-25T12:00:00.000Z');

export const BACKEND = 'https://app-adaceen-api-eyder05232002.azurewebsites.net';

export const SESSION_A = '11111111-2222-4333-8444-555555555555';

export const SESSION_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';

export const SESSION_C = 'cccccccc-dddd-4eee-8fff-000000000000';

export const GITHUB_TOKEN = 'gho_TOKENSECRETO123';

export function fileText(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    sessionId: SESSION_B,
    backendUrl: `${BACKEND}/`,
    expiresAt: '2026-10-20T00:00:00.000Z',
    userName: 'Ana Estudiante',
    userEmail: 'ana@correounivalle.edu.co',
    writtenAt: '2026-09-25T11:00:00.000Z',
    ...overrides,
  });
}

export function record(overrides: Partial<EditorSessionRecord> = {}): EditorSessionRecord {
  return {
    sessionId: SESSION_A,
    backendUrl: BACKEND,
    expiresAt: Date.parse('2026-10-25T00:00:00.000Z'),
    userName: 'Ana Estudiante',
    userEmail: 'ana@correounivalle.edu.co',
    label: 'github',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// EditorSessionManager con dependencias falsas

type Harness = ReturnType<typeof harness>;

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function harness(options: {
  secret?: string;
  file?: string | null;
  setting?: string;
  env?: string;
  githubToken?: string | null;
  githubClaim?: EditorClaimResult;
  codeClaim?: EditorClaimResult;
  check?: SessionCheck;
  failStore?: boolean;
  backendUrl?: string;
  editorHost?: PairingEditorHost;
  unlinked?: boolean;
  silentGithubAllowed?: boolean;
  /** Demora de cada canje (ms), para las carreras. */
  claimDelayMs?: { github?: number; code?: number };
  /** Demora de SecretStorage al leer (ms) y espera maxima del gestor. */
  secretDelayMs?: number;
  secretReadTimeoutMs?: number;
} = {}) {
  const state = {
    secret: options.secret as string | undefined,
    file: options.file ?? null,
    setting: options.setting,
    backendUrl: options.backendUrl ?? BACKEND,
    unlinked: options.unlinked ?? false,
    now: NOW,
  };
  const logs: string[] = [];
  const claims: Array<{ kind: EditorClaimKind; body: Record<string, unknown>; label: EditorSessionLabel }> = [];
  const tokenModes: string[] = [];
  const checks: string[] = [];
  const changes: Array<{ id: string; idChanged: boolean }> = [];
  let lost = 0;
  let deletes = 0;
  const deps: EditorSessionManagerDeps = {
    secrets: {
      get: async () => {
        const value = state.secret;
        if (options.secretDelayMs) {
          await sleep(options.secretDelayMs);
        }
        return value;
      },
      store: async (value) => {
        if (options.failStore) {
          throw new Error('sin llavero');
        }
        state.secret = value;
      },
      delete: async () => {
        deletes += 1;
        state.secret = undefined;
      },
    },
    readSessionFile: async () => state.file,
    readSetting: () => state.setting,
    readEnv: () => options.env,
    backendUrl: () => state.backendUrl,
    editorHost: () => options.editorHost ?? 'local',
    unlinkedMark: {
      get: () => state.unlinked,
      set: (value) => {
        state.unlinked = value;
      },
    },
    silentGithubAllowed: options.silentGithubAllowed === undefined ? undefined : () => options.silentGithubAllowed === true,
    secretReadTimeoutMs: options.secretReadTimeoutMs,
    getGithubToken: async (mode) => {
      tokenModes.push(mode);
      return options.githubToken === undefined ? null : options.githubToken;
    },
    claim: async (kind, body, label) => {
      claims.push({ kind, body, label });
      const delay = options.claimDelayMs?.[kind];
      if (delay) {
        await sleep(delay);
      }
      const result = kind === 'github' ? options.githubClaim : options.codeClaim;
      return result ?? { ok: false, error: 'network', message: 'sin red', status: 0 };
    },
    checkSession: async (sessionId) => {
      checks.push(sessionId);
      return options.check ?? { status: 'unknown' };
    },
    now: () => state.now,
    log: (line) => logs.push(line),
    onDidChange: (session, idChanged) => changes.push({ id: session?.sessionId ?? '', idChanged }),
    onSessionLost: () => {
      lost += 1;
    },
  };
  const manager = new EditorSessionManager(deps);
  return {
    manager,
    state,
    logs,
    claims,
    tokenModes,
    checks,
    changes,
    get lost() {
      return lost;
    },
    get deletes() {
      return deletes;
    },
  };
}

export function claimOk(sessionId: string, label: EditorSessionLabel): EditorClaimResult {
  return { ok: true, githubLogin: 'ana-gh', session: record({ sessionId, label, userName: 'Ana' }) };
}

export function assertNoSecretsInLogs(h: Harness) {
  const text = h.logs.join('\n');
  for (const secret of [SESSION_A, SESSION_B, SESSION_C, GITHUB_TOKEN, 'K7P4', 'ajuste-123456']) {
    assert.equal(text.includes(secret), false, `el log contiene ${secret}`);
  }
}
