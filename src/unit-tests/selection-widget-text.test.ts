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

  it('sin modelo (GPU apagada): dice que el tutor no esta disponible y nada mas (piloto del 25/10)', () => {
    const offline = model({
      tutorUnavailable: true,
      headline: 'El tutor no esta disponible en este momento: el servidor del modelo no respondio.',
      completionText: '',
      completionMode: '',
      codeRequestNote: 'El tutor respondió sin código para esto. Prueba «Otra sugerencia» o escríbelo con la pista.',
      applicationNote: 'Te quedan 3 aplicaciones en este archivo.',
    });
    const text = decoded(buildSelectionWidgetText(offline));
    assert.match(text, /· tutor no disponible/);
    assert.match(text, /El tutor no está disponible ahora: el servidor del modelo no respondió\./);
    assert.match(text, /Otra sugerencia/);
    assert.doesNotMatch(text, /respondió sin código/, 'no dice que respondio');
    assert.doesNotMatch(text, /Proponer una mejora|Proponer código para continuar|Eliminar selección|Te quedan/);
    assert.equal(selectionWidgetShowsTitleActions(offline), false);
  });

  it('bloqueada por la politica o sin permiso de aplicar: solo guia', () => {
    const blocked = decoded(buildSelectionWidgetText(model({ blocked: true, tutorMessage: 'Tu docente pide intentarlo primero. [x](command:adaceen.applySuggestionCompletion)' })));
    assert.match(blocked, /\*\*Mensaje del tutor\*\*/);
    assert.doesNotMatch(blocked, /\(command:adaceen\.applySuggestionCompletion\)/, 'el texto del servidor no dispara comandos');

    const guide = decoded(buildSelectionWidgetText(model({ codeApplication: { allowed: false, reason: 'Tu docente no permite aplicar código aquí.', reasonCode: 'code_application_disabled' }, applicationNote: 'Tu docente no permite aplicar código aquí.' })));
    assert.match(guide, /Tu docente no permite aplicar código aquí\\?\./);
    assert.doesNotMatch(guide, /applySuggestionCompletion/);
    assert.equal(selectionWidgetShowsTitleActions(model({ codeApplication: { allowed: false, reason: '', reasonCode: 'code_application_disabled' } })), false);
    assert.equal(selectionWidgetShowsTitleActions(model()), true);
  });

  it('muestra el aviso de una version que quita casi todo el bloque', () => {
    const warned = decoded(buildSelectionWidgetText(model({ completionMode: 'replace', proposalWarning: 'Ojo: revísala con «Ver cambios».' })));
    assert.match(warned, /\$\(warning\) _Ojo: revísala con «Ver cambios»\._/);
  });
});

describe('ventana con la explicacion en vivo (0.0.39)', () => {
  it('cargando con texto en vivo: la explicacion sanitizada en vez de «Cuando llegue la respuesta...» y la nota de que el codigo va al final', () => {
    const live = model({
      loading: true,
      headline: 'Pista local que no debe verse',
      partialText: '1) Resumen:\n- El main saluda. [abrir](command:adaceen.applySuggestionCompletion?["insert"])\n\n2) Sugerencias del codigo:\n- Agrega una despedida.',
    });
    const text = buildSelectionWidgetText(live);
    assert.match(text, /consultando al tutor/);
    assert.match(text, /el código y las acciones aparecen al terminar/);
    assert.doesNotMatch(text, /Cuando llegue la respuesta/);
    assert.match(text, /\*\*Resumen\*\*/);
    assert.match(text, /- Agrega una despedida\./);
    assert.doesNotMatch(text, /command:adaceen/, 'un enlace command: del texto en vivo no queda activo');
    assert.doesNotMatch(text, /Pista local que no debe verse/, 'la pista local no se mezcla con la explicacion');
    assert.doesNotMatch(text, /Insertar debajo|Ver cambios/, 'ninguna accion mientras carga');
  });

  it('en vivo nunca se pinta un bloque de codigo aunque llegara uno, ni una imagen remota', () => {
    const text = buildSelectionWidgetText(model({ loading: true, partialText: '- Mira esto ![x](https://evil.example/a.png)\n```cpp\nint x = 0;\n```' }));
    assert.doesNotMatch(text, /```cpp|int x = 0/);
    assert.doesNotMatch(text, /!\[/);
  });

  it('sin texto en vivo, cargando sigue como antes', () => {
    const text = buildSelectionWidgetText(model({ loading: true }));
    assert.match(text, /Cuando llegue la respuesta aparecen aquí el código y las acciones\./);
  });

  it('una explicacion en vivo larga se corta en lo que cabe y no cambia mas hasta el final', () => {
    const long = Array.from({ length: 30 }, (_, index) => `- Paso ${index + 1}: revisa la condicion y prueba con valores distintos.`).join('\n');
    const first = buildSelectionWidgetText(model({ loading: true, partialText: long }));
    const later = buildSelectionWidgetText(model({ loading: true, partialText: `${long}\n- Paso 31: otra cosa.` }));
    assert.equal(first, later, 'ya cortada, no cambia (no salta el scroll)');
    assert.match(first, /el resto de la explicación aparece al terminar/);
    assert.match(first, /Paso 1:/);
    assert.doesNotMatch(first, /Paso 30:/);
  });

  it('pidiendo codigo: la espera y debajo la explicacion en vivo', () => {
    const text = buildSelectionWidgetText(model({ pendingMode: 'replace', partialText: '- Cambia el orden de las lineas.' }));
    assert.match(text, /Preparando la versión mejorada/);
    assert.match(text, /- Cambia el orden de las lineas\./);
  });

  it('lista: la explicacion completa (lo leido en vivo) y debajo el codigo y las acciones', () => {
    const ready = model({
      explanationText: '1) Resumen:\n- El if no cubre el caso del cero.\n\n2) Sugerencias del codigo:\n- Agrega la rama del cero.\n\n6) Riesgos:\n- Compila despues.',
    });
    const text = buildSelectionWidgetText(ready);
    const explanationAt = text.indexOf('Agrega la rama del cero.');
    const codeAt = text.indexOf('```cpp');
    const actionAt = text.indexOf('Insertar debajo');
    assert.ok(explanationAt > 0 && codeAt > explanationAt && actionAt > codeAt, 'explicacion, codigo, acciones');
    assert.match(text, /\*\*Riesgos\*\*/);
    assert.equal((text.match(/El if no cubre el caso del cero\./g) || []).length, 1, 'el titular no se repite');
  });

  it('lista y larga: avisa que el codigo y las acciones estan al final (scroll dentro de la ventana)', () => {
    const long = Array.from({ length: 20 }, (_, index) => `- Idea ${index + 1}: una explicacion de una linea para el estudiante.`).join('\n');
    const text = buildSelectionWidgetText(model({ explanationText: long }));
    assert.match(text, /El código y las acciones están al final de la ventana/);
    assert.ok(text.indexOf('Idea 20') < text.indexOf('```cpp'));
    const noCode = buildSelectionWidgetText(model({ explanationText: long, completionText: '', completionMode: '' }));
    assert.match(noCode, /Las acciones están al final de la ventana/);
  });

  it('lista sin explicacion (pista local o historial anterior): el titular como antes', () => {
    const text = buildSelectionWidgetText(model());
    assert.match(text, /El if no cubre el caso del cero\./);
  });
});

describe('explicacion del tutor en la ventana: ningun enlace activo (0.0.39)', () => {
  it('enlaces, imagenes, definiciones, autoenlaces y entidades quedan como texto; el codigo entre comillas no se toca', () => {
    const text = buildSelectionWidgetText(model({
      explanationText: [
        '1) Resumen:',
        '- Mira [esto](command&#58;adaceen.applySuggestionCompletion) y ![img](https://x.example/a.png).',
        '[ref]: command:adaceen.selectionWidget.close',
        '- Abre <https://x.example> si quieres.',
        '- Usa `a[i](x)` en el bucle.',
      ].join('\n'),
    }));
    assert.doesNotMatch(text, /\]\(command&#58;/, 'el destino con entidad no queda como enlace');
    assert.doesNotMatch(text, /!\[img\]/);
    assert.match(text, /\\\[ref\]:/);
    assert.match(text, /\\<https/);
    assert.match(text, /`a\[i\]\(x\)`/, 'el codigo entre comillas se ve igual');
    assert.match(text, /\*\*Resumen\*\*/);
  });
});
