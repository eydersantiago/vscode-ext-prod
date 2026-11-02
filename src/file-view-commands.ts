// ADACEEN (VS Code): registro de la vista «Este archivo» y sus comandos, resumen del archivo y material del curso.
// Movido desde activate() (src/extension.ts): mismo texto; el estado compartido esta en *-state.ts.
import * as vscode from 'vscode';
import { buildSessionHeaders, fetchJsonWithTimeout } from './backend-http';
import { ACTIVE_SUGGESTION_FALLBACK_DELAY_MS, MATERIAL_TTL_MS } from './constants';
import { courseMaterialListUrl, normalizeCourseMaterial } from './course-material';
import { DiagramController } from './diagram-controller';
import { buildActiveEditorSnapshot, isSupportedActiveDocument, resolveEditorForSuggestion } from './editor-snapshot';
import { output, proposals, quizView, safeLog, telemetry } from './extension-state';
import { AdaceenFileViewProvider } from './file-view';
import { openDependency, scheduleDependencyRefresh, setFileViewDocument } from './file-view-controller';
import { EMPTY_MATERIAL_STATE } from './file-view-model';
import type { FileViewMaterialState } from './file-view-model';
import { dependencyBuildFiles, fileSummaries, fileSummaryInFlight, fileView, materialInFlight, materialLoadedAt, materialState, setFileView, setMaterialInFlight, setMaterialLoadedAt, setMaterialStateValue, workshopProgress } from './file-view-state';
import { applyEditToText } from './proposal-diff';
import { resolveActiveSuggestionSettings, resolveBackendSettings } from './settings';
import { buildBackendSuggestionTextCacheKey, getBackendSuggestionText, getWorkspaceProjectIndex } from './suggestion-backend';
import { producedMode, suggestionReadyForMode } from './suggestion-code';
import { planSuggestionEdit } from './suggestion-edit';
import { parseBackendSuggestionSections } from './suggestion-format';
import { editorPageContext } from './suggestion-metrics';
import { recordSuggestionMetric, refreshFileView } from './suggestion-publish';
import { formatBackendSuggestionError, normalizeCourseCode, truncateInline, withActiveSuggestionDeadline } from './suggestion-results';
import { activeSuggestionModel, backendSuggestionCache } from './suggestion-state';
import type { SuggestionApplyMode } from './types';

// --- Vista «Este archivo» y material del curso (0.0.34) ---------------------

/** Resumen del archivo activo para la vista (file_summary, con la misma cache de siempre). */
export const requestFileSummary = async (force = false) => {
  const settings = resolveActiveSuggestionSettings();
  if (!settings.enabled || !settings.useBackend) {
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isSupportedActiveDocument(editor.document)) {
    return;
  }
  const uriString = editor.document.uri.toString();
  if (fileSummaryInFlight.has(uriString) || (!force && fileSummaries.has(uriString))) {
    return;
  }
  const snapshot = await buildActiveEditorSnapshot(settings);
  if (!snapshot || snapshot.uriString !== uriString || fileSummaryInFlight.has(uriString)) {
    return;
  }
  fileSummaryInFlight.add(uriString);
  refreshFileView();
  try {
    const projectIndex = await getWorkspaceProjectIndex();
    if (force) {
      backendSuggestionCache.file_summary.delete(buildBackendSuggestionTextCacheKey(snapshot, projectIndex, 'file_summary', 'panel'));
    }
    const result = await withActiveSuggestionDeadline(
      getBackendSuggestionText(settings, snapshot, projectIndex, 'file_summary', {
        trigger: 'panel',
        clientSessionId: telemetry.clientSessionId,
      }),
      Math.min(settings.backendTimeoutMs, ACTIVE_SUGGESTION_FALLBACK_DELAY_MS),
    );
    if (!result.blocked && result.outputText) {
      const sections = parseBackendSuggestionSections(result.outputText);
      const overview = truncateInline(sections.resumen.join(' '), 420);
      if (overview) {
        fileSummaries.delete(uriString);
        fileSummaries.set(uriString, {
          uriString,
          overview,
          tips: sections.sugerencias.slice(0, 3),
          updatedAt: new Date().toISOString(),
        });
      }
    }
  } catch (error) {
    output.appendLine(`[Resumen] No se pudo pedir el resumen de ${snapshot.filePath}: ${formatBackendSuggestionError(error)}`);
  } finally {
    fileSummaryInFlight.delete(uriString);
    refreshFileView();
  }
};

const setMaterialState = (next: FileViewMaterialState) => {
  setMaterialStateValue(next);
  refreshFileView();
  return next;
};

/** Material del curso (GET /api/rag/sources): las fuentes RAG que el docente cargo. */
const loadCourseMaterial = async (force = false): Promise<FileViewMaterialState> => {
  if (!force && materialState.status === 'ready' && Date.now() - materialLoadedAt < MATERIAL_TTL_MS) {
    return materialState;
  }
  if (materialInFlight) {
    return materialInFlight;
  }
  const settings = resolveBackendSettings();
  if (!settings.baseUrl) {
    return setMaterialState({ ...EMPTY_MATERIAL_STATE, status: 'error', message: 'No hay un backend de ADACEEN configurado.' });
  }
  if (!settings.sessionId) {
    return setMaterialState({
      ...EMPTY_MATERIAL_STATE,
      status: 'no_session',
      message: 'Conecta VS Code con tu cuenta de ADACEEN para ver el material del curso (ADACEEN: Conectar).',
    });
  }
  const courseCode = normalizeCourseCode(resolveActiveSuggestionSettings().ragCourseCode || activeSuggestionModel?.ragCourseCode || '');
  setMaterialState({ ...materialState, status: 'loading', message: '' });
  setMaterialInFlight((async () => {
    try {
      const data = await fetchJsonWithTimeout(
        courseMaterialListUrl(settings.baseUrl, courseCode),
        { method: 'GET', headers: buildSessionHeaders(settings, false) },
        20_000,
      );
      const list = normalizeCourseMaterial(data, settings.baseUrl);
      setMaterialLoadedAt(Date.now());
      return setMaterialState({ status: 'ready', courseCode: list.courseCode || courseCode, items: list.items, message: '' });
    } catch (error) {
      if ((error as { status?: number })?.status === 401) {
        return setMaterialState({
          ...EMPTY_MATERIAL_STATE,
          status: 'no_session',
          message: 'Tu sesión de ADACEEN venció: vuelve a conectar VS Code (ADACEEN: Conectar) para ver el material.',
        });
      }
      return setMaterialState({
        ...EMPTY_MATERIAL_STATE,
        status: 'error',
        message: `No se pudo traer el material del curso: ${truncateInline(formatBackendSuggestionError(error), 160)}`,
      });
    } finally {
      setMaterialInFlight(null);
    }
  })());
  return materialInFlight!;
};

const recordMaterialOpened = (title: string, metadata: Record<string, unknown>) => {
  const model = activeSuggestionModel;
  if (model && !model.loading) {
    recordSuggestionMetric(model, 'vscode_rag_source_opened', title.slice(0, 120), metadata);
    return;
  }
  telemetry.track({
    source: 'vscode_extension',
    category: 'suggestion',
    eventType: 'vscode_rag_source_opened',
    pageContext: editorPageContext(),
    value: title.slice(0, 120),
    metadata,
  });
};

const openCourseMaterialItem = async (id: string, origin: string) => {
  const item = materialState.items.find((entry) => entry.id === id);
  if (!item?.url) {
    void vscode.window.showInformationMessage('ADACEEN: esa fuente ya no está en el material del curso.');
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(item.url));
  recordMaterialOpened(item.title, { origin, courseCode: item.courseCode, sourceId: item.id });
};

export function registerFileView(context: vscode.ExtensionContext) {
  // 0.0.38: «Ver diagrama» (comando y boton de la vista): el diagrama del taller y las dependencias.
  const diagram = new DiagramController({
    buildFiles: dependencyBuildFiles,
    track: (event) => telemetry.track(event),
    pageContext: editorPageContext,
    log: safeLog,
  });
  context.subscriptions.push(diagram);

  setFileView(new AdaceenFileViewProvider({
    onVisibilityChanged: (visible) => {
      workshopProgress.setVisible(visible);
      if (visible) {
        refreshFileView();
        void requestFileSummary(false);
        scheduleDependencyRefresh(0);
      }
    },
    openDiagram: () => {
      void diagram.open('file_view');
    },
    openDependency: (group, index, key, id) => {
      void openDependency(group, index, key, id);
    },
    openSource: (index) => {
      const source = activeSuggestionModel?.ragSources[index];
      if (source) {
        void vscode.commands.executeCommand('adaceen.openRagSource', source);
      }
    },
    openMaterial: (id) => {
      void openCourseMaterialItem(id, 'file_view');
    },
    loadMaterial: () => {
      void loadCourseMaterial(materialState.status !== 'idle');
    },
    refreshSummary: () => {
      void requestFileSummary(true);
    },
    openQuiz: () => {
      void quizView.reveal(false);
    },
  }));
  context.subscriptions.push(
    fileView!,
    vscode.window.registerWebviewViewProvider(AdaceenFileViewProvider.viewType, fileView!, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('adaceen.openFileView', async () => {
      await fileView?.reveal(false);
      const model = activeSuggestionModel;
      if (model && !model.loading) {
        recordSuggestionMetric(model, 'vscode_suggestion_panel_opened', 'file_view');
      }
    }),
    // 0.0.38: «ADACEEN: Abrir panel» trae el panel ADACEEN (su icono) con «Este archivo»: lo mismo
    // que el bombillo de la barra de estado (y cuenta la misma metrica).
    vscode.commands.registerCommand('adaceen.openPanel', () => vscode.commands.executeCommand('adaceen.openFileView')),
    vscode.commands.registerCommand('adaceen.showDiagram', async () => {
      await diagram.open('command');
    }),
    // 0.0.36: «ADACEEN: Ver dependencias del archivo» (paleta de comandos): abre el cuadro.
    vscode.commands.registerCommand('adaceen.showDependencies', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && isSupportedActiveDocument(editor.document)) {
        setFileViewDocument(editor.document);
      }
      await fileView?.reveal(false);
      scheduleDependencyRefresh(0);
      fileView?.focusDependencies();
    }),
    vscode.commands.registerCommand('adaceen.openCourseMaterial', async () => {
      const state = await loadCourseMaterial(false);
      if (state.status === 'no_session') {
        const pick = await vscode.window.showWarningMessage(`ADACEEN: ${state.message}`, 'Conectar');
        if (pick === 'Conectar') {
          void vscode.commands.executeCommand('adaceen.connect');
        }
        return;
      }
      if (state.status !== 'ready') {
        void vscode.window.showWarningMessage(`ADACEEN: ${state.message || 'no se pudo traer el material del curso.'}`);
        return;
      }
      if (!state.items.length) {
        void vscode.window.showInformationMessage('ADACEEN: tu docente todavía no cargó material para este curso.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        state.items.map((item) => ({
          label: item.title,
          description: [item.fileName && item.fileName !== item.title ? item.fileName : '', item.supplemental ? 'bitácora' : ''].filter(Boolean).join(' · '),
          detail: item.preview,
          id: item.id,
        })),
        {
          title: `Material del curso${state.courseCode ? ` ${state.courseCode}` : ''}`,
          placeHolder: 'Elige una fuente para abrirla en el navegador',
          matchOnDescription: true,
          matchOnDetail: true,
        },
      );
      if (picked) {
        await openCourseMaterialItem(picked.id, 'command');
      }
    }),
    vscode.commands.registerCommand('adaceen.showProposalDiff', async (modeArg?: unknown) => {
      const model = activeSuggestionModel;
      const editor = model ? await resolveEditorForSuggestion(model) : undefined;
      if (!model || !editor || editor.document.uri.toString() !== model.uriString) {
        void vscode.window.showInformationMessage('ADACEEN: no hay una propuesta activa para comparar.');
        return;
      }
      const requested = modeArg === 'insert' || modeArg === 'replace' || modeArg === 'delete' ? modeArg : '';
      const mode: SuggestionApplyMode = requested || producedMode(model) || model.applyMode || 'insert';
      if (!suggestionReadyForMode(model, mode)) {
        void vscode.window.showInformationMessage('ADACEEN: esta sugerencia no trae código para esa acción; pídelo con «Proponer una mejora».');
        return;
      }
      const plan = planSuggestionEdit(editor, model, mode);
      if (!plan.ok) {
        void vscode.window.showInformationMessage(plan.message);
        return;
      }
      const proposalUri = proposals.remember(model.fileName, applyEditToText(editor.document, plan.range, plan.text));
      await vscode.commands.executeCommand(
        'vscode.diff',
        editor.document.uri,
        proposalUri,
        `${model.fileName}: tu código ↔ propuesta de ADACEEN`,
        { preview: true },
      );
      recordSuggestionMetric(model, 'vscode_suggestion_actions_revealed', mode, { origin: 'proposal_diff' }, true);
    }),
  );
}
