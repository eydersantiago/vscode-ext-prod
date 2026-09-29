// ADACEEN (VS Code): aplicar acciones de codigo pedidas desde el navegador (con la guarda de aplicacion).
// Movido desde src/extension.ts. Desde 0.0.33 (A12.12): reclamo con lease, aviso que se cierra solo,
// confirmacion con reintentos y nunca «fallido» despues de editar (code-action-queue.ts).
import * as vscode from 'vscode';
import { buildSessionHeaders, claimNextCodeAction, completeCodeAction, failCodeAction, fetchJsonWithTimeout } from './backend-http';
import { describeQueuedTarget, guardCodeApplication, insertAnchorMatches, isFreshOverlayClick, queuedActionSummary, queuedCodeActionAgeMs, queuedCodeActionNeedsPrompt, queuedTargetVerified } from './code-application-guard';
import type { ApplyCheckRequest, CodeApplicationGuardDeps, CodeApplicationVerdict, QueuedTargetCheck } from './code-application-guard';
import { editorConnection } from './connection-state';
import { APPLY_CHECK_TIMEOUT_MS, DEFAULT_CODE_ACTION_CONFIRM_LABEL } from './constants';
import { detectBranchName } from './git-repo';
import { resolveBackendSettings, resolveCodeApplicationSettings, toOptionalString } from './settings';
import { actionTypeToApplyMode, findTextMatch, getDocumentEol, rangeForCodeActionFallback, resolveWorkspaceFileUri } from './suggestion-edit';
import { editorPageContext } from './suggestion-metrics';
import { inferActiveLanguage, pathBaseName, truncateInline } from './suggestion-results';
import type { TelemetryClient, TelemetryEventInput } from './telemetry';
import type { BackendSettings, PendingCodeAction } from './types';
import { CODE_ACTION_PROMPT_TIMEOUT_MS, confirmAppliedCodeAction, PROMPT_TIMED_OUT, promptWithTimeout, replacementAlreadyApplied } from './code-action-queue';

/** La aplicacion no se hizo por decision del guard (politica, regla offline o cancelacion). */
export class CodeApplicationBlockedError extends Error {
  constructor(message: string, readonly verdict: CodeApplicationVerdict) {
    super(message);
    this.name = 'CodeApplicationBlockedError';
  }
}

/** POST /api/suggestions/apply-check. Lanza ante red caida, HTTP no 2xx o tiempo agotado. */
export async function requestApplyCheck(request: ApplyCheckRequest): Promise<unknown> {
  const settings = resolveBackendSettings();
  if (!settings.baseUrl) {
    throw new Error('sin backend configurado (adaceen.backend.baseUrl)');
  }
  return fetchJsonWithTimeout(
    `${settings.baseUrl}/api/suggestions/apply-check`,
    {
      method: 'POST',
      headers: buildSessionHeaders(settings, true),
      body: JSON.stringify(request),
    },
    APPLY_CHECK_TIMEOUT_MS,
  );
}

/** Dependencias reales (VS Code + backend + telemetria) del guard de aplicacion de codigo. */
export function createCodeApplicationGuardDeps(
  telemetry: TelemetryClient,
  output: vscode.OutputChannel,
): CodeApplicationGuardDeps {
  return {
    // Indicador discreto en la barra de estado mientras responde el backend.
    requestApplyCheck: (request) => Promise.resolve(vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'ADACEEN: comprobando si se puede aplicar el cambio' },
      () => requestApplyCheck(request),
    )),
    confirm: async (message, detail) => {
      const accept = 'Aplicar';
      const answer = await vscode.window.showInformationMessage(message, { modal: true, detail }, accept);
      return answer === accept;
    },
    notify: (message) => {
      void vscode.window.showInformationMessage(message);
    },
    track: (event: TelemetryEventInput) => {
      telemetry.track({
        pageContext: editorPageContext(),
        branch: detectBranchName(),
        ...event,
      });
    },
    offlineMaxLines: () => resolveCodeApplicationSettings().offlineMaxLines,
    log: (line) => output.appendLine(line),
  };
}

/**
 * Linea (0-based) debajo de la que se inserta un reemplazo del navegador: la
 * ultima de la seleccion que mando VS Code (metadata.selectionEndLine) o el
 * final del rango de respaldo (linea del cursor o seleccion).
 */
export function insertAnchorLineFor(document: vscode.TextDocument, action: PendingCodeAction, range: vscode.Range) {
  const selectionEndLine = Number(action.metadata.selectionEndLine) || 0;
  return selectionEndLine > 0
    ? Math.min(document.lineCount - 1, selectionEndLine - 1)
    : range.end.line;
}

/** Texto de las lineas alrededor del punto de insercion (para insertAnchorMatches). */
export function insertAnchorText(editor: vscode.TextEditor, action: PendingCodeAction, anchorLine: number) {
  const document = editor.document;
  let startLine = anchorLine;
  let endLine = anchorLine;
  const selectionStartLine = Number(action.metadata.selectionStartLine) || 0;
  if (selectionStartLine > 0) {
    startLine = Math.min(startLine, Math.min(document.lineCount - 1, selectionStartLine - 1));
  }
  if (!editor.selection.isEmpty) {
    startLine = Math.min(startLine, editor.selection.start.line);
    endLine = Math.max(endLine, editor.selection.end.line);
  }
  return document.getText(new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).range.end.character));
}

/**
 * Aplica un reemplazo que llego del navegador. explicitClick: el estudiante lo
 * acaba de elegir en el overlay (isFreshOverlayClick). Ese clic es la
 * confirmacion, sin «Aplicar reemplazo»/«Omitir» ni el dialogo de
 * requireConfirmation, solo si VS Code encuentra el cambio donde el estudiante
 * lo vio (queuedTargetVerified); si no, se pregunta diciendo donde caera. La
 * politica del docente se consulta igual y un cambio grande o que borra codigo
 * abre el dialogo del docente aunque haya clic.
 */
export async function applyPendingCodeAction(
  action: PendingCodeAction,
  settings: BackendSettings,
  output: vscode.OutputChannel,
  guardDeps: CodeApplicationGuardDeps,
  explicitClick: boolean,
) {
  const uri = await resolveWorkspaceFileUri(action.filePath);
  if (!uri) {
    throw new Error(`No se encontro el archivo ${action.filePath} en el workspace abierto.`);
  }

  const document = await vscode.workspace.openTextDocument(uri);
  const applyMode = actionTypeToApplyMode(action.actionType);
  // Volvio a la cola porque su primer reclamo vencio: si ya se aplico, no se aplica otra vez.
  if (replacementAlreadyApplied({
    documentText: document.getText(),
    originalText: action.originalText,
    replacementText: action.replacementText,
    applyMode,
    attempts: action.attempts,
  })) {
    output.appendLine(`[CodeActions] ${action.id}: el cambio ya estaba en ${action.filePath}; no se aplica de nuevo.`);
    return {
      filePath: action.filePath,
      alreadyApplied: true,
      attempts: action.attempts,
      appliedAt: new Date().toISOString(),
    };
  }
  const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  const label = truncateInline(action.title || 'Reemplazo sugerido', 80);
  const fileLabel = pathBaseName(action.filePath);
  const planRange = () => {
    const match = applyMode === 'insert' ? null : findTextMatch(editor, action.originalText);
    const directMatch = match?.range || null;
    return {
      directMatch,
      target: directMatch || rangeForCodeActionFallback(editor, action),
      matchCount: match?.count || 0,
      matchAtFocus: !!match?.atFocus,
    };
  };

  // Guard de aplicacion (A10.8): los reemplazos del navegador tambien pasan por apply-check.
  const measured = planRange();
  // ¿Cae donde el estudiante lo vio? Si no, su clic en el overlay no basta: se pregunta.
  const measuredAnchorLine = insertAnchorLineFor(editor.document, action, measured.target);
  const targetCheck: QueuedTargetCheck = {
    applyMode,
    matchCount: measured.matchCount,
    matchAtFocus: measured.matchAtFocus,
    anchorMatches: applyMode === 'insert'
      ? insertAnchorMatches(insertAnchorText(editor, action, measuredAnchorLine), action.originalText)
      : false,
    line: (applyMode === 'insert' ? measuredAnchorLine : measured.target.start.line) + 1,
    fileLabel,
  };
  const targetVerified = queuedTargetVerified(targetCheck);
  const clickConfirms = explicitClick && targetVerified;
  const summary = queuedActionSummary({
    label,
    ageMs: queuedCodeActionAgeMs(action),
    targetNote: describeQueuedTarget(targetCheck),
  });
  if (explicitClick && !targetVerified) {
    output.appendLine(`[CodeActions] ${action.id}: el destino no se pudo comprobar (${targetCheck.matchCount} coincidencia(s)); se pregunta.`);
  }
  const verdict = await guardCodeApplication({
    decisionId: toOptionalString(action.metadata.decisionId) || toOptionalString(action.metadata.decision_id),
    filePath: action.filePath,
    language: inferActiveLanguage(action.filePath, editor.document.languageId),
    applyMode,
    originalText: applyMode === 'insert' ? '' : editor.document.getText(measured.target),
    newText: applyMode === 'delete' ? '' : action.replacementText,
    trigger: toOptionalString(action.metadata.trigger) || 'browser_code_action',
    origin: 'browser_code_action',
    fileLabel,
    repoFullName: action.repoFullName,
    explicitClick: clickConfirms,
    confirmDetail: clickConfirms ? '' : summary,
  }, guardDeps);
  if (!verdict.allowed) {
    throw new CodeApplicationBlockedError(
      verdict.cancelled
        ? 'Reemplazo omitido por el usuario en VS Code.'
        : `Aplicacion bloqueada (${verdict.reasonCode}): ${verdict.reason}`,
      verdict,
    );
  }

  // Solo un reemplazo que nadie confirmo (espero mas de 10 min en la cola, sin
  // origen del overlay o sin destino comprobado) pregunta aqui; el clic reciente
  // en el overlay sobre un destino comprobado ya confirmo.
  const prompted = queuedCodeActionNeedsPrompt({
    explicitClick: clickConfirms,
    confirmedByGuard: verdict.confirmed,
    autoApply: settings.autoApplyCodeActions,
  });
  if (prompted) {
    // El aviso no modal se puede ignorar: a los 2 minutos se da por no respondido, para no
    // dejar parada la cola (antes la esperaba para siempre con workerBusy).
    const answer = await promptWithTimeout(
      vscode.window.showInformationMessage(
        `ADACEEN: ${summary}`,
        { modal: false },
        DEFAULT_CODE_ACTION_CONFIRM_LABEL,
        'Omitir',
      ),
      CODE_ACTION_PROMPT_TIMEOUT_MS,
    );
    if (answer === PROMPT_TIMED_OUT) {
      throw new Error('Sin respuesta en VS Code en 2 minutos: el reemplazo no se aplico. Pidelo otra vez desde el navegador.');
    }
    if (answer !== DEFAULT_CODE_ACTION_CONFIRM_LABEL) {
      throw new Error('Reemplazo omitido por el usuario en VS Code.');
    }
  }

  // Justo antes de editar (la confirmacion pudo tardar): el codigo elegido donde
  // se midio si sigue ahi, o donde este ahora; si no esta, el mismo rango de
  // respaldo que se anuncio (no la linea a la que el estudiante movio el cursor
  // mientras decidia).
  const measuredStillThere = !!measured.directMatch
    && editor.document.getText(editor.document.validateRange(measured.directMatch)) === action.originalText;
  const directRange = measuredStillThere ? measured.directMatch : planRange().directMatch;
  const range = directRange || editor.document.validateRange(measured.target);
  const eol = getDocumentEol(editor.document);
  let editStart = range.start;
  let appliedTextLength = action.replacementText.length;
  const applied = await editor.edit((editBuilder) => {
    if (applyMode === 'delete') {
      appliedTextLength = 0;
      editBuilder.delete(range);
      return;
    }

    if (applyMode === 'insert') {
      const anchorLine = insertAnchorLineFor(document, action, range);
      const line = document.lineAt(anchorLine);
      const insertPosition = line.range.end;
      const prefix = line.text.trim() ? eol : '';
      const insertedText = `${prefix}${action.replacementText}`;
      editStart = insertPosition;
      appliedTextLength = insertedText.length;
      editBuilder.insert(insertPosition, insertedText);
      return;
    }

    editBuilder.replace(range, action.replacementText);
  });
  if (!applied) {
    throw new Error(`No se pudo aplicar el cambio en ${action.filePath}.`);
  }

  const finalOffset = editor.document.offsetAt(editStart) + appliedTextLength;
  const finalPosition = editor.document.positionAt(finalOffset);
  editor.selection = new vscode.Selection(finalPosition, finalPosition);
  output.appendLine(`[CodeActions] Cambio aplicado: ${action.filePath} (${action.id}, ${applyMode}).`);

  return {
    filePath: action.filePath,
    replacedByMatch: !!directRange,
    targetVerified,
    line: range.start.line + 1,
    character: range.start.character + 1,
    appliedAt: new Date().toISOString(),
    linesChanged: verdict.linesChanged,
    charsChanged: verdict.charsChanged,
    applyCheck: verdict.offline ? 'offline' : 'server',
    confirmedBy: verdict.confirmedBy || (prompted ? 'dialog' : clickConfirms ? 'click' : 'auto'),
    ...(verdict.decisionId ? { decisionId: verdict.decisionId } : {}),
  };
}

export async function processNextCodeActionForRepo(
  settings: BackendSettings,
  repoFullName: string,
  output: vscode.OutputChannel,
  guardDeps: CodeApplicationGuardDeps,
  manual = false,
) {
  if (!settings.sessionId) {
    if (manual) {
      if (editorConnection) {
        editorConnection.warnNotConnected('sincronizar reemplazos con el navegador');
      } else {
        vscode.window.showWarningMessage(
          'ADACEEN: configura adaceen.backend.sessionId para sincronizar reemplazos con el navegador.',
        );
      }
    }
    return false;
  }

  if (!settings.codeActionsEnabled) {
    if (manual) {
      vscode.window.showInformationMessage('ADACEEN: la cola de reemplazos del navegador esta desactivada.');
    }
    return false;
  }

  const action = await claimNextCodeAction(settings, repoFullName);
  if (!action) {
    if (manual) {
      vscode.window.showInformationMessage(`ADACEEN: no hay reemplazos pendientes para ${repoFullName}.`);
    }
    return false;
  }

  output.appendLine(`[CodeActions] Reemplazo reclamado: ${action.id} | ${action.filePath} (intento ${action.attempts}).`);
  // Solo el clic reciente en el overlay confirma. El comando pedido a mano no:
  // el estudiante no ve cual es el siguiente de la cola (puede tener dias).
  const explicitClick = isFreshOverlayClick(action);
  let metadata: Record<string, unknown>;
  try {
    metadata = await applyPendingCodeAction(action, settings, output, guardDeps, explicitClick);
  } catch (error) {
    // No se edito nada: se reporta el fallo (guard, omitido, sin respuesta, archivo ausente).
    const blockedByGuard = error instanceof CodeApplicationBlockedError;
    const message = blockedByGuard ? error.message : String(error);
    output.appendLine(`[CodeActions] No se pudo aplicar ${action.id}: ${message}`);
    await failCodeAction(settings, action.id, message).catch((failError) => {
      output.appendLine(`[CodeActions] No se pudo reportar fallo ${action.id}: ${String(failError)}`);
    });
    // Si lo freno el guard, el estudiante ya vio el motivo (o cancelo el mismo).
    if (manual && !blockedByGuard) {
      vscode.window.showWarningMessage(`ADACEEN: ${message}`);
    }
    return true;
  }

  // El cambio ya esta en el archivo: se confirma con reintentos y NUNCA se reporta como
  // fallido (antes un fallo de complete terminaba en fail y la tesis contaba un dato falso).
  const confirmation = await confirmAppliedCodeAction(() => completeCodeAction(settings, action.id, {
    ...action.metadata,
    ...metadata,
    workerId: settings.workerId,
  }));
  if (confirmation.outcome === 'unconfirmed') {
    output.appendLine(
      `[CodeActions] ${action.id} se aplico pero el backend no confirmo tras ${confirmation.attempts} intentos (${confirmation.lastError}). `
      + 'Si vuelve a la cola, VS Code vera que ya esta aplicado.',
    );
  } else if (confirmation.outcome === 'already_closed') {
    output.appendLine(`[CodeActions] ${action.id}: el backend ya lo tenia cerrado.`);
  }
  if (manual) {
    vscode.window.showInformationMessage(`ADACEEN: reemplazo aplicado en ${action.filePath}.`);
  }

  return true;
}
