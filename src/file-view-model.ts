// ADACEEN (VS Code): datos de la vista «Este archivo» (0.0.34), sin importar vscode.
//
// Reunion del 20/10/2026: «el panel que se ve como un resumen de lo que trata la
// pestaña no está, tampoco el atajo para ver el material de la RAG». Volvieron en
// una vista del Explorador (debajo del arbol de archivos): de que trata el
// archivo activo, que hacer despues, el material citado en la ultima sugerencia
// y todo el material del curso.
import type { CourseMaterialItem } from './course-material';
import type { ActiveSuggestionModel, ActiveSuggestionRagSource } from './types';

/** Resumen del archivo que hizo el tutor (file_summary), guardado por archivo. */
export type FileSummaryEntry = {
  uriString: string;
  overview: string;
  tips: string[];
  updatedAt: string;
};

export type FileViewMaterialStatus = 'idle' | 'loading' | 'ready' | 'error' | 'no_session';

export type FileViewMaterialState = {
  status: FileViewMaterialStatus;
  courseCode: string;
  items: CourseMaterialItem[];
  message: string;
};

export type FileViewSource = {
  index: number;
  title: string;
  meta: string;
  excerpt: string;
  supplemental: boolean;
};

export type FileViewState = {
  hasFile: boolean;
  fileName: string;
  language: string;
  focusLabel: string;
  overview: string;
  /** tutor = resumen del modelo; local = descripcion armada en VS Code mientras tanto. */
  overviewFrom: 'tutor' | 'local' | '';
  summaryLoading: boolean;
  tips: string[];
  /** La sugerencia de ahora, en una linea (la ventana flotante tiene el detalle). */
  suggestion: { headline: string; status: string } | null;
  sources: FileViewSource[];
  material: {
    status: FileViewMaterialStatus;
    courseCode: string;
    items: Array<{ id: string; title: string; meta: string; preview: string; supplemental: boolean }>;
    message: string;
  };
};

export const EMPTY_MATERIAL_STATE: FileViewMaterialState = { status: 'idle', courseCode: '', items: [], message: '' };

function sourcePages(source: ActiveSuggestionRagSource) {
  if (!source.pageStart) {
    return '';
  }
  return source.pageEnd && source.pageEnd !== source.pageStart
    ? `p. ${source.pageStart}-${source.pageEnd}`
    : `p. ${source.pageStart}`;
}

export function focusLabelFor(model: ActiveSuggestionModel | null) {
  if (!model) {
    return '';
  }
  if (model.selectionLineCount > 0) {
    const start = Number(model.line) || 1;
    const end = start + Math.max(0, model.selectionLineCount - 1);
    return start === end ? `Selección, línea ${start}` : `Selección, líneas ${start}-${end}`;
  }
  return model.triggerKind === 'cursor' && model.line > 0 ? `Línea ${model.line}` : 'Archivo completo';
}

function suggestionStatus(model: ActiveSuggestionModel) {
  if (model.loading || model.pendingMode) {
    return model.slow ? 'el tutor está tardando' : 'consultando al tutor';
  }
  if (model.blocked) {
    return 'mensaje del tutor';
  }
  if (model.applied) {
    return 'aplicada';
  }
  if (model.source === 'local-fallback') {
    return 'pista local (el tutor no respondió)';
  }
  return model.source === 'backend' ? 'del tutor' : 'pista local';
}

export function buildFileViewState(
  model: ActiveSuggestionModel | null,
  summary: FileSummaryEntry | null,
  summaryLoading: boolean,
  material: FileViewMaterialState,
): FileViewState {
  const tutorSummary = summary && model && summary.uriString === model.uriString ? summary : null;
  const fromModel = !!model?.fileOverviewFromTutor && !!model.fileOverview;
  const overview = tutorSummary?.overview || (model?.fileOverview || '');
  const overviewFrom: FileViewState['overviewFrom'] = !overview
    ? ''
    : tutorSummary || fromModel ? 'tutor' : 'local';
  const tips = (tutorSummary?.tips.length ? tutorSummary.tips : (model?.fileSuggestions || [])).slice(0, 3);
  const headline = model ? (model.lineSummary || model.lineSuggestions[0] || model.suggestions[0] || '') : '';
  return {
    hasFile: !!model,
    fileName: model?.fileName || '',
    language: model?.language || '',
    focusLabel: focusLabelFor(model),
    overview,
    overviewFrom,
    summaryLoading,
    tips,
    suggestion: model && headline && model.triggerKind === 'cursor'
      ? { headline, status: suggestionStatus(model) }
      : null,
    sources: (model?.ragSources || []).slice(0, 6).map((source, index) => ({
      index,
      title: source.title || source.fileName || 'Fuente del curso',
      meta: [source.fileName && source.fileName !== source.title ? source.fileName : '', sourcePages(source), source.citationLabel]
        .filter(Boolean)
        .join(' · '),
      excerpt: source.excerpt ? (source.excerpt.length > 180 ? `${source.excerpt.slice(0, 179)}…` : source.excerpt) : '',
      supplemental: source.knowledgeTier === 'supplemental' || source.contextDomain === 'bitacora',
    })),
    material: {
      status: material.status,
      courseCode: material.courseCode,
      message: material.message,
      items: material.items.map((item) => ({
        id: item.id,
        title: item.title,
        meta: [item.fileName && item.fileName !== item.title ? item.fileName : '', item.supplemental ? 'bitácora' : '']
          .filter(Boolean)
          .join(' · '),
        preview: item.preview,
        supplemental: item.supplemental,
      })),
    },
  };
}
