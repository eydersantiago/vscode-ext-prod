// ADACEEN (VS Code): «Ver diagrama» de punta a punta (0.0.38).
//
// Abre el panel, lee el proyecto (diagram-scan.ts), lo vuelve a leer al guardar un archivo
// mientras el panel esta abierto (con espera, para no leer en cada guardado automatico) o con
// «Actualizar», marca el archivo activo en el grafo sin volver a leer y abre lo que se elige con
// un clic (solo rutas que el propio escaneo encontro). La telemetria lleva solo cuentas.
import * as vscode from 'vscode';
import type { BuildFileCache } from './dependency-scan';
import { buildDependencyGraphView, diagramTelemetryMetadata } from './diagram-model';
import type { DiagramViewState } from './diagram-model';
import { AdaceenDiagramPanel } from './diagram-panel';
import { activePathIn, scanDiagram } from './diagram-scan';
import type { DiagramScanResult } from './diagram-scan';
import type { TelemetryEventInput } from './telemetry';

/** Espera tras guardar antes de volver a leer el proyecto (con autoguardado se guarda cada segundo). */
export const DIAGRAM_SAVE_DEBOUNCE_MS = 1500;

export type DiagramControllerDeps = {
  buildFiles: BuildFileCache;
  track: (event: TelemetryEventInput) => void;
  pageContext: () => string;
  log: (line: string) => void;
};

function timeLabel(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export class DiagramController implements vscode.Disposable {
  private readonly panel: AdaceenDiagramPanel;
  private last: DiagramScanResult | null = null;
  private lastAt = '';
  private run = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Se guardo un archivo con el panel abierto pero oculto: se lee al volver a verse. */
  private stale = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: DiagramControllerDeps) {
    this.panel = new AdaceenDiagramPanel({
      refresh: () => {
        void this.rescan();
      },
      open: (path, line) => {
        void this.openPath(path, line);
      },
      onDispose: () => {
        this.clearSaveTimer();
      },
      onVisible: () => {
        // Se guardo algo mientras el panel estaba detras de otra pestaña.
        if (this.stale) {
          this.stale = false;
          void this.rescan();
        }
      },
    });
    this.disposables.push(
      this.panel,
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleRescan()),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        // Otro archivo activo: el grafo lo resalta sin volver a leer el proyecto.
        if (editor && this.panel.isOpen && this.last) {
          this.publish();
        }
      }),
    );
  }

  /** Comando «ADACEEN: Ver diagrama» y boton de la vista «Este archivo». */
  async open(origin: string) {
    const first = !this.panel.isOpen;
    this.panel.show();
    if (first || !this.last) {
      this.panel.update(this.loadingState());
    }
    const result = await this.rescan();
    if (result) {
      this.deps.track({
        source: 'vscode_extension',
        category: 'navigation',
        eventType: 'vscode_diagram_opened',
        pageContext: this.deps.pageContext(),
        value: origin,
        metadata: diagramTelemetryMetadata(result.target),
      });
    }
  }

  private loadingState(): DiagramViewState {
    return {
      status: 'loading',
      target: null,
      targetNote: 'Leyendo el proyecto…',
      dependencies: { nodes: [], edges: [], libraries: [], missing: [], hidden: 0 },
      updatedLabel: '',
    };
  }

  /** Vuelve a leer el proyecto; si mientras tanto se pidio otra lectura, esta se descarta. */
  private async rescan(): Promise<DiagramScanResult | null> {
    const run = ++this.run;
    try {
      const result = await scanDiagram({
        activeUri: vscode.window.activeTextEditor?.document.uri,
        buildFiles: this.deps.buildFiles,
        log: this.deps.log,
      });
      if (run !== this.run) {
        return null;
      }
      this.last = result;
      this.lastAt = timeLabel(new Date());
      this.publish();
      return result;
    } catch (error) {
      this.deps.log(`[Diagrama] No se pudo leer el proyecto: ${String(error)}`);
      return null;
    }
  }

  private publish() {
    const result = this.last;
    if (!result) {
      return;
    }
    const activePath = activePathIn(result, vscode.window.activeTextEditor?.document.uri);
    this.panel.update({
      status: 'ready',
      target: result.target,
      targetNote: result.targetNote,
      dependencies: buildDependencyGraphView(result.graph, activePath),
      updatedLabel: this.lastAt,
    });
  }

  private scheduleRescan() {
    if (!this.panel.isOpen) {
      return;
    }
    if (!this.panel.visible) {
      this.stale = true;
      return;
    }
    this.clearSaveTimer();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.rescan();
    }, DIAGRAM_SAVE_DEBOUNCE_MS);
  }

  private clearSaveTimer() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /** Abre una ruta del ultimo escaneo (el panel no puede pedir otra cosa). */
  private async openPath(path: string, line: number) {
    const uriString = this.last?.uris.get(path);
    if (!uriString) {
      return;
    }
    try {
      const editor = await vscode.window.showTextDocument(vscode.Uri.parse(uriString), { preview: true, viewColumn: vscode.ViewColumn.One });
      if (line > 0) {
        const target = Math.max(0, Math.min(editor.document.lineCount - 1, line - 1));
        const position = new vscode.Position(target, editor.document.lineAt(target).firstNonWhitespaceCharacterIndex);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    } catch (error) {
      this.deps.log(`[Diagrama] No se pudo abrir ${path}: ${String(error)}`);
    }
  }

  dispose() {
    this.clearSaveTimer();
    this.disposables.splice(0).forEach((item) => item.dispose());
  }
}
