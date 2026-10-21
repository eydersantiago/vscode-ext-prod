import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  buildSelectionWidgetText,
  selectionWidgetActionLinks,
  selectionWidgetShowsTitleActions,
  selectionWidgetTitle,
} from '../selection-widget-text';
import type { SelectionWidgetModel } from '../selection-widget-text';

function model(patch: Partial<SelectionWidgetModel> = {}): SelectionWidgetModel {
  return {
    uriString: 'file:///repo/src/main.cpp',
    startLine: 84,
    endLine: 89,
    headline: 'El if no cubre el caso del cero.',
    completionText: '  if (x == 0) {\n    return 0;\n  }',
    completionMode: 'insert',
    language: 'cpp',
    recommendedMode: 'insert',
    source: 'backend',
    ragCourseCode: 'FPOO',
    loading: false,
    applied: false,
    ...patch,
  };
}

function decoded(text: string) {
  return decodeURIComponent(text);
}

describe('ventana flotante (0.0.34)', () => {
  it('con codigo para insertar: lo aplica con un clic, ver cambios y proponer una mejora', () => {
    const text = decoded(buildSelectionWidgetText(model()));
    assert.match(text, /\*\*Sugerencia para la selección\*\* \(líneas 84-89\) · tutor · material FPOO/);
    assert.match(text, /_Código para insertar debajo:_/);
    assert.match(text, /```cpp\n  if \(x == 0\) \{/);
    assert.match(text, /\*\*\[\$\(check\) Insertar debajo\]\(command:adaceen\.applySuggestionCompletion\?\["insert","selection_widget"\]\)\*\*/);
    assert.match(text, /\[\$\(diff\) Ver cambios\]\(command:adaceen\.showProposalDiff\?\["insert"\]\)/);
    assert.match(text, /\[\$\(sparkle\) Proponer una mejora\]\(command:adaceen\.applySuggestionCompletion\?\["replace","selection_widget"\]\)/);
    assert.doesNotMatch(text, /Proponer código para continuar/, 'ya trae codigo para insertar');
    assert.match(text, /Eliminar selección/);
    assert.match(text, /\[\$\(book\) Resumen y material\]\(command:adaceen\.openFileView/);
    assert.doesNotMatch(text, /Ver panel|openAssistant/, '«Ver panel» llevaba al quiz');
    assert.doesNotMatch(text, /TODO/);
    assert.match(text, /Ctrl\+Z \(⌘Z en Mac\)/);
  });

  it('una version mejorada se aplica como «Modificar selección»', () => {
    const improved = model({ completionMode: 'replace', recommendedMode: 'replace', requestedAction: 'replace' });
    assert.equal(selectionWidgetTitle(improved), 'Versión mejorada de la selección');
    const text = decoded(buildSelectionWidgetText(improved));
    assert.match(text, /_Versión mejorada \(reemplaza la selección\):_/);
    assert.match(text, /\*\*\[\$\(check\) Modificar selección\]/);
    assert.match(text, /Proponer código para continuar/);
    assert.doesNotMatch(text, /Proponer una mejora/);
  });

  it('sin codigo no ofrece aplicar nada inventado: deja pedirlo', () => {
    const noCode = model({ completionText: '', completionMode: '', recommendedMode: 'replace' });
    const links = selectionWidgetActionLinks(noCode).map(decoded);
    assert.ok(!links.some((link) => link.includes('$(check)')), 'no hay nada que aplicar con un clic');
    assert.ok(links.some((link) => link.includes('Proponer una mejora')));
    assert.ok(links.some((link) => link.includes('Proponer código para continuar')));
    const text = decoded(buildSelectionWidgetText(noCode));
    assert.match(text, /El tutor no escribió código para este bloque/);
    assert.doesNotMatch(text, /```/);

    const withNote = decoded(buildSelectionWidgetText({ ...noCode, codeRequestNote: 'No llegó el código del tutor.' }));
    assert.match(withNote, /No llegó el código del tutor\\?\./);
  });

  it('eliminar recomendado sin codigo es la accion principal', () => {
    const remove = model({ completionText: '', completionMode: '', recommendedMode: 'delete' });
    const links = selectionWidgetActionLinks(remove).map(decoded);
    assert.match(links[0], /^\*\*\[\$\(trash\) Eliminar selección\]/);
    assert.equal(links.filter((link) => link.includes('Eliminar selección')).length, 1);
  });

  it('mientras llega el codigo pedido, o si tarda, lo dice y no muestra acciones', () => {
    const pending = model({ pendingMode: 'replace' });
    assert.equal(selectionWidgetTitle(pending), 'Preparando una versión mejorada');
    const text = decoded(buildSelectionWidgetText(pending));
    assert.match(text, /\$\(sync~spin\) _Preparando la versión mejorada de las líneas 84-89…_/);
    assert.doesNotMatch(text, /applySuggestionCompletion/);
    assert.equal(selectionWidgetShowsTitleActions(pending), false);

    const slow = decoded(buildSelectionWidgetText(model({ loading: true, slow: true })));
    assert.match(slow, /El tutor está tardando más de lo normal/);
    assert.match(slow, /consultando al tutor/);
  });

  it('pista local por falta de respuesta: sin acciones de aplicar', () => {
    const fallback = model({ source: 'local-fallback', completionText: '', completionMode: '' });
    const text = decoded(buildSelectionWidgetText(fallback));
    assert.match(text, /pista local \(el tutor no respondió\)/);
    assert.match(text, /esta es una pista local, sin código/);
    assert.doesNotMatch(text, /applySuggestionCompletion/);
    assert.equal(selectionWidgetShowsTitleActions(fallback), false);
  });

  it('bloqueada por la politica o sin permiso de aplicar: solo guia', () => {
    const blocked = decoded(buildSelectionWidgetText(model({ blocked: true, tutorMessage: 'Tu docente pide intentarlo primero. [x](command:adaceen.applySuggestionCompletion)' })));
    assert.match(blocked, /\*\*Mensaje del tutor\*\*/);
    assert.doesNotMatch(blocked, /\(command:adaceen\.applySuggestionCompletion\)/, 'el texto del servidor no dispara comandos');

    const guide = decoded(buildSelectionWidgetText(model({ applyAllowed: false, applicationNote: 'Tu docente no permite aplicar código aquí.' })));
    assert.match(guide, /Tu docente no permite aplicar código aquí\\?\./);
    assert.doesNotMatch(guide, /applySuggestionCompletion/);
    assert.equal(selectionWidgetShowsTitleActions(model({ applyAllowed: false })), false);
    assert.equal(selectionWidgetShowsTitleActions(model()), true);
  });

  it('muestra el aviso de una version que quita casi todo el bloque', () => {
    const warned = decoded(buildSelectionWidgetText(model({ completionMode: 'replace', proposalWarning: 'Ojo: revísala con «Ver cambios».' })));
    assert.match(warned, /\$\(warning\) _Ojo: revísala con «Ver cambios»\._/);
  });
});
