import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  courseMaterialListUrl,
  courseMaterialViewerUrl,
  filterCourseMaterial,
  normalizeCourseMaterial,
} from '../course-material';
import { buildFileViewState, EMPTY_MATERIAL_STATE, focusLabelFor } from '../file-view-model';
import type { ActiveSuggestionModel } from '../types';

const BACKEND = 'https://app-adaceen-api-eyder05232002.azurewebsites.net';

const RESPONSE = {
  ok: true,
  courseCode: 'FPOO',
  sources: [
    { id: 'src-2', title: 'Programación orientada a objetos', fileName: 'poo.pdf', courseCode: 'FPOO', knowledgeTier: 'core', textPreview: 'Clases   y objetos\nen C++', isActive: true, isEnabled: true },
    { id: 'src-1', title: 'Arreglos y matrices', fileName: 'arreglos.pdf', courseCode: 'FPOO', knowledgeTier: 'core', isEnabled: true },
    { id: 'src-3', title: 'Bitácora del curso', fileName: 'bitacora.docx', courseCode: 'FPOO', knowledgeTier: 'supplemental', contextDomain: 'bitacora' },
    { id: 'src-4', title: 'Desactivada', fileName: 'vieja.pdf', isEnabled: false },
    { id: 'src-1', title: 'Repetida', fileName: 'arreglos.pdf' },
    { title: 'Sin id' },
  ],
};

describe('material del curso (0.0.34)', () => {
  it('lista las fuentes activas del curso, primero el material y al final la bitacora', () => {
    const list = normalizeCourseMaterial(RESPONSE, BACKEND);
    assert.equal(list.courseCode, 'FPOO');
    assert.deepEqual(list.items.map((item) => item.id), ['src-1', 'src-2', 'src-3']);
    assert.equal(list.items[1].preview, 'Clases y objetos en C++');
    assert.equal(list.items[2].supplemental, true);
    assert.equal(list.items[0].url, `${BACKEND}/api/rag/sources/src-1/view?courseCode=FPOO`);
    assert.deepEqual(normalizeCourseMaterial(null, BACKEND), { courseCode: '', items: [] });
  });

  it('el enlace al visor nunca lleva la sesion', () => {
    const url = courseMaterialViewerUrl('src 9', 'FPOO', `${BACKEND}/`);
    assert.equal(url, `${BACKEND}/api/rag/sources/src%209/view?courseCode=FPOO`);
    assert.ok(!url.includes('sessionId'));
    assert.equal(courseMaterialViewerUrl('', 'FPOO', BACKEND), '');
    assert.equal(courseMaterialListUrl(BACKEND, 'FPOO'), `${BACKEND}/api/rag/sources?limit=100&courseCode=FPOO`);
    assert.equal(courseMaterialListUrl(`${BACKEND}/`, ''), `${BACKEND}/api/rag/sources?limit=100`);
  });

  it('el filtro no distingue tildes ni mayusculas', () => {
    const { items } = normalizeCourseMaterial(RESPONSE, BACKEND);
    assert.deepEqual(filterCourseMaterial(items, 'programacion').map((item) => item.id), ['src-2']);
    assert.deepEqual(filterCourseMaterial(items, 'ARREGLOS.pdf').map((item) => item.id), ['src-1']);
    assert.equal(filterCourseMaterial(items, '  ').length, 3);
  });
});

function suggestion(patch: Partial<ActiveSuggestionModel> = {}): ActiveSuggestionModel {
  return {
    uriString: 'file:///repo/src/main.cpp',
    filePath: 'src/main.cpp',
    fileName: 'main.cpp',
    language: 'cpp',
    repoFullName: 'alumno/taller',
    title: 'ADACEEN en main.cpp',
    summary: '',
    fileOverview: 'Archivo activo: src/main.cpp (cpp, 120 lineas).',
    lineSummary: 'El if no cubre el caso del cero.',
    suggestions: ['El if no cubre el caso del cero.'],
    fileSuggestions: ['Separa la lectura de datos en una funcion.'],
    lineSuggestions: [],
    nextSteps: [],
    chips: [],
    source: 'backend',
    backendError: '',
    ragSources: [{
      id: 'r1', sourceId: 'src-2', chunkId: 'c4', title: 'Programación orientada a objetos', fileName: 'poo.pdf', scope: 'course',
      courseCode: 'FPOO', knowledgeTier: 'core', contextDomain: 'rag', citationLabel: '[POO p. 12]', pageStart: 12, pageEnd: 13, excerpt: 'Un objeto...', url: '',
    }],
    ragCourseCode: 'FPOO',
    updatedAt: '2026-10-20T20:00:00.000Z',
    line: 84,
    column: 1,
    selectionLineCount: 6,
    selectionOriginalLineCount: 6,
    selectionTruncated: false,
    selectionRangeKey: '83:0-88:10',
    fileSummaryCacheKey: 'k',
    metricId: 'm1',
    completionText: '',
    completionMode: '',
    applyMode: 'insert',
    triggerKind: 'cursor',
    ...patch,
  };
}

describe('vista «Este archivo» (0.0.34)', () => {
  it('prefiere el resumen del tutor guardado para ese archivo', () => {
    const state = buildFileViewState(
      suggestion(),
      { uriString: 'file:///repo/src/main.cpp', overview: 'Lee las medidas y calcula areas de figuras.', tips: ['Valida que la base no sea negativa.'], updatedAt: '' },
      false,
      EMPTY_MATERIAL_STATE,
    );
    assert.equal(state.hasFile, true);
    assert.equal(state.overview, 'Lee las medidas y calcula areas de figuras.');
    assert.equal(state.overviewFrom, 'tutor');
    assert.deepEqual(state.tips, ['Valida que la base no sea negativa.']);
    assert.equal(state.focusLabel, 'Selección, líneas 84-89');
    assert.deepEqual(state.suggestion, { headline: 'El if no cubre el caso del cero.', status: 'del tutor' });
    assert.equal(state.sources[0].meta, 'poo.pdf · p. 12-13 · [POO p. 12]');
    assert.equal(state.material.status, 'idle');
  });

  it('sin resumen del tutor muestra la descripcion local y lo marca', () => {
    const state = buildFileViewState(suggestion(), null, true, EMPTY_MATERIAL_STATE);
    assert.equal(state.overviewFrom, 'local');
    assert.equal(state.summaryLoading, true);
    const other = buildFileViewState(suggestion({ fileOverviewFromTutor: true, fileOverview: 'Resumen del modelo.' }), null, false, EMPTY_MATERIAL_STATE);
    assert.equal(other.overviewFrom, 'tutor');
    // Un resumen guardado de otro archivo no se mezcla.
    const mixed = buildFileViewState(suggestion(), { uriString: 'file:///repo/otro.cpp', overview: 'Otro', tips: [], updatedAt: '' }, false, EMPTY_MATERIAL_STATE);
    assert.notEqual(mixed.overview, 'Otro');
  });

  it('sin archivo abierto no hay resumen, y el material viaja tal cual', () => {
    const material = { status: 'ready' as const, courseCode: 'FPOO', items: normalizeCourseMaterial(RESPONSE, BACKEND).items, message: '' };
    const state = buildFileViewState(null, null, false, material);
    assert.equal(state.hasFile, false);
    assert.equal(state.material.items.length, 3);
    assert.equal(state.material.items[2].meta, 'bitacora.docx · bitácora');
    assert.equal(focusLabelFor(suggestion({ selectionLineCount: 0, line: 12 })), 'Línea 12');
    assert.equal(focusLabelFor(suggestion({ selectionLineCount: 0, triggerKind: 'file' })), 'Archivo completo');
  });
});
