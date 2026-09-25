import * as vscode from 'vscode';
import { buildIdentityHeaders } from './client-identity';
import {
  classifyConnectInput,
  connectInputProblem,
  ConnectOutcome,
  describeSessionStatus,
  EDITOR_SESSION_FILE_MAX_BYTES,
  EDITOR_SESSION_SECRET_KEY,
  EDITOR_UNLINKED_STORAGE_KEY,
  EditorSessionLabel,
  EditorSessionManager,
  GITHUB_AUTH_PROVIDER,
  GITHUB_SCOPES,
  HttpFetch,
  isDifferentUser,
  requestEditorClaim,
  requestSessionCheck,
  ResolvedEditorSession,
} from './editor-session';
import {
  AdaceenUriRequest,
  gitInstallHint,
  LatestLinkQueue,
  parseAdaceenUri,
  readRepoFolderMap,
  REPO_FOLDERS_STORAGE_KEY,
  REPO_PARENT_STORAGE_KEY,
  repoCloneUrl,
  repoFolderKey,
  repoFolderName,
  withoutRepoFolder,
  withRepoFolder,
} from './adaceen-uri';

/**
 * VS Code conectado a la cuenta de ADACEEN sin copiar/pegar
 * (docs/arquitectura/acceso-simplificado.md, seccion 3):
 *
 *   - barra de estado «ADACEEN: sin conectar» / «ADACEEN: <nombre>»;
 *   - comando «ADACEEN: Conectar» (GitHub de VS Code, codigo del navegador o
 *     sesion pegada) y «Configurar sesion compartida», que sigue existiendo;
 *   - enlaces vscode://adaceen.adaceen/abrir y /conectar del navegador
 *     (Mac del laboratorio): canjean el codigo y clonan o abren el repo;
 *   - lectura y vigilancia de ~/.adaceen/editor-session.json (tunel).
 *
 * El orden de resolucion, los canjes y la reaccion a sesiones invalidas estan
 * en editor-session.ts (sin vscode, con pruebas unitarias).
 */

export type EditorConnectionOptions = {
  context: vscode.ExtensionContext;
  log: (line: string) => void;
  /** Backend ya resuelto (src/backend-url.ts). */
  backendUrl: () => string;
  /** local | tunnel | codespaces | remote | web */
  editorHost: () => string;
  /** owner/repo (minusculas) del workspace abierto, si se puede detectar. */
  detectWorkspaceRepo: (folders: readonly vscode.WorkspaceFolder[]) => Promise<string | undefined>;
  /** owner/repo (minusculas) del clon que hay en esa carpeta (lee .git/config). */
  readRepoOfFolder: (folder: vscode.Uri) => Promise<string | undefined>;
  getEnv: (name: string) => string | undefined;
  /** false: no mandar en silencio el token de GitHub (baseUrl fijado por el espacio de trabajo). */
  silentGithubAllowed?: () => boolean;
};

type SessionListener = (session: ResolvedEditorSession | null, idChanged: boolean) => void;

type GitCloneApi = {
  clone?(uri: vscode.Uri, options?: { parentPath?: vscode.Uri; postCloneAction?: 'none' }): Promise<vscode.Uri | null | undefined>;
};

type GitCloneExtension = {
  enabled?: boolean;
  getAPI(version: 1): GitCloneApi;
};

/** Respaldo del watcher: el archivo del tunel se revisa cada 20 s (pesa unos bytes). */
const SESSION_FILE_POLL_MS = 20_000;
const SESSION_FILE_NAME = 'editor-session.json';

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function processPlatform() {
  return (globalThis as { process?: { platform?: string } }).process?.platform ?? '';
}

async function uriExists(uri: vscode.Uri) {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export class EditorConnection implements vscode.Disposable {
  readonly sessions: EditorSessionManager;
  private statusBar: vscode.StatusBarItem | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly listeners: SessionListener[] = [];
  private fileTimer: ReturnType<typeof setInterval> | null = null;
  private oversizedFileLogged = false;
  /** Enlaces de a uno; si llega otro mientras tanto, se atiende el ultimo (codigo vigente). */
  private readonly links = new LatestLinkQueue<vscode.Uri>(
    (uri, hasNewer) => this.processUri(uri, hasNewer),
    (replaced) => this.options.log(`[Enlace] Llego otro enlace mientras se atendia uno; se atiende al terminar${replaced ? ' (reemplaza al que esperaba)' : ''}.`),
  );

  constructor(private readonly options: EditorConnectionOptions) {
    const secrets = options.context.secrets;
    this.sessions = new EditorSessionManager({
      secrets: {
        get: () => secrets.get(EDITOR_SESSION_SECRET_KEY),
        store: (value) => secrets.store(EDITOR_SESSION_SECRET_KEY, value),
        delete: () => secrets.delete(EDITOR_SESSION_SECRET_KEY),
      },
      readSessionFile: () => this.readSessionFile(),
      readSetting: () => vscode.workspace.getConfiguration('adaceen').get<string>('backend.sessionId'),
      readEnv: () => options.getEnv('ADACEEN_SESSION_ID'),
      backendUrl: options.backendUrl,
      editorHost: options.editorHost,
      unlinkedMark: {
        get: () => options.context.globalState.get<boolean>(EDITOR_UNLINKED_STORAGE_KEY) === true,
        set: (value) => options.context.globalState.update(EDITOR_UNLINKED_STORAGE_KEY, value ? true : undefined),
      },
      silentGithubAllowed: options.silentGithubAllowed,
      // El token solo viaja al backend en el canje: no se guarda ni se registra.
      getGithubToken: async (mode) => {
        const session = await vscode.authentication.getSession(
          GITHUB_AUTH_PROVIDER,
          GITHUB_SCOPES,
          mode === 'silent' ? { silent: true } : { createIfNone: true },
        );
        return session?.accessToken || null;
      },
      claim: (kind, body, label) => requestEditorClaim(fetch as unknown as HttpFetch, {
        kind,
        baseUrl: options.backendUrl(),
        body,
        label,
        headers: buildIdentityHeaders(),
      }),
      checkSession: (sessionId) => requestSessionCheck(fetch as unknown as HttpFetch, {
        baseUrl: options.backendUrl(),
        headers: buildIdentityHeaders(sessionId),
      }),
      log: options.log,
      onDidChange: (session, idChanged) => this.handleChange(session, idChanged),
      onSessionLost: (lost) => this.warnSessionLost(lost),
    });
  }

  /** Lee SecretStorage y el archivo del tunel (antes de la primera peticion). */
  initialize() {
    return this.sessions.initialize();
  }

  /** Barra de estado, comandos, enlaces y vigilancia del archivo; luego GitHub en silencio. */
  start() {
    const { context } = this.options;
    this.disposables.push(vscode.commands.registerCommand('adaceen.connect', () => this.connect()));
    const statusBar = vscode.window.createStatusBarItem('adaceen.session', vscode.StatusBarAlignment.Right, 100);
    statusBar.name = 'ADACEEN: sesión';
    statusBar.command = 'adaceen.connect';
    this.statusBar = statusBar;
    this.renderStatus(this.sessions.current());
    statusBar.show();

    this.disposables.push(
      statusBar,
      context.secrets.onDidChange((event) => {
        // Otra ventana emparejo o se olvido la sesion.
        if (event.key === EDITOR_SESSION_SECRET_KEY) {
          void this.sessions.reloadSecret();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        // Con otro backend cambia tambien si vale la sesion emparejada (solo vale en el suyo).
        if (event.affectsConfiguration('adaceen.backend.sessionId') || event.affectsConfiguration('adaceen.backend.baseUrl')) {
          this.sessions.refresh();
        }
      }),
      // Al volver del navegador («Abrir mi editor») el tunel pudo escribir una sesion nueva.
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          void this.sessions.reloadFile();
        }
      }),
    );
    try {
      this.disposables.push(vscode.window.registerUriHandler({ handleUri: (uri) => this.handleUri(uri) }));
    } catch (error) {
      this.options.log(`[Enlace] No se pudo registrar el manejador de enlaces: ${errorText(error)}`);
    }
    this.watchSessionFile();
    void this.sessions.startup();
    void this.rememberWorkspaceRepo();
  }

  onDidChangeSession(listener: SessionListener) {
    this.listeners.push(listener);
  }

  /** «ADACEEN: Configurar sesion compartida»: acepta un codigo o el UUID de antes. */
  promptLegacySession() {
    return this.promptForCode('legacy');
  }

  /** Mensaje para quien quiere sincronizar con el navegador y no esta conectado. */
  warnNotConnected(action: string) {
    void vscode.window.showWarningMessage(`ADACEEN: conecta VS Code con tu cuenta para ${action}.`, 'Conectar').then((choice) => {
      if (choice) {
        void this.connect();
      }
    });
  }

  dispose() {
    if (this.fileTimer) {
      clearInterval(this.fileTimer);
      this.fileTimer = null;
    }
    for (const disposable of this.disposables.splice(0)) {
      try {
        disposable.dispose();
      } catch {
        // Nada que hacer al cerrar.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Archivo del tunel

  /** ~/.adaceen; null en la extension web (sin disco ni HOME). */
  private sessionFolderUri(): vscode.Uri | null {
    const { getEnv } = this.options;
    const home = processPlatform() === 'win32'
      ? getEnv('USERPROFILE') || getEnv('HOME')
      : getEnv('HOME') || getEnv('USERPROFILE');
    if (!home) {
      return null;
    }
    return vscode.Uri.joinPath(vscode.Uri.file(home), '.adaceen');
  }

  private async readSessionFile(): Promise<string | null> {
    const folder = this.sessionFolderUri();
    if (!folder) {
      return null;
    }
    const uri = vscode.Uri.joinPath(folder, SESSION_FILE_NAME);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > EDITOR_SESSION_FILE_MAX_BYTES) {
        if (!this.oversizedFileLogged) {
          this.oversizedFileLogged = true;
          this.options.log('[Sesion] Se ignora ~/.adaceen/editor-session.json: demasiado grande.');
        }
        return null;
      }
      return new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return null;
    }
  }

  private watchSessionFile() {
    // Revision periodica tambien sin disco (web): detecta la sesion que vence
    // con la ventana abierta. Con disco es ademas el respaldo del watcher, que
    // no siempre avisa si ~/.adaceen aun no existe.
    this.fileTimer = setInterval(() => {
      void this.sessions.poll();
    }, SESSION_FILE_POLL_MS);
    const folder = this.sessionFolderUri();
    if (!folder) {
      return;
    }
    const reload = () => {
      void this.sessions.reloadFile();
    };
    try {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, SESSION_FILE_NAME));
      this.disposables.push(watcher, watcher.onDidCreate(reload), watcher.onDidChange(reload), watcher.onDidDelete(reload));
    } catch (error) {
      this.options.log(`[Sesion] Sin watcher para el archivo de sesion (queda la revision periodica): ${errorText(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Barra de estado y avisos

  private handleChange(session: ResolvedEditorSession | null, idChanged: boolean) {
    this.renderStatus(session);
    for (const listener of this.listeners) {
      try {
        listener(session, idChanged);
      } catch {
        // Un oyente roto no debe tumbar a los demas.
      }
    }
  }

  private renderStatus(session: ResolvedEditorSession | null) {
    if (!this.statusBar) {
      return;
    }
    const status = describeSessionStatus(session);
    this.statusBar.text = status.text;
    this.statusBar.tooltip = status.tooltip;
    this.statusBar.backgroundColor = status.connected
      ? undefined
      : new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  private warnSessionLost(lost: ResolvedEditorSession | null) {
    // En el tunel la sesion la escribe la VM: basta con volver a «Abrir mi editor».
    const fromTunnel = lost?.source === 'file';
    void vscode.window.showWarningMessage(
      fromTunnel
        ? 'ADACEEN: tu sesión dejó de valer (por ejemplo, cerraste sesión en el navegador). Vuelve a pulsar «Abrir mi editor» en el navegador para que tus sugerencias y métricas queden a tu nombre.'
        : 'ADACEEN: tu sesión dejó de valer (por ejemplo, cerraste sesión en el navegador). Conecta de nuevo para que tus sugerencias y métricas queden a tu nombre.',
      'Conectar',
    ).then((choice) => {
      if (choice) {
        void this.connect();
      }
    });
  }

  // -------------------------------------------------------------------------
  // «ADACEEN: Conectar»

  async connect() {
    type ConnectItem = vscode.QuickPickItem & { id: 'github' | 'code' | 'paste' | 'disconnect' };
    const items: ConnectItem[] = [
      {
        id: 'github',
        label: '$(github) Con mi cuenta de GitHub (recomendado)',
        detail: 'Un clic en «Permitir». Usa la cuenta de GitHub que conectaste en ADACEEN.',
      },
      {
        id: 'code',
        label: '$(key) Tengo un código del navegador',
        detail: 'El código XXXX-XXXX que muestra el overlay de ADACEEN (dura 10 minutos).',
      },
      {
        id: 'paste',
        label: '$(clippy) Pegar sesión',
        detail: 'El ID de sesión que copia el overlay del navegador.',
      },
    ];
    const current = this.sessions.current();
    const name = current ? current.userName || current.userEmail : '';
    if (current?.source === 'secret') {
      items.push({
        id: 'disconnect',
        label: '$(debug-disconnect) Desconectar este equipo',
        detail: 'Olvida la sesión guardada en VS Code (por ejemplo, en un equipo compartido o si no eres tú).',
      });
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: 'ADACEEN: Conectar',
      placeHolder: current
        ? `Conectado${name ? ` como ${name}` : ''}. Elige cómo conectar otra cuenta.`
        : 'Elige cómo conectar VS Code con tu cuenta de ADACEEN',
      ignoreFocusOut: true,
    });
    if (!pick) {
      return;
    }
    if (pick.id === 'github') {
      await this.connectWithGithub();
      return;
    }
    if (pick.id === 'disconnect') {
      await this.disconnect();
      return;
    }
    await this.promptForCode(pick.id);
  }

  /** Olvida la sesion emparejada y dice si queda otra (tunel o ajuste heredado). */
  async disconnect() {
    const remaining = await this.sessions.disconnect();
    const name = remaining ? remaining.userName || remaining.userEmail : '';
    void vscode.window.showInformationMessage(remaining
      ? `ADACEEN: se olvidó la sesión guardada en este equipo. Sigue la sesión del ${remaining.source === 'file' ? 'túnel' : 'ajuste heredado'}${name ? ` (${name})` : ''}.`
      : 'ADACEEN: VS Code quedó desconectado en este equipo.');
  }

  private async connectWithGithub() {
    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'ADACEEN: conectando con tu cuenta de GitHub…' },
      () => this.sessions.connectWithGithub('interactive'),
    );
    this.reportOutcome(outcome, false, () => this.connectWithGithub());
  }

  private async promptForCode(mode: 'code' | 'paste' | 'legacy') {
    const titles = {
      code: 'ADACEEN: Tengo un código del navegador',
      paste: 'ADACEEN: Pegar sesión',
      legacy: 'ADACEEN: Configurar sesión compartida',
    };
    const value = await vscode.window.showInputBox({
      title: titles[mode],
      prompt: mode === 'code'
        ? 'Escribe el código de 8 caracteres que muestra el navegador (por ejemplo K7P4-M2QX).'
        : 'Pega el ID de sesión copiado del overlay del navegador (o un código XXXX-XXXX).',
      placeHolder: mode === 'code' ? 'XXXX-XXXX' : 'Código XXXX-XXXX o ID de sesión',
      ignoreFocusOut: true,
      validateInput: (text) => connectInputProblem(text),
    });
    if (value === undefined) {
      return;
    }
    const input = classifyConnectInput(value);
    if (input.kind !== 'code' && input.kind !== 'session') {
      return;
    }
    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'ADACEEN: conectando VS Code con tu cuenta…' },
      () => input.kind === 'code'
        ? this.sessions.connectWithCode(input.code, 'codigo')
        : this.sessions.connectWithSessionId(input.sessionId),
    );
    this.reportOutcome(outcome, mode === 'legacy');
  }

  private reportOutcome(outcome: ConnectOutcome, legacy: boolean, retry?: () => Promise<void>) {
    if (outcome.ok) {
      const name = outcome.session.userName || outcome.session.userEmail;
      const connected = name ? `Conectado como ${name}.` : 'VS Code quedó conectado.';
      void vscode.window.showInformationMessage(
        legacy ? `ADACEEN: sesión compartida configurada. ${connected}` : `ADACEEN: ${connected}`,
      );
      return;
    }
    if (outcome.error === 'cancelled') {
      return;
    }
    const actions = retry ? ['Reintentar', 'Conectar de otra forma'] : ['Conectar de otra forma'];
    void vscode.window.showWarningMessage(`ADACEEN: no se pudo conectar. ${outcome.message}`, ...actions).then((choice) => {
      if (choice === 'Reintentar' && retry) {
        void retry();
      } else if (choice) {
        void this.connect();
      }
    });
  }

  // -------------------------------------------------------------------------
  // vscode://adaceen.adaceen/abrir y /conectar

  handleUri(uri: vscode.Uri) {
    return this.links.push(uri);
  }

  /**
   * Un enlace del navegador. Mientras dura (canje, carpeta, clonado) los
   * enlaces nuevos esperan en la cola; los avisos que no bloquean no la retienen.
   */
  private async processUri(uri: vscode.Uri, hasNewer: () => boolean) {
    const backendUrl = this.options.backendUrl();
    const request = parseAdaceenUri({ path: uri.path, query: uri.query }, backendUrl);
    if (!request.action) {
      this.options.log(`[Enlace] Ruta desconocida: ${uri.path}`);
      void vscode.window.showWarningMessage('ADACEEN: el enlace no es válido. Vuelve a pulsar el botón del navegador.');
      return;
    }
    try {
      // Nunca se registra el codigo.
      this.options.log(`[Enlace] ${request.action}${request.repo ? ` ${request.repo}` : ''}${request.code ? ' (con codigo)' : ''}`);
      if (request.ignoredBackend) {
        this.options.log(`[Enlace] Se ignora el backend del enlace (${request.ignoredBackend}); se usa ${backendUrl}.`);
      }
      if (request.code) {
        const handled = await this.claimFromLink(request, backendUrl, hasNewer);
        if (!handled) {
          // Llego un enlace mas nuevo (otro clic): trae el codigo vigente y el repo que toca.
          this.options.log('[Enlace] Llego un enlace mas reciente; se atiende ese.');
          return;
        }
      } else if (request.codeInvalid) {
        this.warnWithConnect('ADACEEN: el código del enlace no tiene el formato XXXX-XXXX. Pide uno nuevo en el navegador.');
      } else if (request.action === 'conectar') {
        void this.connect();
      }
      if (request.action === 'abrir') {
        if (request.repo) {
          await this.openRepo(request.repo);
        } else if (request.repoInvalid) {
          void vscode.window.showWarningMessage('ADACEEN: el enlace no trae un repositorio de GitHub válido (owner/repo).');
        }
      }
    } catch (error) {
      this.options.log(`[Enlace] Error: ${errorText(error)}`);
      void vscode.window.showErrorMessage(`ADACEEN: no se pudo completar el enlace. ${errorText(error)}`);
    }
  }

  private warnWithConnect(message: string) {
    void vscode.window.showWarningMessage(message, 'Conectar').then((choice) => {
      if (choice) {
        void this.connect();
      }
    });
  }

  /** false: llego un enlace mas nuevo mientras se canjeaba (se deja este a medias). */
  private async claimFromLink(request: AdaceenUriRequest, backendUrl: string, hasNewer: () => boolean) {
    const label: EditorSessionLabel = this.options.editorHost() === 'local' ? 'vscode-local' : 'codigo';
    const before = this.sessions.current();
    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'ADACEEN: conectando VS Code con tu cuenta…' },
      () => this.sessions.connectWithCode(request.code || '', label),
    );
    if (hasNewer()) {
      // El codigo de este enlace pudo quedar invalidado por el del siguiente: sin avisos.
      return false;
    }
    if (outcome.ok) {
      const name = outcome.session.userName || outcome.session.userEmail;
      if (isDifferentUser(before, outcome.session)) {
        // Reemplazo la cuenta de otra persona: en un equipo compartido es normal,
        // pero un enlace ajeno tambien podria vincular este VS Code a otra cuenta.
        const previous = before?.userName || before?.userEmail || 'otra cuenta';
        void vscode.window.showWarningMessage(
          `ADACEEN: VS Code quedó conectado como ${name || 'otra cuenta'} (antes: ${previous}). ¿No eres tú? Desconecta y vuelve a pulsar el botón del navegador.`,
          'Desconectar',
        ).then((choice) => {
          if (choice) {
            void this.disconnect();
          }
        });
        return true;
      }
      void vscode.window.showInformationMessage(`ADACEEN: VS Code quedó conectado${name ? ` como ${name}` : ''}.`);
      return true;
    }
    let message = `ADACEEN: no se pudo conectar VS Code. ${outcome.message}`;
    if (outcome.error === 'code_not_found') {
      if (request.ignoredBackend) {
        message += ` El enlace venía de ${request.ignoredBackend} y esta extensión usa ${backendUrl}.`;
      } else if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(backendUrl)) {
        // Mac con el backend local encendido: el codigo del navegador es de produccion.
        message += ` VS Code está usando el backend local de este equipo (${backendUrl}).`;
      }
    }
    // Sin esperar: el repositorio se abre igual.
    this.warnWithConnect(message);
    return true;
  }

  // -------------------------------------------------------------------------
  // Clonar o abrir el repositorio del estudiante

  private get globalState() {
    return this.options.context.globalState;
  }

  private async rememberFolder(repo: string, folder: vscode.Uri) {
    const map = readRepoFolderMap(this.globalState.get(REPO_FOLDERS_STORAGE_KEY));
    await this.globalState.update(REPO_FOLDERS_STORAGE_KEY, withRepoFolder(map, repo, folder.toString()));
  }

  /** VS Code abierto a mano en un clon: queda recordado para el boton del navegador. */
  private async rememberWorkspaceRepo() {
    try {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length !== 1 || folders[0].uri.scheme !== 'file') {
        return;
      }
      const repo = await this.options.detectWorkspaceRepo(folders);
      if (repo) {
        await this.rememberFolder(repo, folders[0].uri);
      }
    } catch {
      // Solo es un atajo para despues.
    }
  }

  /** La carpeta tiene .git y (si se puede leer) su origin es ese repo. */
  private async isCloneOf(folder: vscode.Uri, repo: string) {
    if (!(await uriExists(vscode.Uri.joinPath(folder, '.git')))) {
      return false;
    }
    const origin = await this.options.readRepoOfFolder(folder).catch(() => undefined);
    return !origin || origin.toLowerCase() === repoFolderKey(repo);
  }

  private async openFolder(repo: string, folder: vscode.Uri) {
    await this.rememberFolder(repo, folder);
    // Con otro proyecto abierto, ventana nueva; con la ventana vacia, en esta.
    const forceNewWindow = Boolean(vscode.workspace.workspaceFolders?.length);
    this.options.log(`[Enlace] Abriendo ${repo}${forceNewWindow ? ' en una ventana nueva' : ''}.`);
    await vscode.commands.executeCommand('vscode.openFolder', folder, { forceNewWindow });
  }

  private async openRepo(repo: string): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length) {
      const current = await this.options.detectWorkspaceRepo(folders).catch(() => undefined);
      if (current && current.toLowerCase() === repoFolderKey(repo)) {
        if (folders[0].uri.scheme === 'file') {
          await this.rememberFolder(repo, folders[0].uri);
        }
        void vscode.window.showInformationMessage(`ADACEEN: ya tienes abierto ${repo}.`);
        return;
      }
    }

    const map = readRepoFolderMap(this.globalState.get(REPO_FOLDERS_STORAGE_KEY));
    const known = map[repoFolderKey(repo)];
    if (known) {
      let knownUri: vscode.Uri | null = null;
      try {
        knownUri = vscode.Uri.parse(known, true);
      } catch {
        knownUri = null;
      }
      if (knownUri && await this.isCloneOf(knownUri, repo)) {
        await this.openFolder(repo, knownUri);
        return;
      }
      // La carpeta recordada ya no esta (se borro o se movio): se clona de nuevo.
      await this.globalState.update(REPO_FOLDERS_STORAGE_KEY, withoutRepoFolder(map, repo));
    }

    if (vscode.env.uiKind === vscode.UIKind.Web && !vscode.env.remoteName) {
      void vscode.window.showWarningMessage(`ADACEEN: para clonar ${repo} abre el enlace en VS Code de escritorio.`);
      return;
    }

    const git = await this.gitApi();
    if (!git) {
      await this.explainMissingGit(repo);
      return;
    }

    const parent = await this.pickParentFolder(repo);
    if (!parent) {
      return;
    }
    const target = vscode.Uri.joinPath(parent, repoFolderName(repo));
    if (await uriExists(target)) {
      if (await this.isCloneOf(target, repo)) {
        await this.openFolder(repo, target);
        return;
      }
      // Sin esperar la respuesta: un aviso olvidado no debe retener los enlaces siguientes.
      const again = 'Elegir otra carpeta';
      void vscode.window.showWarningMessage(
        `ADACEEN: ya existe ${target.fsPath || target.path} y no es un clon de ${repo}. Elige otra ubicación.`,
        again,
      ).then((choice) => {
        if (choice === again) {
          void this.openRepo(repo).catch((error) => {
            this.options.log(`[Enlace] Error: ${errorText(error)}`);
          });
        }
      });
      return;
    }

    let result: { folder: vscode.Uri | null; openedByGit: boolean };
    try {
      result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `ADACEEN: clonando ${repo}…` },
        () => this.cloneRepo(git, repo, parent, target),
      );
    } catch (error) {
      this.options.log(`[Enlace] No se pudo clonar ${repo}: ${errorText(error)}`);
      void vscode.window.showErrorMessage(`ADACEEN: no se pudo clonar ${repo}. ${errorText(error)}`);
      return;
    }
    if (!result.folder) {
      return;
    }
    if (result.openedByGit) {
      await this.rememberFolder(repo, result.folder);
      return;
    }
    await this.openFolder(repo, result.folder);
  }

  private async cloneRepo(git: GitCloneApi, repo: string, parent: vscode.Uri, target: vscode.Uri) {
    const url = repoCloneUrl(repo);
    if (typeof git.clone === 'function') {
      const cloned = await git.clone(vscode.Uri.parse(url), { parentPath: parent, postCloneAction: 'none' });
      return { folder: cloned || ((await uriExists(target)) ? target : null), openedByGit: false };
    }
    // VS Code sin clone en la API de git: el comando pregunta el mismo si abrir el clon.
    await vscode.commands.executeCommand('git.clone', url, parent.fsPath);
    return { folder: (await uriExists(target)) ? target : null, openedByGit: true };
  }

  private async gitApi(): Promise<GitCloneApi | null> {
    try {
      const extension = vscode.extensions.getExtension<GitCloneExtension>('vscode.git');
      if (!extension) {
        return null;
      }
      const exports = extension.isActive ? extension.exports : await extension.activate();
      // enabled=false: git no esta instalado (o git.enabled esta en false).
      if (!exports || exports.enabled === false || typeof exports.getAPI !== 'function') {
        return null;
      }
      return exports.getAPI(1);
    } catch {
      return null;
    }
  }

  private async explainMissingGit(repo: string) {
    if (vscode.workspace.getConfiguration('git').get<boolean>('enabled') === false) {
      void vscode.window.showWarningMessage(
        `ADACEEN: para clonar ${repo} hace falta la integración de git de VS Code, que está desactivada (ajuste git.enabled).`,
      );
      return;
    }
    const hint = gitInstallHint(processPlatform());
    this.options.log(`[Enlace] git no esta disponible; se ofrece: ${hint.command}`);
    const install = 'Instalar git';
    const download = 'Descargar git';
    const copy = 'Copiar comando';
    // Sin esperar la respuesta: un aviso olvidado no debe retener los enlaces siguientes.
    void vscode.window.showWarningMessage(
      `ADACEEN: para clonar ${repo} hace falta git y no está instalado en este equipo. ${hint.explanation} Cuando termine, cierra y abre VS Code y vuelve a pulsar el botón del navegador.`,
      install,
      download,
      copy,
    ).then(async (choice) => {
      if (choice === install) {
        const terminal = vscode.window.createTerminal({ name: 'ADACEEN: instalar git' });
        terminal.show();
        terminal.sendText(hint.command, true);
      } else if (choice === download) {
        void vscode.env.openExternal(vscode.Uri.parse(hint.downloadUrl));
      } else if (choice === copy) {
        try {
          await vscode.env.clipboard.writeText(hint.command);
          void vscode.window.showInformationMessage(`ADACEEN: comando copiado: ${hint.command}`);
        } catch {
          void vscode.window.showInformationMessage(`ADACEEN: ejecuta en una terminal: ${hint.command}`);
        }
      }
    });
  }

  private async pickParentFolder(repo: string) {
    const last = this.globalState.get<string>(REPO_PARENT_STORAGE_KEY);
    let defaultUri: vscode.Uri | undefined;
    try {
      defaultUri = last ? vscode.Uri.parse(last, true) : undefined;
    } catch {
      defaultUri = undefined;
    }
    if (!defaultUri) {
      const home = this.sessionFolderUri();
      defaultUri = home ? vscode.Uri.joinPath(home, '..') : undefined;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Clonar aquí',
      title: `ADACEEN: elige la carpeta donde se guardará ${repo}`,
      defaultUri,
    });
    const parent = picked?.[0];
    if (!parent) {
      return null;
    }
    await this.globalState.update(REPO_PARENT_STORAGE_KEY, parent.toString());
    return parent;
  }
}
