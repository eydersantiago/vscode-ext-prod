import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { FileDependencies } from '../file-dependencies';
import { buildDependencyViewState, buildFileViewState, EMPTY_MATERIAL_STATE } from '../file-view-model';
import type { ActiveSuggestionModel } from '../types';

// Vista «Este archivo» 0.0.36: el archivo es el del editor activo y trae el cuadro «Dependencias».

function model(patch: Partial<ActiveSuggestionModel> = {}): ActiveSuggestionModel {
  return {
    uriString: 'file:///repo/src/main.cpp',
    filePath: 'src/main.cpp',
    fileName: 'main.cpp',
    language: 'cpp',
    repoFullName: '',
    title: '',
    summary: '',
    fileOverview: 'Lee medidas y calcula areas.',
    fileOverviewFromTutor: true,
    lineSummary: 'El if no cubre el cero.',
    suggestions: ['El if no cubre el cero.'],
    fileSuggestions: ['Valida la entrada.'],
    lineSuggestions: [],
    nextSteps: [],
    chips: [],
    source: 'backend',
    backendError: '',
    ragSources: [],
    ragCourseCode: '',
    updatedAt: '',
    line: 12,
    column: 1,
    selectionLineCount: 0,
    selectionOriginalLineCount: 0,
    selectionTruncated: false,
    selectionRangeKey: '',
    fileSummaryCacheKey: 'k',
    metricId: 'm1',
    completionText: '',
    completionMode: '',
    applyMode: 'insert',
    triggerKind: 'cursor',
    ...patch,
  } as ActiveSuggestionModel;
}

const DEPS: FileDependencies = {
  family: 'c',
  local: [
    { label: 'figura.h', line: 3, path: 'src/figura.h', symbols: ['Figura', 'area()'] },
    { label: 'modelo/rectangulo.h', line: 4, path: 'src/modelo/rectangulo.h', warning: 'En Linux el nombre debe coincidir.' },
  ],
  libraries: [{ label: 'iostream', line: 1, description: 'entrada y salida por consola (cin, cout)' }],
  missing: [{ label: 'lista.tpp', line: 6, description: 'Revisa el nombre y la carpeta.', hint: '¿Quisiste decir «src/lista.hpp»?' }],
  dependents: [],
  probes: [],
};

describe('vista «Este archivo» con el editor activo (0.0.36)', () => {
  it('al cambiar de pestaña no muestra el resumen ni la sugerencia del archivo anterior', () => {
    const activeFile = { uriString: 'file:///repo/src/figura.h', fileName: 'figura.h', language: 'cpp' };
    const state = buildFileViewState(model(), null, false, EMPTY_MATERIAL_STATE, { activeFile });
    assert.equal(state.hasFile, true);
    assert.equal(state.fileName, 'figura.h');
    assert.equal(state.overview, '', 'el resumen de main.cpp no va con el nombre de figura.h');
    assert.equal(state.suggestion, null);
    assert.deepEqual(state.tips, []);
    assert.equal(state.focusLabel, '');
  });

  it('con el mismo archivo usa la sugerencia; sin archivo abierto, nada (aunque quede una sugerencia vieja)', () => {
    const same = buildFileViewState(model(), null, false, EMPTY_MATERIAL_STATE, { activeFile: { uriString: 'file:///repo/src/main.cpp', fileName: 'main.cpp', language: 'cpp' } });
    assert.equal(same.overview, 'Lee medidas y calcula areas.');
    assert.equal(same.focusLabel, 'Línea 12');
    const none = buildFileViewState(model(), null, true, EMPTY_MATERIAL_STATE, { activeFile: null });
    assert.equal(none.hasFile, false);
    assert.equal(none.summaryLoading, false);
    assert.equal(none.dependencies, null);
    const legacy = buildFileViewState(model(), null, false, EMPTY_MATERIAL_STATE);
    assert.equal(legacy.fileName, 'main.cpp', 'sin el campo, como en la 0.0.34');
  });
});

describe('cuadro «Dependencias» (0.0.36)', () => {
  it('arma los grupos con su texto y el resumen de la cabecera', () => {
    const view = buildDependencyViewState(DEPS, 'src/main.cpp', false);
    assert.ok(view);
    assert.equal(view.status, 'ready');
    assert.equal(view.summary, '2 del proyecto · 1 biblioteca · 1 sin encontrar');
    assert.deepEqual(view.local.map((item) => [item.label, item.meta, item.title]), [
      ['figura.h', 'Figura, area() · línea 3', 'Abrir src/figura.h'],
      ['rectangulo.h', 'en src/modelo/ · línea 4', 'Abrir src/modelo/rectangulo.h'],
    ]);
    assert.equal(view.local[1].warning, 'En Linux el nombre debe coincidir.');
    assert.deepEqual(view.libraries.map((item) => [item.label, item.meta, item.title]), [['iostream', 'entrada y salida por consola (cin, cout)', 'Ir a la línea 1']]);
    assert.equal(view.missing[0].meta, '¿Quisiste decir «src/lista.hpp»?', 'con sugerencia basta la sugerencia');
    assert.equal(view.emptyUses, '');
    assert.equal(view.emptyDependents, '', 'que nadie incluya un main.cpp es lo normal');
  });

  it('un encabezado que nadie incluye lo dice; una clase del mismo paquete dice que va sin import', () => {
    const header = buildDependencyViewState({ ...DEPS, local: [], libraries: [], missing: [] }, 'src/figura.h', false);
    assert.equal(header?.emptyUses, 'No usa otros archivos ni bibliotecas.');
    assert.equal(header?.emptyDependents, 'Ningún archivo del proyecto lo incluye todavía.');
    const java = buildDependencyViewState({
      family: 'java',
      local: [{ label: 'Utilidades', line: 8, path: 'src/Utilidades.java', implicit: true }],
      libraries: [],
      missing: [],
      dependents: [{ label: 'App.java', line: 0, path: 'src/App.java', implicit: true }],
      probes: [],
    }, 'src/Figura.java', false, true);
    assert.equal(java?.local[0].meta, 'sin import: es del mismo paquete');
    assert.equal(java?.dependents[0].title, 'Abrir src/App.java');
    assert.match(java?.note || '', /puede estar incompleta/);
  });

  it('mientras busca muestra «cargando»; un archivo sin dependencias que nadie usa no lleva cuadro', () => {
    assert.equal(buildDependencyViewState(null, 'src/main.cpp', true)?.status, 'loading');
    assert.equal(buildDependencyViewState(null, 'src/main.cpp', false), null);
    assert.equal(buildDependencyViewState({ family: 'none', local: [], libraries: [], missing: [], dependents: [], probes: [] }, 'README.md', false), null);
    const css = buildDependencyViewState({ family: 'none', local: [], libraries: [], missing: [], dependents: [{ label: 'app.js', line: 2, path: 'src/app.js' }], probes: [] }, 'src/estilos.css', false);
    assert.equal(css?.dependents[0].meta, 'línea 2');
    assert.equal(css?.emptyUses, '');
  });

  it('el estado de la vista lleva el cuadro solo con archivo', () => {
    const view = buildDependencyViewState(DEPS, 'src/main.cpp', false);
    const state = buildFileViewState(null, null, false, EMPTY_MATERIAL_STATE, {
      activeFile: { uriString: 'file:///repo/src/main.cpp', fileName: 'main.cpp', language: 'cpp' },
      dependencies: view,
    });
    assert.equal(state.dependencies?.summary, '2 del proyecto · 1 biblioteca · 1 sin encontrar');
    assert.equal(state.hasFile, true, 'sin sugerencia todavia, la vista igual muestra el archivo');
  });
});
