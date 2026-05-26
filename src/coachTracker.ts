import * as vscode from 'vscode';
import { readCoachConfig } from './coachConfig';
import type { StallSignal } from './coachTypes';

type StallListener = (signal: StallSignal) => void | Promise<void>;

function diagnosticsHash(uri?: vscode.Uri): string {
  if (!uri) {return '';}
  return vscode.languages
    .getDiagnostics(uri)
    .filter((item) => item.severity === vscode.DiagnosticSeverity.Error)
    .map((item) => `${item.range.start.line}:${item.message}`)
    .join('|');
}

export class CoachActivityTracker {
  private lastUserActionAt = Date.now();
  private lastInterventionAt = 0;
  private lastDiagnosticHash = '';
  private readonly listeners: StallListener[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly subscriptions: vscode.Disposable[]) {}

  onSignal(listener: StallListener): void {
    this.listeners.push(listener);
  }

  start(): void {
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.touch()),
      vscode.window.onDidChangeTextEditorSelection(() => this.touch()),
      vscode.workspace.onDidChangeTextDocument(() => this.touch()),
      vscode.languages.onDidChangeDiagnostics((event) => this.handleDiagnostics(event)),
      vscode.tasks.onDidEndTaskProcess((event) => this.handleTaskEnd(event)),
    );

    this.timer = setInterval(() => this.checkIdle(), 5000);
    this.subscriptions.push({ dispose: () => this.timer && clearInterval(this.timer) });
  }

  markIntervention(): void {
    this.lastInterventionAt = Date.now();
  }

  private touch(): void {
    this.lastUserActionAt = Date.now();
  }

  private async emit(signal: StallSignal): Promise<void> {
    const now = Date.now();
    if (now - this.lastInterventionAt < 20000) {return;}

    this.markIntervention();
    for (const listener of this.listeners) {
      await listener(signal);
    }
  }

  private checkIdle(): void {
    const cfg = readCoachConfig();
    const waitMs = Date.now() - this.lastUserActionAt;

    if (waitMs >= cfg.idleThresholdMs) {
      void this.emit({
        event: 'idle_wait',
        waitMs,
        reason: `No hubo edicion ni cambio de seleccion durante ${Math.round(waitMs / 1000)} segundos.`,
      });
    }
  }

  private handleDiagnostics(event: vscode.DiagnosticChangeEvent): void {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (!active) {return;}
    if (!event.uris.some((uri) => uri.toString() === active.toString())) {return;}

    const nextHash = diagnosticsHash(active);
    if (!nextHash) {
      this.lastDiagnosticHash = '';
      return;
    }

    if (nextHash === this.lastDiagnosticHash) {
      void this.emit({
        event: 'diagnostic_repeat',
        waitMs: Date.now() - this.lastUserActionAt,
        reason: 'El mismo diagnostic de error sigue apareciendo despues de cambios recientes.',
        diagnosticMessage: nextHash.slice(0, 500),
      });
    }

    this.lastDiagnosticHash = nextHash;
  }

  private handleTaskEnd(event: vscode.TaskProcessEndEvent): void {
    if (event.exitCode && event.exitCode !== 0) {
      void this.emit({
        event: 'task_failed',
        waitMs: Date.now() - this.lastUserActionAt,
        reason: `La tarea "${event.execution.task.name}" termino con codigo ${event.exitCode}.`,
      });
    }
  }
}
