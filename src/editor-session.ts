/**
 * Sesion de ADACEEN en VS Code (docs/arquitectura/acceso-simplificado.md, seccion 3).
 *
 * La sesion que viaja en x-session-id sale de, en este orden:
 *
 *   1. SecretStorage adaceen.editorSession: la sesion emparejada en este
 *      equipo (cuenta de GitHub de VS Code, codigo del navegador o ID de
 *      sesion pegado). Nunca va en settings y el token de GitHub no se guarda.
 *   2. ~/.adaceen/editor-session.json: lo escribe la VM de editores (tunel)
 *      cada vez que el estudiante prepara su editor. Solo existe en el host
 *      Node de la extension; la extension web no tiene disco.
 *   3. Ajuste heredado adaceen.backend.sessionId y variable ADACEEN_SESSION_ID
 *      («Configurar sesion compartida» sigue en la paleta: abre la misma caja
 *      que «Tengo un codigo o sesion» y guarda en SecretStorage).
 *
 * La sesion emparejada solo se usa con el backend donde se obtuvo. En el
 * tunel, un archivo escrito despues de guardarla gana (la VM es del estudiante).
 *
 * Sin sesion, al arrancar se intenta, en silencio, canjear la cuenta de GitHub
 * que VS Code ya tiene (POST /api/auth/editor/github): cero clics si la
 * extension ya tenia permiso. Cuando el backend responde x-adaceen-session:
 * invalid se olvida esa sesion, se relee el archivo y, si no queda ninguna, se
 * avisa una sola vez por ventana (boton Conectar). Tras un rechazo (o
 * «Desconectar») no se vuelve a conectar en silencio con GitHub hasta una
 * conexion hecha a mano: en un equipo compartido esa cuenta puede ser de otro.
 *
 * No importa vscode: SecretStorage, el archivo, GitHub y el backend llegan
 * como dependencias, para probar todo con node:test. Nada de aqui escribe en
 * el log ids de sesion, codigos ni tokens.
 *
 * Aqui queda EditorSessionManager; el registro y que sesion se usa estan en
 * editor-session-records.ts, lo que se escribe al conectar en
 * editor-session-input.ts y el canje con el backend en editor-session-claim.ts.
 */

import type { PairingEditorHost } from './backend-url';
import { describeClaimError } from './editor-session-claim';
import type { EditorClaimError, EditorClaimKind, EditorClaimResult, SessionCheck } from './editor-session-claim';
import { normalizePairingCode } from './editor-session-input';
import { cleanBackendUrl, describeSessionDocumentProblem, describeSessionOrigin, isSafeSessionId, isSessionExpired, parseEditorSessionFile, parseStoredEditorSession, resolveEditorSession, sameBackendUrl, serializeStoredEditorSession } from './editor-session-records';
import type { EditorSessionLabel, EditorSessionRecord, ResolvedEditorSession } from './editor-session-records';

// La API de antes de partir el archivo se sigue exportando desde aqui: el backend (PDC) importa
// este modulo por ruta en sus pruebas de contrato, y otros modulos pueden seguir usandolo igual.
export { EDITOR_SESSION_FILE_MAX_BYTES, EDITOR_SESSION_FILE_VERSION, SESSION_STATUS_UNCONNECTED_TEXT, describeSessionDocumentProblem, describeSessionOrigin, describeSessionStatus, isDifferentUser, isLegacySessionUuid, isSafeSessionId, isSessionExpired, normalizeBackendUrl, parseEditorSessionFile, parseStoredEditorSession, resolveEditorSession, sameBackendUrl, serializeStoredEditorSession } from './editor-session-records';
export type { EditorSessionCandidates, EditorSessionLabel, EditorSessionRecord, EditorSessionSource, ParsedSessionDocument, ResolveEditorSessionOptions, ResolvedEditorSession, SessionDocumentProblem } from './editor-session-records';
export { EDITOR_CLAIM_PATHS, SESSION_CHECK_PATH, describeClaimError, interpretClaimResponse, interpretSessionCheck, requestEditorClaim, requestSessionCheck } from './editor-session-claim';
export type { EditorClaimError, EditorClaimKind, EditorClaimResult, HttpFetch, SessionCheck } from './editor-session-claim';
export { CONNECT_CODE_CHOICE, CONNECT_CODE_PROMPT, PAIRING_CODE_ALPHABET, SESSION_LOST_ACTION, classifyConnectInput, connectChoices, connectFailureActions, connectInputProblem, normalizePairingCode, sessionLostWarning } from './editor-session-input';
export type { ConnectChoice, ConnectChoiceId, ConnectInput } from './editor-session-input';

export const EDITOR_SESSION_SECRET_KEY = 'adaceen.editorSession';
export const GITHUB_AUTH_PROVIDER = 'github';
export const GITHUB_SCOPES = ['read:user'];
/**
 * Marca en globalState: en este equipo se cerro sesion (el backend rechazo la
 * sesion) o se pulso «Desconectar». Mientras exista no hay GitHub en silencio.
 */
export const EDITOR_UNLINKED_STORAGE_KEY = 'adaceen.editorSession.desvinculado';

const SECRET_READ_TIMEOUT_MS = 3000;
// ---------------------------------------------------------------------------
// Estado de la sesion en esta ventana

/** superseded: un canje silencioso que termino despues de una conexion hecha a mano (se descarta). */
export type ConnectFailure = EditorClaimError | 'cancelled' | 'no_github' | 'invalid_session' | 'superseded';

export type ConnectOutcome =
  | { ok: true; session: ResolvedEditorSession }
  | { ok: false; error: ConnectFailure; message: string };

export type EditorSessionManagerDeps = {
  /** SecretStorage, solo la clave adaceen.editorSession. */
  secrets: {
    get(): PromiseLike<string | undefined>;
    store(value: string): PromiseLike<void>;
    delete(): PromiseLike<void>;
  };
  /** Texto de ~/.adaceen/editor-session.json; null si no existe o no hay disco (web). */
  readSessionFile(): Promise<string | null>;
  readSetting(): string | undefined;
  readEnv(): string | undefined;
  /** Backend ya resuelto (src/backend-url.ts). */
  backendUrl(): string;
  /** local | tunnel | codespaces | remote | web (editorHost del canje, pairingEditorHost). */
  editorHost(): PairingEditorHost;
  /**
   * Token de GitHub de VS Code: silent no pregunta nada; interactive muestra
   * «Permitir». null si no hay cuenta o el estudiante cancela. No se guarda.
   */
  getGithubToken(mode: 'silent' | 'interactive'): Promise<string | null>;
  claim(kind: EditorClaimKind, body: Record<string, unknown>, label: EditorSessionLabel): Promise<EditorClaimResult>;
  /** GET /api/auth/me (opcional): nombre del estudiante y sesiones muertas al arrancar. */
  checkSession?(sessionId: string): Promise<SessionCheck>;
  /**
   * Marca EDITOR_UNLINKED_STORAGE_KEY (globalState, compartida por las
   * ventanas del equipo). Sin ella, siempre se permite GitHub en silencio.
   */
  unlinkedMark?: {
    get(): boolean;
    set(value: boolean): PromiseLike<void> | void;
  };
  /**
   * false: no mandar en silencio el token de GitHub (adaceen.backend.baseUrl
   * lo fija el espacio de trabajo abierto, que puede ser un repo ajeno).
   */
  silentGithubAllowed?(): boolean;
  /** Espera maxima a SecretStorage antes de seguir sin la sesion guardada (pruebas). */
  secretReadTimeoutMs?: number;
  now?(): number;
  log?(line: string): void;
  /** Cambio la sesion resuelta; idChanged = cambio el x-session-id que se envia. */
  onDidChange?(session: ResolvedEditorSession | null, idChanged: boolean): void;
  /**
   * La sesion dejo de valer (rechazada o vencida) y no queda otra (a lo sumo
   * una vez por ventana). lost: la que se perdio.
   */
  onSessionLost?(lost: ResolvedEditorSession | null): void;
};

class SecretReadTimeout extends Error {}

/** Rechaza con SecretReadTimeout si la promesa no termina en `ms`. */
function withTimeout<T>(promise: PromiseLike<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SecretReadTimeout(message)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class EditorSessionManager {
  private secret: EditorSessionRecord | null = null;
  private secretSavedAt: number | null = null;
  private file: EditorSessionRecord | null = null;
  private fileWrittenAt: number | null = null;
  private lastFileText: string | null | undefined = undefined;
  /** Sesiones que el backend rechazo en esta ventana (solo en memoria). */
  private readonly ignored = new Set<string>();
  /** Nombre aprendido con /api/auth/me para sesiones que no lo traen. */
  private readonly names = new Map<string, { userName: string; userEmail: string }>();
  private readonly checked = new Set<string>();
  private recovering: Promise<void> | null = null;
  private lostWarned = false;
  private lastEmitted: { id: string; key: string; session: ResolvedEditorSession | null } | null = null;
  /**
   * Sube con cada conexion hecha a mano y con «Desconectar»: un canje
   * silencioso con GitHub que termina despues se descarta, no pisa esa sesion.
   */
  private explicitGeneration = 0;
  /**
   * Lecturas de SecretStorage iniciadas y cambios hechos aqui a la sesion
   * guardada: solo se aplica la lectura mas reciente, y no si mientras tanto
   * se conecto o se olvido la sesion en esta ventana.
   */
  private secretReads = 0;
  private secretWrites = 0;
  /** Lectura de SecretStorage que no contesto a tiempo; se aplica cuando conteste. */
  private secretPending: Promise<void> | null = null;

  constructor(private readonly deps: EditorSessionManagerDeps) {}

  private now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private log(line: string) {
    try {
      this.deps.log?.(line);
    } catch {
      // Canal cerrado: se descarta la linea.
    }
  }

  /** Lee SecretStorage y el archivo del tunel. Nunca lanza. */
  async initialize() {
    await Promise.all([this.reloadSecret(false), this.reloadFile(false)]);
    const session = this.current();
    this.log(session
      ? `[Sesion] Sesion desde ${describeSessionOrigin(session)}.`
      : '[Sesion] Sin sesion guardada en este equipo.');
    this.emitIfChanged();
  }

  /** Sesion resuelta ahora mismo (sincrono: la usan todas las peticiones). */
  current(): ResolvedEditorSession | null {
    let setting: string | undefined;
    let env: string | undefined;
    try {
      setting = this.deps.readSetting();
      env = this.deps.readEnv();
    } catch {
      setting = undefined;
    }
    let backendUrl = '';
    let preferNewerFile = false;
    try {
      backendUrl = this.deps.backendUrl();
      preferNewerFile = this.deps.editorHost() === 'tunnel';
    } catch {
      // Sin backend resuelto no se filtra por backend.
    }
    const session = resolveEditorSession(
      {
        secret: this.secret,
        secretSavedAt: this.secretSavedAt,
        file: this.file,
        fileWrittenAt: this.fileWrittenAt,
        setting,
        env,
      },
      { ignored: this.ignored, now: this.now(), backendUrl, preferNewerFile },
    );
    if (!session) {
      return null;
    }
    const known = this.names.get(session.sessionId);
    if (known && !session.userName && !session.userEmail) {
      return { ...session, ...known };
    }
    return session;
  }

  currentSessionId() {
    return this.current()?.sessionId ?? '';
  }

  /** Avisa a quien escucha si cambio la sesion (ajuste editado, otro backend...). */
  refresh() {
    this.emitIfChanged();
  }

  async reloadSecret(emit = true) {
    const read = ++this.secretReads;
    const writes = this.secretWrites;
    let pending: Promise<string | undefined> | null = null;
    let text: string | undefined;
    try {
      pending = Promise.resolve(this.deps.secrets.get());
      text = await withTimeout(pending, this.deps.secretReadTimeoutMs ?? SECRET_READ_TIMEOUT_MS, 'SecretStorage no respondio');
    } catch (error) {
      // Sin llavero se sigue con lo que habia en memoria.
      this.log(`[Sesion] No se pudo leer la sesion guardada: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof SecretReadTimeout && pending) {
        // Llavero lento (Mac tras actualizar, gnome-keyring colgado): la sesion
        // guardada se aplica cuando conteste, en vez de ignorarla toda la ventana.
        const late: Promise<void> = pending.then(
          (value) => this.applySecret(value, read, writes, true),
          () => undefined,
        ).catch(() => undefined).finally(() => {
          if (this.secretPending === late) {
            this.secretPending = null;
          }
        });
        this.secretPending = late;
      }
      return;
    }
    await this.applySecret(text, read, writes, emit);
  }

  private async applySecret(text: string | undefined, read: number, writes: number, emit: boolean) {
    if (read !== this.secretReads || writes !== this.secretWrites) {
      // Una lectura mas reciente o una conexion hecha aqui ya decidieron.
      return;
    }
    if (!text) {
      this.secret = null;
      this.secretSavedAt = null;
    } else {
      const parsed = parseStoredEditorSession(text, this.now());
      this.secret = parsed.ok ? parsed.session : null;
      this.secretSavedAt = parsed.ok ? parsed.writtenAt : null;
      if (!parsed.ok) {
        this.log(`[Sesion] Se descarta la sesion guardada: ${describeSessionDocumentProblem(parsed.problem)}.`);
        await this.deleteSecretQuietly();
      }
    }
    if (emit) {
      this.emitIfChanged();
    }
  }

  /** Relee ~/.adaceen/editor-session.json. true si su contenido cambio. */
  async reloadFile(emit = true) {
    let text: string | null;
    try {
      text = await this.deps.readSessionFile();
    } catch {
      text = null;
    }
    if (text === this.lastFileText) {
      return false;
    }
    const hadFile = Boolean(this.file);
    this.lastFileText = text;
    if (text === null) {
      this.file = null;
      this.fileWrittenAt = null;
      if (hadFile) {
        this.log('[Sesion] Ya no esta el archivo de sesion del tunel.');
      }
    } else {
      const parsed = parseEditorSessionFile(text, this.now());
      this.file = parsed.ok ? parsed.session : null;
      this.fileWrittenAt = parsed.ok ? parsed.writtenAt : null;
      if (parsed.ok) {
        const note = this.ignored.has(parsed.session.sessionId) ? ' (es la que el backend ya rechazo)' : '';
        this.log(`[Sesion] Archivo de sesion del tunel leido${note}.`);
      } else {
        this.log(`[Sesion] Se ignora ~/.adaceen/editor-session.json: ${describeSessionDocumentProblem(parsed.problem)}.`);
      }
    }
    if (emit) {
      this.emitIfChanged();
    }
    return true;
  }

  /**
   * Revision periodica (cada 20 s): relee el archivo del tunel y detecta la
   * sesion que vence con la ventana abierta. Esa deja de enviarse sin que el
   * backend la rechace, asi que nadie mas avisaria. Nunca lanza.
   */
  async poll() {
    try {
      const before = this.lastEmitted?.session ?? null;
      await this.reloadFile();
      if (!before || !isSessionExpired(before, this.now())) {
        return;
      }
      this.emitIfChanged();
      const remaining = this.current();
      if (remaining?.sessionId === before.sessionId) {
        return;
      }
      this.log(`[Sesion] Vencio la sesion (${describeSessionOrigin(before)}).`);
      if (!remaining) {
        this.notifyLost(before);
      }
    } catch (error) {
      this.log(`[Sesion] Error al revisar la sesion: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Tras activar: comprueba la sesion que hay (nombre y si sigue viva) o, sin
   * sesion, intenta GitHub en silencio. Nunca lanza.
   */
  async startup() {
    try {
      let session = this.current();
      if (!session && this.secretPending) {
        // Sin la respuesta del llavero no se sabe si hay sesion: no se conecta otra encima.
        this.log('[Sesion] Esperando al llavero de VS Code antes de conectar.');
        await this.secretPending;
        session = this.current();
      }
      if (session) {
        await this.verify(session);
        return;
      }
      if (this.isUnlinked()) {
        this.log('[Sesion] Sin conectar: en este equipo se cerro sesion o se desconecto VS Code. Usa «ADACEEN: Conectar» (barra de estado) o el boton del navegador.');
        return;
      }
      if (!(await this.trySilentGithub())) {
        this.log('[Sesion] Sin conectar: usa «ADACEEN: Conectar» (barra de estado) para que tus eventos queden a tu nombre.');
      }
    } catch (error) {
      this.log(`[Sesion] Error al revisar la sesion: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Espera a que termine una recuperacion en curso (pruebas y comandos). */
  async whenIdle() {
    while (this.recovering) {
      await this.recovering;
    }
  }

  /**
   * El backend respondio x-adaceen-session: invalid a una peticion que llevaba
   * esta sesion. Solo reacciona si es la sesion en uso; las repetidas (varias
   * peticiones en vuelo con la misma sesion) se ignoran.
   */
  reportInvalid(sessionId: string) {
    const clean = String(sessionId || '').trim();
    if (!clean || this.ignored.has(clean)) {
      return;
    }
    const lost = this.current();
    this.ignored.add(clean);
    if (!lost || lost.sessionId !== clean) {
      this.emitIfChanged();
      return;
    }
    const previous = this.recovering ?? Promise.resolve();
    const run = previous
      .then(() => this.recover(lost))
      .catch((error) => {
        this.log(`[Sesion] Error al recuperar la sesion: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (this.recovering === run) {
          this.recovering = null;
        }
      });
    this.recovering = run;
  }

  async connectWithGithub(mode: 'silent' | 'interactive'): Promise<ConnectOutcome> {
    // Un canje silencioso no pisa lo que se conecte mientras tanto (enlace del
    // navegador, codigo, sesion pegada, archivo del tunel u otra ventana).
    const generation = this.explicitGeneration;
    const superseded = () => mode === 'silent' && (generation !== this.explicitGeneration || this.current() !== null);
    let token: string | null;
    try {
      token = await this.deps.getGithubToken(mode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return mode === 'silent'
        ? { ok: false, error: 'no_github', message }
        : { ok: false, error: 'cancelled', message };
    }
    if (!token) {
      return mode === 'silent'
        ? { ok: false, error: 'no_github', message: 'VS Code no tiene permiso de GitHub para ADACEEN.' }
        : { ok: false, error: 'cancelled', message: 'No se autorizó GitHub.' };
    }
    if (superseded()) {
      return { ok: false, error: 'superseded', message: 'VS Code ya se conectó de otra forma.' };
    }
    const result = await this.deps.claim('github', { githubToken: token, editorHost: this.deps.editorHost() }, 'github');
    if (!result.ok) {
      return { ok: false, error: result.error, message: result.message };
    }
    if (superseded()) {
      // No se guarda: la sesion creada en el backend vence sola.
      return { ok: false, error: 'superseded', message: 'VS Code ya se conectó de otra forma.' };
    }
    return { ok: true, session: await this.adopt(result.session, mode === 'interactive') };
  }

  /** Canjea un codigo XXXX-XXXX del navegador (label codigo o vscode-local). */
  async connectWithCode(code: string, label: EditorSessionLabel = 'codigo'): Promise<ConnectOutcome> {
    const normalized = normalizePairingCode(code);
    if (!normalized) {
      return { ok: false, error: 'invalid_code', message: describeClaimError('invalid_code') };
    }
    const result = await this.deps.claim('code', { code: normalized, editorHost: this.deps.editorHost(), label }, label);
    if (!result.ok) {
      return { ok: false, error: result.error, message: result.message };
    }
    return { ok: true, session: await this.adopt(result.session, true) };
  }

  /**
   * Sesion pegada (UUID de «Copiar sesion»). Se comprueba con /api/auth/me:
   * si el backend dice que ya no vale, no se guarda.
   */
  async connectWithSessionId(sessionId: string): Promise<ConnectOutcome> {
    const clean = String(sessionId || '').trim();
    if (!isSafeSessionId(clean)) {
      return { ok: false, error: 'invalid_session', message: 'Eso no parece un ID de sesión de ADACEEN.' };
    }
    const record: EditorSessionRecord = {
      sessionId: clean,
      backendUrl: cleanBackendUrl(this.deps.backendUrl()),
      expiresAt: null,
      userName: '',
      userEmail: '',
      label: 'manual',
    };
    if (this.deps.checkSession) {
      const check = await this.deps.checkSession(clean);
      if (check.status === 'invalid') {
        return {
          ok: false,
          error: 'invalid_session',
          message: 'Esa sesión ya no es válida (el navegador la cerró o es de otro servidor). Pide un código en el navegador.',
        };
      }
      if (check.status === 'ok') {
        record.userName = check.userName;
        record.userEmail = check.userEmail;
        this.checked.add(clean);
      }
    }
    return { ok: true, session: await this.adopt(record, true) };
  }

  /**
   * «Desconectar»: olvida la sesion emparejada de este equipo (SecretStorage)
   * y no vuelve a conectar en silencio hasta una conexion hecha a mano. El
   * archivo del tunel y el ajuste heredado no se tocan. Devuelve la sesion que
   * queda (null si ninguna).
   */
  async disconnect(): Promise<ResolvedEditorSession | null> {
    this.explicitGeneration += 1;
    this.secretWrites += 1;
    const hadSecret = Boolean(this.secret);
    this.secret = null;
    this.secretSavedAt = null;
    await this.setUnlinked(true);
    await this.deleteSecretQuietly();
    this.log(hadSecret
      ? '[Sesion] Desconectado: se olvido la sesion guardada en este equipo.'
      : '[Sesion] Desconectar: no habia sesion guardada en este equipo.');
    this.emitIfChanged();
    return this.current();
  }

  // -------------------------------------------------------------------------

  private async adopt(record: EditorSessionRecord, explicit: boolean): Promise<ResolvedEditorSession> {
    const now = this.now();
    this.secret = record;
    this.secretSavedAt = now;
    this.secretWrites += 1;
    this.ignored.delete(record.sessionId);
    this.checked.add(record.sessionId);
    if (explicit) {
      this.explicitGeneration += 1;
      // Una conexion hecha a mano abre otro episodio: si vuelve a caerse, se avisa otra vez.
      this.lostWarned = false;
      await this.setUnlinked(false);
    }
    try {
      await this.deps.secrets.store(serializeStoredEditorSession(record, now));
    } catch (error) {
      this.log(`[Sesion] No se pudo guardar la sesion en el llavero de VS Code (vale solo para esta ventana): ${error instanceof Error ? error.message : String(error)}`);
    }
    this.log(`[Sesion] Conectado (${describeSessionOrigin({ source: 'secret', label: record.label })}).`);
    this.emitIfChanged();
    return { ...record, source: 'secret' };
  }

  private async deleteSecretQuietly() {
    try {
      await this.deps.secrets.delete();
    } catch {
      // Sin llavero: basta con olvidarla en memoria.
    }
  }

  private isUnlinked() {
    try {
      return Boolean(this.deps.unlinkedMark?.get());
    } catch {
      return false;
    }
  }

  private async setUnlinked(value: boolean) {
    if (!this.deps.unlinkedMark || this.isUnlinked() === value) {
      return;
    }
    try {
      await this.deps.unlinkedMark.set(value);
    } catch {
      // Solo afecta a GitHub en silencio al arrancar.
    }
  }

  private async verify(session: ResolvedEditorSession) {
    if (!this.deps.checkSession || this.checked.has(session.sessionId)) {
      return;
    }
    this.checked.add(session.sessionId);
    const check = await this.deps.checkSession(session.sessionId);
    if (check.status === 'invalid') {
      this.reportInvalid(session.sessionId);
      await this.whenIdle();
      return;
    }
    if (check.status === 'ok' && (check.userName || check.userEmail)) {
      this.names.set(session.sessionId, { userName: check.userName, userEmail: check.userEmail });
      this.emitIfChanged();
    }
  }

  /** Solo al arrancar sin sesion y sin la marca de desvinculado (startup). */
  private async trySilentGithub() {
    let allowed = true;
    try {
      allowed = this.deps.silentGithubAllowed ? this.deps.silentGithubAllowed() : true;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      this.log('[Sesion] No se prueba GitHub en silencio: adaceen.backend.baseUrl lo fija el espacio de trabajo abierto.');
      return false;
    }
    const outcome = await this.connectWithGithub('silent');
    if (outcome.ok) {
      this.log('[Sesion] Conectado sin clics con la cuenta de GitHub de VS Code.');
      return true;
    }
    if (outcome.error === 'superseded') {
      this.log('[Sesion] Se descarta el canje silencioso con GitHub: VS Code ya se conecto de otra forma.');
      return true;
    }
    if (outcome.error !== 'no_github') {
      this.log(`[Sesion] GitHub en silencio no conecto: ${outcome.message}`);
    }
    return false;
  }

  private async recover(lost: ResolvedEditorSession) {
    this.log(`[Sesion] El backend rechazo la sesion (${describeSessionOrigin(lost)}); se olvida.`);
    if (lost.source === 'secret' && this.secret?.sessionId === lost.sessionId) {
      // Una sesion de otro backend (p. ej. produccion mientras corre el local)
      // puede seguir valiendo alla: solo se olvida en esta ventana.
      const sameBackend = !lost.backendUrl || sameBackendUrl(lost.backendUrl, this.deps.backendUrl());
      if (sameBackend) {
        this.secret = null;
        this.secretSavedAt = null;
        this.secretWrites += 1;
        await this.deleteSecretQuietly();
      }
    }
    // Un rechazo suele ser un «Salir» en el navegador, que desvincula tambien
    // VS Code: no se vuelve a conectar en silencio con la cuenta de GitHub que
    // tenga VS Code (en un equipo compartido puede ser de otro estudiante).
    await this.setUnlinked(true);
    // El tunel pudo escribir una sesion nueva (otro «Abrir mi editor»).
    await this.reloadFile(false);
    this.emitIfChanged();
    if (!this.current()) {
      this.notifyLost(lost);
    }
  }

  private notifyLost(lost: ResolvedEditorSession | null) {
    if (this.lostWarned) {
      return;
    }
    this.lostWarned = true;
    try {
      this.deps.onSessionLost?.(lost);
    } catch {
      // El aviso es cosmetico.
    }
  }

  private emitIfChanged() {
    const session = this.current();
    const id = session?.sessionId ?? '';
    const key = session ? `${id}|${session.source}|${session.userName}|${session.userEmail}` : '';
    if (this.lastEmitted && this.lastEmitted.key === key) {
      return;
    }
    const idChanged = !this.lastEmitted || this.lastEmitted.id !== id;
    this.lastEmitted = { id, key, session };
    try {
      this.deps.onDidChange?.(session, idChanged);
    } catch {
      // Quien escucha no debe romper la resolucion.
    }
  }
}
