// ADACEEN (VS Code): estado de la vista «Este archivo»: resumenes, material del curso, archivo que se ve y su cuadro «Dependencias».
// Antes eran variables locales de activate(); las asignaciones desde otros modulos usan los setters.
import * as vscode from 'vscode';
import { BuildFileCache, DependencyProbeCache } from './dependency-scan';
import type { ActiveFileDependencies } from './dependency-scan';
import { isSupportedActiveDocument } from './editor-snapshot';
import type { AdaceenFileViewProvider } from './file-view';
import { EMPTY_MATERIAL_STATE } from './file-view-model';
import type { FileSummaryEntry, FileViewMaterialState } from './file-view-model';
import type { WorkspaceProjectIndex } from './types';
import type { WorkshopProgressPoller } from './workshop-progress-poller';

// initFileViewState(): la vista, sus resumenes, el material y el cuadro «Dependencias».
export let fileView: AdaceenFileViewProvider | null;
export let fileSummaries: Map<string, FileSummaryEntry>;
export let fileSummaryInFlight: Set<string>;
export let materialState: FileViewMaterialState;
export let materialLoadedAt: number;
export let materialInFlight: Promise<FileViewMaterialState> | null;
export let fileViewDocument: vscode.TextDocument | null;
export let fileViewIdentity: string;
export let dependencyState: { uriString: string; loading: boolean; result: ActiveFileDependencies | null } | null;
export let dependencyTimer: ReturnType<typeof setTimeout> | null;
export let dependencyRun: number;
export let dependencyProbes: DependencyProbeCache;
export let dependencyBuildFiles: BuildFileCache;
// initDependencyIndexState(): el indice que usa el cuadro y cuando pedir otro.
export let dependencyIndex: WorkspaceProjectIndex | null;
export let dependencyIndexDirty: number;
export let dependencyIndexAt: number;
export let savedSinceDependencyIndex: Set<string>;
// registerWorkshopProgress() (file-view-controller.ts): avance del taller en la esquina de la vista.
export let workshopProgress: WorkshopProgressPoller;

// Las asignaciones que hacen otros modulos (devuelven el valor, como una asignacion).
// setMaterialState y setFileViewDocument ya existen (cambian el valor y repintan la vista):
// los de aqui terminan en Value.
export function setFileView(value: AdaceenFileViewProvider | null) {
  return (fileView = value);
}

export function setMaterialStateValue(value: FileViewMaterialState) {
  return (materialState = value);
}

export function setMaterialLoadedAt(value: number) {
  return (materialLoadedAt = value);
}

export function setMaterialInFlight(value: Promise<FileViewMaterialState> | null) {
  return (materialInFlight = value);
}

export function setFileViewDocumentValue(value: vscode.TextDocument | null) {
  return (fileViewDocument = value);
}

export function setFileViewIdentity(value: string) {
  return (fileViewIdentity = value);
}

export function setDependencyState(value: { uriString: string; loading: boolean; result: ActiveFileDependencies | null } | null) {
  return (dependencyState = value);
}

export function setDependencyTimer(value: ReturnType<typeof setTimeout> | null) {
  return (dependencyTimer = value);
}

export function setDependencyRun(value: number) {
  return (dependencyRun = value);
}

export function setDependencyIndex(value: WorkspaceProjectIndex | null) {
  return (dependencyIndex = value);
}

export function setDependencyIndexDirty(value: number) {
  return (dependencyIndexDirty = value);
}

export function setDependencyIndexAt(value: number) {
  return (dependencyIndexAt = value);
}

export function setWorkshopProgress(value: WorkshopProgressPoller) {
  return (workshopProgress = value);
}

export function initFileViewState() {
  // Vista «Este archivo» (0.0.34): de que trata el archivo y el material del curso. El
  // proveedor se crea mas abajo, cuando ya existen las funciones que usa.
  fileView = null;
  fileSummaries = new Map<string, FileSummaryEntry>();
  fileSummaryInFlight = new Set<string>();
  materialState = { ...EMPTY_MATERIAL_STATE };
  materialLoadedAt = 0;
  materialInFlight = null;
  // 0.0.36: el archivo que muestra la vista es el del editor activo (antes, el de la ultima
  // sugerencia, que tras cambiar de pestaña seguia siendo el anterior), y su cuadro «Dependencias».
  const initialEditor = vscode.window.activeTextEditor;
  fileViewDocument = initialEditor && isSupportedActiveDocument(initialEditor.document)
    ? initialEditor.document
    : null;
  // Archivo y lenguaje de la vista cuando se fijo: al cambiar el lenguaje (un .tpp marcado como
  // C++) el documento es el mismo objeto, asi que hay que comparar con lo guardado.
  fileViewIdentity = fileViewDocument ? `${fileViewDocument.uri.toString()}|${fileViewDocument.languageId}` : '';
  dependencyState = null;
  dependencyTimer = null;
  dependencyRun = 0;
  dependencyProbes = new DependencyProbeCache();
  dependencyBuildFiles = new BuildFileCache();
}

export function initDependencyIndexState() {
  // El indice que usa el cuadro. Se pide uno nuevo si cambio otro archivo: uno guardado que no
  // es el que se ve, o uno que se guardo mientras se veia y ahora se ve otro (el estudiante
  // agrega #include "figura.h" en main.cpp y vuelve a figura.h: «La usan» tiene que mostrarlo).
  // Guardar el archivo que se esta viendo no lo pide: con autoguardado cada segundo el indice
  // (90 lecturas) se rearmaba sin parar (revisiones del 25/10/2026).
  dependencyIndex = null;
  dependencyIndexDirty = 1;
  dependencyIndexAt = 0;
  savedSinceDependencyIndex = new Set<string>();
}
