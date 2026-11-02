// ADACEEN (VS Code): worker del navegador: cada WORKER_TICK_MS reclama reemplazos y escaneos pedidos y los procesa (runWorkerCycle).
// Movido desde activate() (src/extension.ts): mismo texto; el estado compartido esta en *-state.ts.
import * as vscode from 'vscode';
import { claimNextScanRequest, classifyScannedDocuments, sendScanFailure, sendScanResult } from './backend-http';
import { processNextCodeActionForRepo } from './code-actions';
import { WORKER_TICK_MS } from './constants';
import { codeApplicationGuardDeps, output } from './extension-state';
import { detectRepoFullName } from './git-repo';
import { asRecord, resolveBackendSettings, resolveScanOptions, toOptionalString } from './settings';
import type { ScanPayload } from './types';
import { askScanPermission, performWorkspaceScan } from './workspace-scan';

export function registerScanWorker(context: vscode.ExtensionContext, scanWorkspaceDisposable: vscode.Disposable) {
  let workerBusy = false;
  let workerNextPollAt = 0;
  let idlePollCount = 0;
  let missingWorkspacePollCount = 0;
  let missingRepoPollCount = 0;
  let authErrorNotified = false;

  const runWorkerCycle = async () => {
    const settings = resolveBackendSettings();
    if (!settings.autoWorkerEnabled) {
      return;
    }

    if (Date.now() < workerNextPollAt) {
      return;
    }
    workerNextPollAt = Date.now() + settings.workerPollMs;

    if (workerBusy) {
      return;
    }
    workerBusy = true;

    let requestId = '';
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders?.length) {
        missingWorkspacePollCount += 1;
        if (missingWorkspacePollCount % 15 === 0) {
          output.appendLine('[Worker] Sin workspace abierto; esperando para reclamar solicitudes.');
        }
        return;
      }
      missingWorkspacePollCount = 0;

      const repoFullName = await detectRepoFullName(workspaceFolders);
      if (!repoFullName) {
        missingRepoPollCount += 1;
        if (missingRepoPollCount % 10 === 0) {
          output.appendLine('[Worker] No se pudo detectar repo GitHub (owner/repo) desde este workspace.');
        }
        return;
      }
      missingRepoPollCount = 0;

      const processedCodeAction = await processNextCodeActionForRepo(settings, repoFullName, output, codeApplicationGuardDeps, false);
      if (processedCodeAction) {
        idlePollCount = 0;
        return;
      }

      const request = await claimNextScanRequest(settings, repoFullName);
      if (!request) {
        idlePollCount += 1;
        if (idlePollCount % 15 === 0) {
          output.appendLine(`[Worker] Sin solicitudes pendientes para ${repoFullName}.`);
        }
        return;
      }
      idlePollCount = 0;

      requestId = request.id;
      output.appendLine(`[Worker] Solicitud reclamada: ${request.id} (${request.repoFullName}).`);

      // Permiso del estudiante en cada solicitud (A12.12): sin el, no sale nada del equipo.
      const permission = await askScanPermission(
        context.workspaceState,
        request.repoFullName,
        resolveScanOptions(undefined).maxFiles,
      );
      if (permission !== 'allow') {
        const reason = permission === 'timeout'
          ? 'Sin respuesta en VS Code en 2 minutos: no se escaneo el proyecto.'
          : 'El estudiante no autorizo el escaneo en VS Code.';
        output.appendLine(`[Worker] ${reason} (${request.id})`);
        await sendScanFailure(settings, request.id, reason);
        requestId = '';
        return;
      }

      const scan = await performWorkspaceScan(undefined, output);
      const payload: ScanPayload = {
        ...scan.payload,
        repoFullName: request.repoFullName,
      };
      const scanResponse = await sendScanResult(settings, request.id, payload);

      output.appendLine(
        `[Worker] Escaneo enviado al backend: ${request.repoFullName} (${payload.totalFiles} archivos).`,
      );

      const snapshotId = toOptionalString(asRecord(scanResponse).snapshotId);
      await classifyScannedDocuments(settings, {
        repoFullName: request.repoFullName,
        requestId: request.id,
        snapshotId: snapshotId || '',
        documents: scan.documents,
      }, output);
    } catch (error) {
      const errorMessage = String(error);
      // Sin output.show: un error del worker no le quita el foco al estudiante.
      output.appendLine(`[Worker] Error al procesar solicitud de escaneo: ${errorMessage}`);

      const normalized = errorMessage.toLowerCase();
      if (
        !authErrorNotified &&
        (normalized.includes('worker no autorizado') || normalized.includes('http 401') || normalized.includes('401'))
      ) {
        authErrorNotified = true;
        vscode.window.showWarningMessage(
          'ADACEEN Worker: el backend rechazó la solicitud (401/no autorizado). Conecta VS Code con tu cuenta (ADACEEN: Conectar) o revisa adaceen.backend.scanWorkerKey.',
        );
      }

      if (requestId) {
        await sendScanFailure(settings, requestId, errorMessage);
      }
    } finally {
      workerBusy = false;
    }
  };

  const timer = setInterval(() => {
    void runWorkerCycle();
  }, WORKER_TICK_MS);

  context.subscriptions.push(
    scanWorkspaceDisposable,
    output,
    {
      dispose: () => clearInterval(timer),
    },
  );
  return runWorkerCycle;
}
