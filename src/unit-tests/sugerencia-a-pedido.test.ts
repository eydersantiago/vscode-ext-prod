// 0.0.40 (prueba del 5-11-2026: ~1 min por respuesta): al seleccionar ya no se consulta al tutor.
// La ventana se abre con «Sugerencia ADACEEN», «Proponer una mejora» y «Proponer código para
// continuar», y el tutor responde solo al pedido que el estudiante elija.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { buildFileViewState, FILE_VIEW_AWAITING_HEADLINE } from '../file-view-model';
import {
  buildSelectionWidgetText,
  SELECTION_WIDGET_COMMANDS,
  selectionWidgetRequestLinks,
  selectionWidgetTitle,
  selectionWidgetTitleActions,
} from '../selection-widget-text';
import type { SelectionWidgetModel } from '../selection-widget-text';
import { toSelectionWidgetModel } from '../selection-widget-model';
import { canOfferRecommendedAction, resolveDisplayedCode, suggestionPhase } from '../suggestion-phase';
import type { ActiveSuggestionModel } from '../types';

function awaiting(patch: Partial<SelectionWidgetModel> = {}): SelectionWidgetModel {
  return {
    uriString: 'file:///repo/src/Banco.cpp',
    startLine: 12,
    endLine: 18,
    // Lo que trae el modelo local: no es del tutor y no se muestra como pista.
    headline: 'Revisa el ciclo for de la linea 14.',
    completionText: '',
    completionMode: '',
    language: 'cpp',
    recommendedMode: 'insert',
    source: 'local',
    ragCourseCode: '',
    loading: false,
    applied: false,
    awaitingRequest: true,
    ...patch,
  };
}

function decoded(text: string) {
  return decodeURIComponent(text);
}

const material = { status: 'idle', courseCode: '', items: [], message: '' } as unknown as Parameters<typeof buildFileViewState>[3];

describe('sugerencia a pedido (0.0.40)', () => {
  it('fase propia: despues de cargar y de pedir codigo, antes de bloqueada o sin modelo', () => {
    assert.equal(suggestionPhase({ source: 'local', awaitingRequest: true }), 'awaiting_request');
    assert.equal(suggestionPhase({ source: 'local', awaitingRequest: true, loading: true }), 'loading');
    // «Proponer una mejora» desde las opciones: el modelo pendiente es el de las opciones.
    assert.equal(suggestionPhase({ source: 'local', awaitingRequest: true, pendingMode: 'replace' }), 'pending');
    assert.equal(suggestionPhase({ source: 'local', awaitingRequest: true, blocked: true }), 'awaiting_request');
  });

  it('sin pedido no hay «Aceptar ayuda» ni codigo que mostrar', () => {
    assert.equal(canOfferRecommendedAction({ source: 'local', awaitingRequest: true, completionText: 'x++;', completionMode: 'insert', applyMode: 'insert' }), false);
    assert.deepEqual(resolveDisplayedCode({ source: 'local', awaitingRequest: true, completionText: 'x++;', completionMode: 'insert' }), { kind: 'none' });
  });

  it('la ventana ofrece los tres pedidos y nada que aplicar', () => {
    const model = awaiting();
    assert.equal(selectionWidgetTitle(model), 'Ayuda para la selección');
    assert.equal(selectionWidgetTitleActions(model), 'request');
    const text = decoded(buildSelectionWidgetText(model));
    assert.match(text, /^\*\*Ayuda para la selección\*\* \(líneas 12-18\) · ADACEEN/);
    assert.match(text, /\*\*\[\$\(lightbulb\) Sugerencia ADACEEN\]\(command:adaceen\.requestSuggestion\?\["selection_widget"\]\)\*\*/);
    assert.match(text, /\[\$\(sparkle\) Proponer una mejora\]\(command:adaceen\.applySuggestionCompletion\?\["replace","selection_widget"\]\)/);
    assert.match(text, /\[\$\(add\) Proponer código para continuar\]\(command:adaceen\.applySuggestionCompletion\?\["insert","selection_widget"\]\)/);
    assert.match(text, /\[\$\(book\) Resumen y material\]\(command:adaceen\.openFileView/);
    assert.match(text, /El tutor responde solo cuando lo pides/);
    assert.doesNotMatch(text, /Revisa el ciclo for/, 'la pista local no se presenta como del tutor');
    assert.doesNotMatch(text, /Eliminar selección|Insertar debajo|Ver cambios|Otra sugerencia|consultando al tutor|```/);
  });

  it('un pedido de codigo que volvio sin codigo deja su nota sobre las opciones', () => {
    const text = decoded(buildSelectionWidgetText(awaiting({ codeRequestNote: 'No llegó el código del tutor (timeout). Intenta de nuevo en un momento.' })));
    assert.match(text, /_No llegó el código del tutor \\\(timeout\\\)\. Intenta de nuevo en un momento\._/);
    assert.doesNotMatch(text, /El tutor responde solo cuando lo pides/);
    assert.match(text, /Sugerencia ADACEEN/);
  });

  it('los enlaces solo abren comandos permitidos en la ventana', () => {
    for (const link of selectionWidgetRequestLinks()) {
      const command = /\(command:([\w.]+)\?/.exec(link)?.[1] || '';
      assert.ok(SELECTION_WIDGET_COMMANDS.includes(command), command);
    }
  });

  it('una respuesta lista ya no esta a pedido: vuelven los botones de aplicar', () => {
    const ready = awaiting({ awaitingRequest: false, source: 'backend', completionText: 'cuenta.depositar(monto);', completionMode: 'insert' });
    assert.equal(selectionWidgetTitleActions(ready), 'apply');
    assert.equal(selectionWidgetTitleActions(awaiting({ loading: true })), 'readonly');
  });

  it('el modelo de la ventana lleva la bandera de la sugerencia', () => {
    const active = {
      uriString: 'file:///repo/src/Banco.cpp',
      line: 12,
      selectionLineCount: 7,
      lineSuggestions: [],
      fileSuggestions: [],
      suggestions: [],
      summary: '',
      fileOverview: '',
      source: 'local',
      awaitingRequest: true,
    } as unknown as ActiveSuggestionModel;
    const widget = toSelectionWidgetModel(active);
    assert.ok(widget);
    assert.equal(widget.awaitingRequest, true);
    assert.equal(widget.endLine, 18);
  });

  it('«Este archivo» dice que elegir en vez de la pista local', () => {
    const active = {
      uriString: 'file:///repo/src/Banco.cpp',
      fileName: 'Banco.cpp',
      language: 'cpp',
      line: 12,
      selectionLineCount: 7,
      triggerKind: 'cursor',
      lineSummary: 'Revisa el ciclo for de la linea 14.',
      lineSuggestions: ['Revisa el ciclo for de la linea 14.'],
      fileSuggestions: [],
      suggestions: [],
      ragSources: [],
      source: 'local',
      awaitingRequest: true,
    } as unknown as ActiveSuggestionModel;
    const state = buildFileViewState(active, null, false, material);
    assert.equal(state.suggestion?.headline, FILE_VIEW_AWAITING_HEADLINE);
    assert.equal(state.suggestion?.status, 'sin consultar al tutor');
  });
});

describe('package.json (0.0.40)', () => {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    version: string;
    contributes: {
      commands: Array<{ command: string; title: string; icon?: string }>;
      menus: Record<string, Array<{ command: string; when: string; group?: string }>>;
    };
  };

  it('los botones del titulo de la ventana a pedido existen, en orden, y no salen en la paleta', () => {
    const request = 'commentController == adaceen.selection && commentThread == adaceen-suggestion-request';
    const title = manifest.contributes.menus['comments/commentThread/title'].filter((item) => item.when === request);
    assert.deepEqual(title.map((item) => item.command), [
      'adaceen.selectionWidget.suggest',
      'adaceen.selectionWidget.proposeImprovement',
      'adaceen.selectionWidget.proposeContinuation',
    ]);
    for (const item of title) {
      const command = manifest.contributes.commands.find((entry) => entry.command === item.command);
      assert.ok(command?.icon, `${item.command} con icono`);
      assert.ok(manifest.contributes.menus.commandPalette.some((entry) => entry.command === item.command && entry.when === 'false'), `${item.command} fuera de la paleta`);
    }
    // El hilo con respuesta lista conserva Insertar / Modificar / Eliminar.
    assert.ok(manifest.contributes.menus['comments/commentThread/title'].some((item) => item.command === 'adaceen.selectionWidget.insert'
      && item.when === 'commentController == adaceen.selection && commentThread == adaceen-suggestion'));
  });

  it('«Sugerencia para la selección» esta en la paleta', () => {
    assert.ok(manifest.contributes.commands.some((item) => item.command === 'adaceen.requestSuggestion'));
    assert.ok(!manifest.contributes.menus.commandPalette.some((item) => item.command === 'adaceen.requestSuggestion'));
  });
});
