// ADACEEN (VS Code): datos de la vista «Este archivo» (0.0.34), sin importar vscode.
//
// Reunion del 20/10/2026: «el panel que se ve como un resumen de lo que trata la
// pestaña no está, tampoco el atajo para ver el material de la RAG». Volvieron en
// una vista del Explorador (debajo del arbol de archivos): de que trata el
// archivo activo, que hacer despues, el material citado en la ultima sugerencia
// y todo el material del curso.
import type { CourseMaterialItem } from './course-material';
import type { DependencyFamily, FileDependencies, FileDependencyItem } from './file-dependencies';
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

/** El archivo del editor activo (0.0.36): la vista lo muestra aunque todavia no haya sugerencia. */
export type FileViewActiveFile = { uriString: string; fileName: string; language: string };

export type FileViewDependencyGroup = 'local' | 'libraries' | 'missing' | 'dependents';

export type FileViewDependencyItem = {
  /**
   * Identifica el elemento en el resultado (nombre del import y ruta): el clic lo devuelve y la
   * extension busca ese mismo elemento. Lo que se muestra no sirve para eso: «figura.h» se ve por
   * el nombre del archivo y el import dice "modelo/figura.h" (revision del 25/10/2026).
   */
  id: string;
  label: string;
  meta: string;
  /** Lo que hace el clic (tooltip): «Abrir src/figura.h» o «Ir a la línea 3». */
  title: string;
  warning: string;
};

/** Cuadro «Dependencias» (0.0.36). */
export type FileViewDependencies = {
  status: 'loading' | 'ready';
  /** «2 del proyecto · 3 bibliotecas · 1 sin encontrar». */
  summary: string;
  local: FileViewDependencyItem[];
  libraries: FileViewDependencyItem[];
  missing: FileViewDependencyItem[];
  dependents: FileViewDependencyItem[];
  /** Sin nada que mostrar en un grupo: por que. */
  emptyUses: string;
  emptyDependents: string;
  /** El indice no tiene todos los archivos, o el archivo esta fuera de la carpeta abierta. */
  note: string;
  /** Archivo y version del calculo: un clic de un cuadro viejo no abre otra cosa. */
  key: string;
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
  /** null: no aplica (sin archivo, o un archivo que no declara dependencias y nadie usa). */
  dependencies: FileViewDependencies | null;
};

export const EMPTY_MATERIAL_STATE: FileViewMaterialState = { status: 'idle', courseCode: '', items: [], message: '' };

function dirOf(path: string) {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(0, index) : '';
}

function baseOf(path: string) {
  return path.slice(path.lastIndexOf('/') + 1);
}

function plural(count: number, singular: string, pluralText: string) {
  return `${count} ${count === 1 ? singular : pluralText}`;
}

/** «en modelo/» si el archivo esta en otra carpeta que el activo. */
function folderNote(path: string, activePath: string) {
  const dir = dirOf(path);
  return dir === dirOf(activePath) ? '' : dir ? `en ${dir}/` : 'en la carpeta raíz';
}

function implicitNote(family: DependencyFamily) {
  return family === 'csharp' ? 'sin using: es de tu proyecto' : 'sin import: es del mismo paquete';
}

/**
 * Del resultado de file-dependencies.ts a lo que pinta el cuadro. Conserva el orden de cada
 * grupo: el clic llega con (grupo, posicion) y extension.ts busca el elemento en el resultado.
 */
/**
 * Lo que identifica un elemento del cuadro entre el resultado y la vista: el nombre del import
 * y la ruta (sin la linea: si otro archivo se guardo, quien lo usa puede haber cambiado de linea
 * y el clic debe abrirlo igual).
 */
export function dependencyItemId(item: Pick<FileDependencyItem, 'label' | 'path'>) {
  return `${item.label}\n${item.path || ''}`;
}

export function buildDependencyViewState(
  deps: FileDependencies | null,
  activePath: string,
  loading: boolean,
  options: { partial?: boolean; outside?: boolean; packageCode?: boolean; key?: string } = {},
): FileViewDependencies | null {
  const key = options.key || '';
  if (!deps) {
    return loading
      ? { status: 'loading', summary: '', local: [], libraries: [], missing: [], dependents: [], emptyUses: '', emptyDependents: '', note: '', key }
      : null;
  }
  const uses = deps.local.length + deps.libraries.length + deps.missing.length;
  if (deps.family === 'none' && !uses && !deps.dependents.length) {
    return null;
  }
  const local = deps.local.map((item: FileDependencyItem) => ({
    id: dependencyItemId(item),
    // Un paquete (modelo.*) o un espacio de nombres va por su nombre, no por su primer archivo.
    label: item.implicit || !item.path || item.description ? item.label : baseOf(item.path),
    meta: [
      (item.symbols || []).join(', '),
      item.path ? folderNote(item.path, activePath) : '',
      item.description || '',
      item.implicit ? implicitNote(deps.family) : item.line ? `línea ${item.line}` : '',
    ].filter(Boolean).join(' · '),
    title: item.path ? `Abrir ${item.path}` : '',
    warning: item.warning || '',
  }));
  const libraries = deps.libraries.map((item) => ({
    id: dependencyItemId(item),
    label: item.label,
    meta: item.description || '',
    title: item.line ? `Ir a la línea ${item.line}` : '',
    warning: item.warning || '',
  }));
  const missing = deps.missing.map((item) => ({
    id: dependencyItemId(item),
    label: item.label,
    // El grupo ya dice «No encontradas»: con sugerencia basta la sugerencia.
    meta: item.hint || item.description || '',
    title: item.line ? `Ir a la línea ${item.line}` : '',
    warning: '',
  }));
  const dependents = deps.dependents.map((item) => ({
    id: dependencyItemId(item),
    label: item.label,
    meta: [
      item.path ? folderNote(item.path, activePath) : '',
      item.implicit ? implicitNote(deps.family) : item.line ? `línea ${item.line}` : '',
    ].filter(Boolean).join(' · '),
    title: item.path ? `Abrir ${item.path}${item.line ? ` en la línea ${item.line}` : ''}` : '',
    warning: '',
  }));
  const summary = [
    deps.local.length ? `${deps.local.length} del proyecto` : '',
    deps.libraries.length ? plural(deps.libraries.length, 'biblioteca', 'bibliotecas') : '',
    deps.missing.length ? `${deps.missing.length} sin encontrar` : '',
  ].filter(Boolean).join(' · ');
  return {
    status: loading ? 'loading' : 'ready',
    summary,
    local,
    libraries,
    missing,
    dependents,
    emptyUses: uses ? '' : deps.family === 'none' ? '' : 'No usa otros archivos ni bibliotecas.',
    // Que nadie incluya un main.cpp es lo normal; que nadie incluya un .h, una pista.
    emptyDependents: !deps.dependents.length && /\.(?:h|hh|hpp|hxx)$/i.test(activePath)
      ? 'Ningún archivo del proyecto lo incluye todavía.'
      : '',
    note: options.packageCode
      ? 'Es código de un paquete instalado (no de tu proyecto): solo se muestran sus bibliotecas.'
      : options.outside
        ? 'Este archivo no está en la carpeta abierta: solo se muestran sus bibliotecas.'
        : options.partial ? 'El proyecto tiene muchos archivos: la lista «La usan» puede estar incompleta.' : '',
    key,
  };
}

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

export type FileViewExtras = {
  /**
   * El archivo del editor activo (0.0.36); null: no hay archivo abierto. Sin el campo, el de la
   * sugerencia (como en la 0.0.34).
   */
  activeFile?: FileViewActiveFile | null;
  dependencies?: FileViewDependencies | null;
};

export function buildFileViewState(
  model: ActiveSuggestionModel | null,
  summary: FileSummaryEntry | null,
  summaryLoading: boolean,
  material: FileViewMaterialState,
  extras: FileViewExtras = {},
): FileViewState {
  const file: FileViewActiveFile | null = extras.activeFile !== undefined
    ? extras.activeFile
    : model ? { uriString: model.uriString, fileName: model.fileName, language: model.language } : null;
  // La sugerencia de otro archivo (el estudiante acaba de cambiar de pestaña y la nueva todavia
  // no llega) no se mezcla con el nombre de este: antes la vista mostraba el resumen del anterior.
  const fileModel = model && file && model.uriString === file.uriString ? model : null;
  const tutorSummary = summary && file && summary.uriString === file.uriString ? summary : null;
  const fromModel = !!fileModel?.fileOverviewFromTutor && !!fileModel.fileOverview;
  const overview = tutorSummary?.overview || (fileModel?.fileOverview || '');
  const overviewFrom: FileViewState['overviewFrom'] = !overview
    ? ''
    : tutorSummary || fromModel ? 'tutor' : 'local';
  const tips = (tutorSummary?.tips.length ? tutorSummary.tips : (fileModel?.fileSuggestions || [])).slice(0, 3);
  const headline = fileModel ? (fileModel.lineSummary || fileModel.lineSuggestions[0] || fileModel.suggestions[0] || '') : '';
  return {
    hasFile: !!file,
    fileName: file?.fileName || '',
    language: file?.language || '',
    focusLabel: focusLabelFor(fileModel),
    overview,
    overviewFrom,
    summaryLoading: !!file && summaryLoading,
    tips,
    suggestion: fileModel && headline && fileModel.triggerKind === 'cursor'
      ? { headline, status: suggestionStatus(fileModel) }
      : null,
    dependencies: file ? extras.dependencies ?? null : null,
    sources: (fileModel?.ragSources || []).slice(0, 6).map((source, index) => ({
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
