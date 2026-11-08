// ADACEEN (VS Code): eventos del editor y del espacio de trabajo que mueven la sugerencia, la vista «Este archivo» y el indice.
// Movido desde activate() (src/extension.ts): mismo texto; el estado compartido esta en *-state.ts.
import * as vscode from 'vscode';
import { workspaceRelativePath } from './dependency-scan';
import { isSupportedActiveDocument } from './editor-snapshot';
import type { ErrorSignalTracker } from './error-signals';
import { quizView } from './extension-state';
import { requestFileSummary } from './file-view-commands';
import { markDependencyIndexDirty, scheduleDependencyRefresh, setFileViewDocument } from './file-view-controller';
import { dependencyBuildFiles, dependencyProbes, dependencyTimer, fileView, fileViewDocument, savedSinceDependencyIndex, setDependencyTimer } from './file-view-state';
import { errorSignalSettingsFromConfig } from './settings';
import { clearBackendSuggestionCaches, clearWorkspaceProjectIndexCache } from './suggestion-backend';
import { clearSuggestionDecorations } from './suggestion-decorations';
import { textDocumentSelector } from './suggestion-providers';
import { refreshInlineSuggestionSurfaces } from './suggestion-publish';
import { clearCursorSuggestionTimers, scheduleCursorIdleSuggestionRefresh } from './suggestion-schedule';
import { lastActiveDocumentUri, selectionInlinePanelTimer, selectionWidget, setLastActiveDocumentUri, setPendingFileOpenUri, setSelectionInlinePanelTimer, setSuggestionTimer, suggestionCodeActionProvider, suggestionCodeLensProvider, suggestionDecorationType, suggestionInlayHintProvider, suggestionStatusBar, suggestionTimer } from './suggestion-state';

export type EditorEventDeps = {
  openAssistantDisposable: vscode.Disposable;
  refreshSuggestionsDisposable: vscode.Disposable;
  requestSuggestionDisposable: vscode.Disposable;
  openSuggestionHistoryDisposable: vscode.Disposable;
  clearSuggestionHistoryDisposable: vscode.Disposable;
  openSuggestionHistoryEntryDisposable: vscode.Disposable;
  applySuggestionCompletionDisposable: vscode.Disposable;
  openRagSourceDisposable: vscode.Disposable;
  setBackendSessionIdDisposable: vscode.Disposable;
  applyNextCodeActionDisposable: vscode.Disposable;
  errorSignalTracker: ErrorSignalTracker;
  clearErrorSignalTimer: () => void;
  rememberEdit: (uriString: string) => void;
  evaluateErrorSignals: () => void;
};

export function registerEditorEvents(context: vscode.ExtensionContext, deps: EditorEventDeps) {
  const {
    openAssistantDisposable,
    refreshSuggestionsDisposable,
    requestSuggestionDisposable,
    openSuggestionHistoryDisposable,
    clearSuggestionHistoryDisposable,
    openSuggestionHistoryEntryDisposable,
    applySuggestionCompletionDisposable,
    openRagSourceDisposable,
    setBackendSessionIdDisposable,
    applyNextCodeActionDisposable,
    errorSignalTracker,
    clearErrorSignalTimer,
    rememberEdit,
    evaluateErrorSignals,
  } = deps;
  context.subscriptions.push(
    openAssistantDisposable,
    refreshSuggestionsDisposable,
    requestSuggestionDisposable,
    openSuggestionHistoryDisposable,
    clearSuggestionHistoryDisposable,
    openSuggestionHistoryEntryDisposable,
    applySuggestionCompletionDisposable,
    openRagSourceDisposable,
    setBackendSessionIdDisposable,
    applyNextCodeActionDisposable,
    quizView,
    suggestionCodeLensProvider,
    suggestionCodeActionProvider,
    suggestionInlayHintProvider,
    suggestionStatusBar,
    suggestionDecorationType,
    vscode.languages.registerCodeLensProvider(textDocumentSelector, suggestionCodeLensProvider),
    vscode.languages.registerInlayHintsProvider(textDocumentSelector, suggestionInlayHintProvider),
    vscode.languages.registerCodeActionsProvider(
      textDocumentSelector,
      suggestionCodeActionProvider,
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) {
        // El foco se fue al panel de ADACEEN, a la terminal o a la salida:
        // el archivo sigue abierto, asi que no se toca nada. Si ya no queda ningun
        // archivo a la vista (se cerro el ultimo), la vista «Este archivo» se vacia.
        if (!vscode.window.visibleTextEditors.some((visible) => isSupportedActiveDocument(visible.document))) {
          setFileViewDocument(null);
        }
        return;
      }
      if (isSupportedActiveDocument(editor.document)) {
        setFileViewDocument(editor.document);
      }
      if (editor.document.uri.toString() !== selectionWidget.uriString) {
        selectionWidget.hide();
      }
      const activeUri = editor.document.uri.toString();
      if (activeUri !== lastActiveDocumentUri) {
        // La primera peticion de este archivo sale con trigger "file_open".
        setLastActiveDocumentUri(activeUri);
        setPendingFileOpenUri(activeUri);
      }
      refreshInlineSuggestionSurfaces();
      scheduleCursorIdleSuggestionRefresh();
      evaluateErrorSignals();
      if (fileView?.visible) {
        // Un poco despues, por si el estudiante solo esta pasando por las pestañas (desde la 0.0.40
        // la sugerencia del foco ya no trae el resumen: lo pide solo esta vista).
        setTimeout(() => {
          if (vscode.window.activeTextEditor?.document.uri.toString() === activeUri) {
            void requestFileSummary(false);
          }
        }, 4000);
      }
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      selectionWidget.onSelectionChanged(event.textEditor);
      if (vscode.window.activeTextEditor?.document.uri.toString() === event.textEditor.document.uri.toString()) {
        scheduleCursorIdleSuggestionRefresh();
        refreshInlineSuggestionSurfaces();
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (vscode.window.activeTextEditor?.document.uri.toString() === event.document.uri.toString()) {
        if (event.contentChanges.length > 0) {
          rememberEdit(event.document.uri.toString());
        }
        refreshInlineSuggestionSurfaces();
        scheduleCursorIdleSuggestionRefresh();
      }
      // Un #include o import nuevo aparece en el cuadro poco despues de dejar de escribir.
      if (event.contentChanges.length > 0 && fileViewDocument && event.document === fileViewDocument) {
        scheduleDependencyRefresh(1500);
      } else if (event.contentChanges.length > 0 && vscode.window.activeTextEditor?.document === event.document
        && event.document !== fileViewDocument && isSupportedActiveDocument(event.document)) {
        // Un archivo nuevo sin titulo (Ctrl+N) se rechazaba vacio y no se volvia a mirar al escribir.
        setFileViewDocument(event.document);
      } else if (event.contentChanges.length > 0 && !event.document.isDirty && event.document !== fileViewDocument
        && event.document.uri.scheme === 'file') {
        // Otro archivo abierto que VS Code volvio a leer del disco (git checkout, otro editor):
        // pudo empezar o dejar de incluir al de la vista.
        markDependencyIndexDirty();
        scheduleDependencyRefresh(800);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (fileViewDocument && document === fileViewDocument) {
        // Cambiar el lenguaje (un .tpp marcado como C++) tambien cierra y abre el documento: se
        // decide despues, con el editor que quede activo, en vez de vaciar la vista.
        setTimeout(() => {
          if (fileViewDocument !== document) {
            return;
          }
          const active = vscode.window.activeTextEditor?.document;
          setFileViewDocument(active && !active.isClosed && isSupportedActiveDocument(active) ? active : null);
        }, 0);
      }
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      // El mismo archivo con otro lenguaje: el cuadro se calcula otra vez con ese lenguaje.
      if (vscode.window.activeTextEditor?.document === document && isSupportedActiveDocument(document)) {
        setFileViewDocument(document);
      }
    }),
    vscode.languages.onDidChangeDiagnostics((event) => {
      const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
      if (activeUri && event.uris.some((uri) => uri.toString() === activeUri)) {
        evaluateErrorSignals();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      clearWorkspaceProjectIndexCache();
      // Otro archivo pudo empezar (o dejar) de incluir al de la vista: «La usan» cambia. Guardar
      // el mismo archivo de la vista no cambia quien lo usa (y lo suyo se lee del editor); queda
      // anotado para cuando se vea otro archivo.
      savedSinceDependencyIndex.add(document.uri.toString());
      if (document !== fileViewDocument) {
        markDependencyIndexDirty();
        scheduleDependencyRefresh(600);
      }
    }),
    // 0.0.36: archivos nuevos, borrados o renombrados (tambien desde la terminal o git). Antes el
    // indice no se enteraba hasta el siguiente guardado, y un .h recien creado seguia sin aparecer.
    (() => {
      const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, false, false);
      // Se mira la ruta dentro del proyecto: un proyecto guardado en una carpeta llamada build u
      // out ignoraba todo (revision del 25/10/2026).
      const ignored = /(?:^|\/)(?:node_modules|\.git|dist|build|out|coverage|\.next|target|bin|obj|vendor|__pycache__|\.vscode-test|\.venv|venv|site-packages|_deps|\.tox|\.gradle|\.mypy_cache|\.pytest_cache)\//;
      const onFilesChanged = (uri: vscode.Uri) => {
        if (ignored.test(workspaceRelativePath(uri))) {
          return;
        }
        clearWorkspaceProjectIndexCache();
        markDependencyIndexDirty();
        dependencyProbes.clear();
        dependencyBuildFiles.clear();
        scheduleDependencyRefresh(800);
      };
      watcher.onDidCreate(onFilesChanged);
      watcher.onDidDelete(onFilesChanged);
      // Cambios de codigo hechos fuera de VS Code (git pull, otro editor) en archivos que no estan
      // abiertos: «La usan» no se enteraba nunca. Los abiertos se ven por sus propios eventos (el
      // autoguardado del archivo de la vista no rearma el indice). Lo que se encontro en el disco
      // sigue valiendo: solo cambio el contenido.
      const sourceFile = /\.(?:c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|inl|ipp|tpp|txx|py|java|[cm]?[jt]sx?|vue|svelte|rb|cs)$/i;
      watcher.onDidChange((uri) => {
        if (!sourceFile.test(uri.path) || ignored.test(workspaceRelativePath(uri))
          || vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri.toString())) {
          return;
        }
        clearWorkspaceProjectIndexCache();
        markDependencyIndexDirty();
        scheduleDependencyRefresh(800);
      });
      return watcher;
    })(),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clearWorkspaceProjectIndexCache();
      clearBackendSuggestionCaches();
      markDependencyIndexDirty();
      dependencyProbes.clear();
      dependencyBuildFiles.clear();
      scheduleCursorIdleSuggestionRefresh();
      scheduleDependencyRefresh(500);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('adaceen.suggestions') ||
        event.affectsConfiguration('adaceen.backend')
      ) {
        clearBackendSuggestionCaches();
        clearWorkspaceProjectIndexCache();
        scheduleCursorIdleSuggestionRefresh();
      }
      if (event.affectsConfiguration('adaceen.scan')) {
        // El indice usa los filtros del escaneo (includeGlob, excludeGlob, mode).
        clearWorkspaceProjectIndexCache();
        markDependencyIndexDirty();
        dependencyProbes.clear();
        dependencyBuildFiles.clear();
        scheduleDependencyRefresh(500);
      }
      if (event.affectsConfiguration('adaceen.triggers')) {
        errorSignalTracker.updateSettings(errorSignalSettingsFromConfig());
        evaluateErrorSignals();
      }
      if (event.affectsConfiguration('comments.visible')) {
        // Comentarios ocultos: la ventana flotante no se ve y el CodeLens y la pista vuelven.
        suggestionCodeLensProvider.refresh();
        refreshInlineSuggestionSurfaces();
      }
    }),
    {
      dispose: () => {
        if (suggestionTimer) {
          clearTimeout(suggestionTimer);
          setSuggestionTimer(null);
        }
        clearCursorSuggestionTimers();
        clearErrorSignalTimer();
        if (selectionInlinePanelTimer) {
          clearTimeout(selectionInlinePanelTimer);
          setSelectionInlinePanelTimer(null);
        }
        if (dependencyTimer) {
          clearTimeout(dependencyTimer);
          setDependencyTimer(null);
        }
        clearSuggestionDecorations(suggestionDecorationType);
      },
    },
  );
}
