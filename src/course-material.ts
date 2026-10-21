// ADACEEN (VS Code): material del curso (las fuentes RAG del docente) para la vista
// «Este archivo» y el comando «ADACEEN: Ver material del curso» (0.0.34).
//
// Reunion del 20/10/2026: en la 0.0.26 se quito el panel de sugerencias y con el
// se fue el acceso directo a los libros con que se alimenta el tutor. Este
// modulo arma la lista que devuelve GET /api/rag/sources (las del curso del
// estudiante) y los enlaces al visor del backend, sin la sesion en la URL
// (rag-viewer-url.ts). Sin importar vscode: se prueba con node:test.
import { ragViewerUrl } from './rag-viewer-url';

export type CourseMaterialItem = {
  id: string;
  title: string;
  fileName: string;
  courseCode: string;
  /** Un trozo del comienzo del texto, para reconocer el documento. */
  preview: string;
  /** Bitacora u otro contexto suplementario (no es material del curso en si). */
  supplemental: boolean;
  /** Visor del backend, absoluto y sin sessionId. */
  url: string;
};

export type CourseMaterialList = {
  courseCode: string;
  items: CourseMaterialItem[];
};

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function compact(value: string, max: number) {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Enlace del visor de una fuente: /api/rag/sources/:id/view?courseCode=X en el backend. */
export function courseMaterialViewerUrl(id: string, courseCode: string, baseUrl: string) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!id || !base) {
    return '';
  }
  const query = courseCode ? `?courseCode=${encodeURIComponent(courseCode)}` : '';
  return ragViewerUrl(`${base}/api/rag/sources/${encodeURIComponent(id)}/view${query}`, base);
}

/** La respuesta de GET /api/rag/sources como lista para mostrar (activas y habilitadas). */
export function normalizeCourseMaterial(data: unknown, baseUrl: string): CourseMaterialList {
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const listCourse = text(record.courseCode);
  const sources = Array.isArray(record.sources) ? record.sources : [];
  const seen = new Set<string>();
  const items: CourseMaterialItem[] = [];
  for (const raw of sources) {
    const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const id = text(source.id);
    if (!id || seen.has(id) || source.isActive === false || source.isEnabled === false) {
      continue;
    }
    seen.add(id);
    const courseCode = text(source.courseCode) || listCourse;
    const tier = text(source.knowledgeTier).toLowerCase();
    const domain = text(source.contextDomain).toLowerCase();
    items.push({
      id,
      title: compact(text(source.title) || text(source.fileName) || 'Fuente sin titulo', 140),
      fileName: compact(text(source.fileName), 100),
      courseCode,
      preview: compact(text(source.textPreview), 160),
      supplemental: tier === 'supplemental' || domain === 'bitacora',
      url: courseMaterialViewerUrl(id, courseCode, baseUrl),
    });
  }
  items.sort((left, right) => Number(left.supplemental) - Number(right.supplemental)
    || left.title.localeCompare(right.title, 'es', { sensitivity: 'base' }));
  return { courseCode: listCourse, items };
}

function fold(value: string) {
  return value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Filtro por titulo o archivo, sin importar tildes ni mayusculas. */
export function filterCourseMaterial(items: CourseMaterialItem[], query: string) {
  const probe = fold(String(query || '').trim());
  if (!probe) {
    return items;
  }
  return items.filter((item) => fold(`${item.title} ${item.fileName}`).includes(probe));
}

/** URL de la lista del curso (el backend usa el curso del estudiante si va vacio). */
export function courseMaterialListUrl(baseUrl: string, courseCode: string) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const params = new URLSearchParams({ limit: '100' });
  if (courseCode) {
    params.set('courseCode', courseCode);
  }
  return `${base}/api/rag/sources?${params.toString()}`;
}
