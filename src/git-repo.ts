// ADACEEN (VS Code): repositorio y rama actuales (extension Git de VS Code y .git/config).
// Movido sin cambios desde src/extension.ts (solo se agrego "export" y los imports).
import * as vscode from 'vscode';
import { getEnv, toOptionalString } from './settings';

export type GitRemoteRef = {
  name?: string;
  fetchUrl?: string;
  pushUrl?: string;
};

export type GitRepositoryRef = {
  rootUri?: vscode.Uri;
  state?: {
    remotes?: GitRemoteRef[];
  };
};

export type GitApiRef = {
  repositories?: GitRepositoryRef[];
};

export type GitExtensionExports = {
  getAPI(version: number): GitApiRef;
};

export function extractRepoFromGitUrl(url: string): string | undefined {
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

export function parseRepoFromGitConfig(raw: string): string | undefined {
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

export function resolveGitDirUri(baseUri: vscode.Uri, gitDirRaw: string): vscode.Uri | undefined {
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

export async function readGitConfigText(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
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

export async function detectRepoFromGitExtension(
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

export async function detectRepoFullName(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<string | undefined> {
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

export function detectBranchName() {
  return toOptionalString(getEnv('ADACEEN_BRANCH')) ??
    toOptionalString(getEnv('GITHUB_REF_NAME')) ??
    toOptionalString(getEnv('BRANCH_NAME')) ??
    '';
}
