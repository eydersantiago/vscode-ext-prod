import * as vscode from 'vscode';
import { readCoachConfig } from './coachConfig';
import type { GithubMentorContext, ProjectMemoryMetrics } from './coachTypes';

const PROJECT_FILE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,py,java,cpp,c,h,hpp,cs,go,rs,php,rb,md,json,yml,yaml,html,css,scss,sql,xml}';
const PROJECT_EXCLUDE_GLOB = '**/{node_modules,.git,dist,build,out,coverage,.next,target,bin,obj,vendor,__pycache__}/**';

type GitRemoteRef = {
  name?: string;
  fetchUrl?: string;
  pushUrl?: string;
};

type GitRepositoryRef = {
  rootUri?: vscode.Uri;
  state?: {
    HEAD?: {
      name?: string;
    };
    remotes?: GitRemoteRef[];
  };
};

type GitApiRef = {
  repositories?: GitRepositoryRef[];
};

type GitExtensionExports = {
  getAPI(version: number): GitApiRef;
};

type GitInfo = {
  repoFullName: string;
  branch: string;
};

function getEnv(name: string): string | undefined {
  const processLike = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return processLike?.env?.[name];
}

function isCodespaceRuntime(): boolean {
  const remoteName = (vscode.env.remoteName ?? '').toLowerCase();
  if (remoteName.includes('codespace')) {return true;}
  const envFlag = (getEnv('CODESPACES') ?? '').toLowerCase();
  return envFlag === 'true' || envFlag === '1';
}

function extractRepoFromGitUrl(value: string): string {
  const clean = value.trim();
  const patterns = [
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i,
  ];

  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (match) {return `${match[1]}/${match[2]}`.replace(/\.git$/i, '');}
  }

  return '';
}

function parseRepoFromGitConfig(raw: string): string {
  const originSection = raw.match(/\[remote\s+"origin"\]([\s\S]*?)(?:\n\[|$)/i)?.[1] || '';
  const originUrl = originSection.match(/^\s*url\s*=\s*(.+)\s*$/im)?.[1];
  const fromOrigin = originUrl ? extractRepoFromGitUrl(originUrl) : '';
  if (fromOrigin) {return fromOrigin;}

  const allUrls = raw.match(/^\s*url\s*=\s*(.+)\s*$/gim) || [];
  for (const line of allUrls) {
    const parsed = extractRepoFromGitUrl(line.replace(/^\s*url\s*=\s*/i, '').trim());
    if (parsed) {return parsed;}
  }

  return '';
}

async function readGitConfigText(folder: vscode.WorkspaceFolder): Promise<string> {
  try {
    const gitConfigUri = vscode.Uri.joinPath(folder.uri, '.git', 'config');
    const gitConfigDoc = await vscode.workspace.openTextDocument(gitConfigUri);
    return gitConfigDoc.getText();
  } catch {
    return '';
  }
}

async function detectGitInfoFromExtension(
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): Promise<GitInfo> {
  try {
    const gitExtension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!gitExtension) {return { repoFullName: '', branch: '' };}

    const gitExports = gitExtension.isActive
      ? gitExtension.exports
      : await gitExtension.activate();
    if (!gitExports || typeof gitExports.getAPI !== 'function') {
      return { repoFullName: '', branch: '' };
    }

    const api = gitExports.getAPI(1);
    const repositories = Array.isArray(api.repositories) ? api.repositories : [];
    const workspaceUris = workspaceFolders.map((folder) => folder.uri.toString().toLowerCase());

    for (const repo of repositories) {
      const rootUri = repo.rootUri;
      if (!rootUri) {continue;}
      const rootRef = rootUri.toString().toLowerCase();
      const belongsToWorkspace = workspaceUris.some(
        (workspaceUri) => rootRef.startsWith(workspaceUri) || workspaceUri.startsWith(rootRef),
      );
      if (!belongsToWorkspace) {continue;}

      const remotes = Array.isArray(repo.state?.remotes) ? [...repo.state.remotes] : [];
      remotes.sort((a, b) => {
        const aIsOrigin = (a.name || '').toLowerCase() === 'origin';
        const bIsOrigin = (b.name || '').toLowerCase() === 'origin';
        if (aIsOrigin === bIsOrigin) {return 0;}
        return aIsOrigin ? -1 : 1;
      });

      for (const remote of remotes) {
        const parsed = extractRepoFromGitUrl(remote.fetchUrl || remote.pushUrl || '');
        if (parsed) {
          return {
            repoFullName: parsed,
            branch: repo.state?.HEAD?.name || '',
          };
        }
      }
    }
  } catch {
    return { repoFullName: '', branch: '' };
  }

  return { repoFullName: '', branch: '' };
}

async function detectGitInfo(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<GitInfo> {
  const fromExtension = await detectGitInfoFromExtension(workspaceFolders);
  if (fromExtension.repoFullName || fromExtension.branch) {return fromExtension;}

  for (const folder of workspaceFolders) {
    const gitConfigText = await readGitConfigText(folder);
    if (!gitConfigText) {continue;}
    const repoFullName = parseRepoFromGitConfig(gitConfigText);
    if (repoFullName) {return { repoFullName, branch: '' };}
  }

  return { repoFullName: '', branch: '' };
}

function safeRelativePath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
}

function visibleSnippet(editor: vscode.TextEditor, maxChars: number): string {
  const doc = editor.document;
  const visible = editor.visibleRanges[0];

  if (!visible) {
    return doc.getText().slice(0, maxChars);
  }

  const start = Math.max(0, visible.start.line - 25);
  const end = Math.min(doc.lineCount - 1, visible.end.line + 25);
  const range = new vscode.Range(new vscode.Position(start, 0), doc.lineAt(end).range.end);

  return doc.getText(range).slice(0, maxChars);
}

export function activeErrorDiagnostics(): vscode.Diagnostic[] {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {return [];}
  return vscode.languages
    .getDiagnostics(editor.document.uri)
    .filter((item) => item.severity === vscode.DiagnosticSeverity.Error);
}

function visibleErrorForDocument(uri: vscode.Uri): string {
  return vscode.languages
    .getDiagnostics(uri)
    .filter((item) => item.severity === vscode.DiagnosticSeverity.Error)
    .slice(0, 4)
    .map((item) => `L${item.range.start.line + 1}: ${item.message}`)
    .join('\n');
}

export async function buildMentorContext(): Promise<GithubMentorContext> {
  const cfg = readCoachConfig();
  const editor = vscode.window.activeTextEditor;
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  const gitInfo = await detectGitInfo(workspaceFolders);
  const [repoOwner, repoName] = gitInfo.repoFullName.split('/');

  if (!editor) {
    return {
      title: vscode.workspace.name || 'Codespace',
      pageContext: 'github',
      pageType: isCodespaceRuntime() ? 'codespace' : 'other',
      repoOwner,
      repoName,
      repoFullName: gitInfo.repoFullName,
      branch: gitInfo.branch,
      learningGoal: 'github_flow',
      codeLineCount: 0,
    };
  }

  const doc = editor.document;
  const visibleError = visibleErrorForDocument(doc.uri);
  const selection = editor.selection.isEmpty
    ? ''
    : doc.getText(editor.selection).slice(0, cfg.maxCodeChars);

  return {
    url: doc.uri.toString(),
    title: doc.fileName || doc.uri.toString(),
    pageContext: 'github',
    pageType: isCodespaceRuntime() ? 'codespace' : 'other',
    repoOwner,
    repoName,
    repoFullName: gitInfo.repoFullName,
    branch: gitInfo.branch,
    filePath: safeRelativePath(doc.uri),
    languageHint: doc.languageId,
    learningGoal: visibleError ? 'debugging' : 'github_flow',
    selection,
    visibleError,
    codeSnippet: visibleSnippet(editor, cfg.maxCodeChars),
    codeLineCount: doc.lineCount,
  };
}

export async function buildProjectMemoryPayload(metrics: ProjectMemoryMetrics): Promise<unknown> {
  const cfg = readCoachConfig();
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  const folder = workspaceFolders[0];
  if (!folder) {throw new Error('No hay workspace abierto.');}

  const gitInfo = await detectGitInfo(workspaceFolders);
  const files = await vscode.workspace.findFiles(
    PROJECT_FILE_GLOB,
    PROJECT_EXCLUDE_GLOB,
    cfg.maxProjectFiles,
  );

  const captured = [];
  for (const uri of files) {
    const doc = await vscode.workspace.openTextDocument(uri);
    captured.push({
      path: safeRelativePath(uri),
      language: doc.languageId,
      lineCount: doc.lineCount,
      content: doc.getText().slice(0, 120000),
      capturedAt: new Date().toISOString(),
    });
  }

  return {
    workspaceKey: folder.uri.toString(),
    repoFullName: gitInfo.repoFullName || folder.name,
    branch: gitInfo.branch,
    projectLabel: vscode.workspace.name || folder.name,
    snapshot: {
      totalEntries: files.length,
      totalFiles: files.length,
      totalFolders: workspaceFolders.length,
      files: files.map((uri) => safeRelativePath(uri)),
      generatedAt: new Date().toISOString(),
    },
    files: captured,
    metrics,
    lastActivityAt: new Date().toISOString(),
  };
}
