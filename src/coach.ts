import * as vscode from 'vscode';
import { CoachBackendClient } from './coachApi';
import { readCoachConfig } from './coachConfig';
import {
  activeErrorDiagnostics,
  buildMentorContext,
  buildProjectMemoryPayload,
} from './coachContext';
import { CoachViewProvider, type CoachPanelAction } from './coachPanel';
import { CoachActivityTracker } from './coachTracker';
import type { GithubMentorResult, ProjectMemoryMetrics, StallSignal } from './coachTypes';

type ActionQuickPickItem = vscode.QuickPickItem & {
  action: 'followup' | 'explainError' | 'plan' | 'panel' | 'saveMemory';
  value?: string;
};

const metrics: ProjectMemoryMetrics = {
  suggestionsReceived: 0,
  suggestionsAccepted: 0,
  errorsDetected: 0,
  quizzesTaken: 0,
};

let latestResult: GithubMentorResult | undefined;

function compactQuestion(signal?: StallSignal): string {
  if (!signal) {
    return 'Dame recomendaciones profesionales para avanzar en este archivo sin entregar la solucion completa.';
  }

  if (signal.event === 'idle_wait') {
    return `Detecte posible estancamiento por espera: ${signal.reason}. Da opciones accionables y una guia breve.`;
  }

  if (signal.event === 'diagnostic_repeat') {
    return `El usuario parece bloqueado con un diagnostic repetido: ${signal.diagnosticMessage || signal.reason}. Sugiere pistas progresivas.`;
  }

  if (signal.event === 'task_failed') {
    return `Una tarea fallo: ${signal.reason}. Sugiere como depurar sin inventar datos.`;
  }

  return `Analiza el estado actual y sugiere proximos pasos: ${signal.reason}`;
}

function firstIdea(result: GithubMentorResult): string {
  return result.ideas[0] || result.guide[0] || result.analysis_summary || 'recomendacion disponible';
}

function updateMetricsFromResult(result: GithubMentorResult): void {
  metrics.suggestionsReceived += result.ideas.length;
  const activeErrors = activeErrorDiagnostics().length;
  if (activeErrors > 0) {
    metrics.errorsDetected += activeErrors;
  }
}

async function saveMemory(client: CoachBackendClient): Promise<void> {
  const payload = await buildProjectMemoryPayload(metrics);
  const ok = await client.saveProjectMemory(payload);
  if (ok) {
    vscode.window.showInformationMessage('ADACEEN: memoria del proyecto guardada.');
  } else {
    vscode.window.showWarningMessage('ADACEEN: no se pudo guardar la memoria del proyecto.');
  }
}

async function showQuickPick(
  result: GithubMentorResult,
  client: CoachBackendClient,
  panel: CoachViewProvider,
  requestRecommendation: (question?: string, signal?: StallSignal) => Promise<void>,
): Promise<void> {
  const options: ActionQuickPickItem[] = [
    ...result.ideas.slice(0, 5).map<ActionQuickPickItem>((idea, index) => ({
      label: `$(sparkle) Opcion ${index + 1}`,
      description: idea.slice(0, 84),
      detail: idea,
      action: 'followup',
      value: idea,
    })),
    {
      label: '$(debug-alt) Explicar diagnostic visible',
      description: 'Pedir una explicacion guiada del error actual',
      action: 'explainError',
    },
    {
      label: '$(checklist) Crear plan de 3 pasos',
      description: 'Convertir el bloqueo en una ruta corta',
      action: 'plan',
    },
    {
      label: '$(save) Guardar memoria del proyecto',
      description: 'Persistir snapshot del workspace en el backend',
      action: 'saveMemory',
    },
    {
      label: '$(layout-sidebar-right) Ver panel completo',
      description: 'Abrir recomendaciones persistentes',
      action: 'panel',
    },
  ];

  const picked = await vscode.window.showQuickPick(options, {
    title: 'ADACEEN: como quieres avanzar?',
    placeHolder: 'Selecciona una ayuda contextual',
    ignoreFocusOut: false,
  });

  if (!picked) {return;}

  if (picked.action === 'panel') {
    panel.reveal();
    return;
  }

  if (picked.action === 'saveMemory') {
    await saveMemory(client);
    return;
  }

  if (picked.action === 'explainError') {
    await requestRecommendation('Explica el diagnostic visible y sugiere proximos pasos sin entregar la solucion completa.');
    return;
  }

  if (picked.action === 'plan') {
    await requestRecommendation('Convierte el bloqueo actual en un plan de 3 pasos verificables.');
    return;
  }

  metrics.suggestionsAccepted += 1;
  await requestRecommendation(`El usuario eligio esta opcion: ${picked.value || picked.detail || picked.label}. Profundiza sin resolver todo por el usuario.`);
}

function registerHoverProvider(context: vscode.ExtensionContext): void {
  const provider: vscode.HoverProvider = {
    provideHover() {
      if (!latestResult) {return undefined;}

      const md = new vscode.MarkdownString();
      md.isTrusted = { enabledCommands: ['pdcCoach.ask', 'pdcCoach.openPanel'] };
      md.appendMarkdown('$(sparkle) **ADACEEN**\n\n');
      md.appendMarkdown(`${latestResult.ideas.slice(0, 2).map((item) => `- ${item}`).join('\n')}\n\n`);
      md.appendMarkdown('[Pedir pista](command:pdcCoach.ask) | [Abrir panel](command:pdcCoach.openPanel)');

      return new vscode.Hover(md);
    },
  };

  for (const scheme of ['file', 'vscode-remote', 'untitled']) {
    context.subscriptions.push(vscode.languages.registerHoverProvider({ scheme }, provider));
  }
}

function registerCodeActions(context: vscode.ExtensionContext): void {
  const provider: vscode.CodeActionProvider = {
    provideCodeActions(document, _range, actionContext) {
      const active = vscode.window.activeTextEditor;
      const hasSelection = !!active && active.document.uri.toString() === document.uri.toString() && !active.selection.isEmpty;
      const hasDiagnostics = actionContext.diagnostics.some(
        (item) => item.severity === vscode.DiagnosticSeverity.Error,
      );

      if (!hasSelection && !hasDiagnostics) {
        return [];
      }

      const ask = new vscode.CodeAction('ADACEEN: dame una pista contextual', vscode.CodeActionKind.QuickFix);
      ask.command = {
        title: 'ADACEEN: dame una pista contextual',
        command: 'pdcCoach.ask',
        arguments: ['Dame una pista contextual cerca del cursor. No entregues la solucion completa.'],
      };

      const explain = new vscode.CodeAction('ADACEEN: explica el error sin resolverlo por mi', vscode.CodeActionKind.QuickFix);
      explain.command = {
        title: 'ADACEEN: explica error',
        command: 'pdcCoach.ask',
        arguments: ['Explica el error visible y sugiere proximos pasos sin entregar la solucion completa.'],
      };

      return hasDiagnostics ? [explain, ask] : [ask];
    },
  };

  for (const scheme of ['file', 'vscode-remote', 'untitled']) {
    context.subscriptions.push(
      vscode.languages.registerCodeActionsProvider({ scheme }, provider, {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }),
    );
  }
}

export function activateCoach(context: vscode.ExtensionContext): void {
  const client = new CoachBackendClient();
  const panel = new CoachViewProvider(context.extensionUri);
  const tracker = new CoachActivityTracker(context.subscriptions);
  let inFlight = false;

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.text = '$(sparkle) ADACEEN';
  status.tooltip = 'Pedir recomendacion contextual';
  status.command = 'pdcCoach.ask';
  status.show();

  context.subscriptions.push(status);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(CoachViewProvider.viewType, panel));

  const requestRecommendation = async (question?: string, signal?: StallSignal): Promise<void> => {
    if (inFlight) {return;}
    inFlight = true;
    status.text = '$(sync~spin) ADACEEN';

    try {
      const mentorContext = await buildMentorContext();
      const result = await client.mentor(question || compactQuestion(signal), mentorContext, 5);

      latestResult = result;
      panel.update(result, signal);
      tracker.markIntervention();
      updateMetricsFromResult(result);

      status.text = '$(sparkle) ADACEEN';
      status.tooltip = `${firstIdea(result)}\nLatencia backend: ${client.lastLatencyMs} ms`;

      const cfg = readCoachConfig();
      if (signal && cfg.showQuickPickOnSignal) {
        await showQuickPick(result, client, panel, requestRecommendation);
      } else {
        vscode.window.setStatusBarMessage(`ADACEEN: ${firstIdea(result)}`, 6000);
      }
    } finally {
      inFlight = false;
      status.text = '$(sparkle) ADACEEN';
    }
  };

  panel.onAction(async (action: CoachPanelAction) => {
    if (action.command === 'pickIdea') {
      metrics.suggestionsAccepted += 1;
      await requestRecommendation(`El usuario eligio esta opcion del panel: ${action.value}. Profundiza con una ayuda guiada.`);
      return;
    }
    if (action.command === 'openQuickPick') {
      if (latestResult) {
        await showQuickPick(latestResult, client, panel, requestRecommendation);
      }
      return;
    }
    if (action.command === 'saveMemory') {
      await saveMemory(client);
      return;
    }
    await requestRecommendation();
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('pdcCoach.ask', async (question?: string) => {
      await requestRecommendation(question || compactQuestion());
    }),
    vscode.commands.registerCommand('pdcCoach.openPanel', () => {
      panel.reveal();
    }),
    vscode.commands.registerCommand('pdcCoach.saveProjectMemory', async () => {
      await saveMemory(client);
    }),
  );

  tracker.onSignal(async (signal) => {
    await requestRecommendation(compactQuestion(signal), signal);
  });

  registerHoverProvider(context);
  registerCodeActions(context);
  tracker.start();

  void requestRecommendation('Inicia con un saludo breve y explica como puedes ayudar dentro de VS Code o Codespaces.');
}
