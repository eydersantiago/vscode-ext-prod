// ADACEEN (VS Code): la sugerencia local (sin el tutor) a partir de la foto del editor y el indice del proyecto.
// Movido sin cambios desde src/active-suggestion.ts (solo se agrego "export" y los imports).
import { isCodespaceRuntime } from './settings';
import { countMatches, inferSuggestionApplyMode } from './suggestion-edit';
import { truncateInline, uniqueCompactStrings } from './suggestion-results';
import type { ActiveEditorSnapshot, WorkspaceProjectIndex, ActiveSuggestionModel } from './types';
import { stableStringHash } from './values';
import { buildLocalFileOverview } from './workspace-index';

export function buildSelectionSpecificGuidance(snapshot: ActiveEditorSnapshot) {
  const selected = snapshot.selectionText.trim();
  if (!selected) {
    return '';
  }

  const lowerPath = snapshot.filePath.toLowerCase();
  const language = snapshot.language.toLowerCase();
  if (/export\s+const\s+metadata\b|metadata\s*:\s*metadata\b/i.test(selected)) {
    return 'La seleccion define metadata exportada; revisa que title, description y generator describan exactamente esta pantalla antes de tocar el layout.';
  }
  if (/^import\s.+from\s+['"]/m.test(selected) || selected.split(/\r?\n/).every((line) => /^\s*import\b/.test(line) || !line.trim())) {
    return 'La seleccion contiene imports; valida cuales se usan realmente y evita cambiar dependencias sin confirmar referencias en el archivo.';
  }
  if (/\bfunction\s+\w+|=>\s*[{(]|return\s*\(/.test(selected)) {
    return 'La seleccion contiene logica ejecutable; identifica entradas, estado usado y salida renderizada antes de modificar el bloque.';
  }
  if (/<[A-Z][A-Za-z0-9]*|className=|children\b/.test(selected)) {
    return 'La seleccion contiene JSX; revisa jerarquia, props y clases aplicadas antes de insertar o reemplazar UI.';
  }
  if (language.includes('typescript') || /\.(tsx?|jsx?)$/i.test(lowerPath)) {
    return 'La seleccion es codigo de TypeScript/React; valida tipos, imports y efecto en render antes de cambiarla.';
  }
  if (selected.length <= 280) {
    return `La seleccion concreta es: ${truncateInline(selected.replace(/\s+/g, ' '), 220)}.`;
  }
  return 'ADACEEN ya capturo el bloque seleccionado; enfoca la ayuda en ese recorte y no en el archivo completo.';
}

export function buildLocalActiveSuggestion(
  snapshot: ActiveEditorSnapshot,
  projectIndex: WorkspaceProjectIndex | null = null,
): ActiveSuggestionModel {
  const code = snapshot.content;
  const lowerPath = snapshot.filePath.toLowerCase();
  const language = snapshot.language.toLowerCase();
  const suggestions: string[] = [];
  const nextSteps: string[] = [];
  const fileOverview = buildLocalFileOverview(snapshot, projectIndex);
  const hasSelection = !!snapshot.selectionText.trim();
  const selectionLimitNote = snapshot.selectionTruncated
    ? ` La seleccion original tenia ${snapshot.selectionOriginalLineCount} lineas; ADACEEN analizo las primeras ${snapshot.selectionLineCount} lineas.`
    : '';
  const selectionSpecificGuidance = buildSelectionSpecificGuidance(snapshot);

  if (hasSelection) {
    if (selectionSpecificGuidance) {
      suggestions.push(selectionSpecificGuidance);
    }
    suggestions.push(
      `Analiza el bloque seleccionado completo (${snapshot.selectionLineCount} linea(s), ${snapshot.selectionStartLine}-${snapshot.selectionEndLine}) antes de proponer cambios.${selectionLimitNote}`,
    );
    nextSteps.push('Trabaja sobre la seleccion como unidad: identifica entrada, efecto y salida del bloque antes de editar.');
  } else if (snapshot.currentLineText.trim()) {
    suggestions.push(`El cursor quedo en la linea ${snapshot.line}; revisa ese punto como posible bloqueo antes de cambiar mas codigo.`);
    nextSteps.push(`Trabaja desde la linea ${snapshot.line}: completa una intencion pequena y valida el resultado.`);
  }

  if (/\b(TODO|FIXME)\b/i.test(code)) {
    const todoCount = countMatches(code, /\b(TODO|FIXME)\b/gi);
    suggestions.push(`Hay ${todoCount} marcador(es) TODO/FIXME; conviertelos en pasos pequenos y verificables.`);
  }

  if (language === 'python' || lowerPath.endsWith('.py')) {
    if (/except\s+Exception\s*:\s*\n\s*pass\b/i.test(code) || /except\s*:\s*\n\s*pass\b/i.test(code)) {
      suggestions.push('Hay un bloque que silencia excepciones con pass; agrega al menos un comentario, log o condicion para no ocultar errores reales.');
    }
    if (/\bclass\s+\w+/.test(code) && !/\bdef\s+__repr__\b/.test(code)) {
      suggestions.push('Si esta clase representa datos del dominio, considera un __repr__ breve para depurar mejor en terminal.');
    }
    if (/urlpatterns\s*=/.test(code)) {
      suggestions.push('Archivo de rutas detectado: verifica que cada vista tenga nombre claro y que el flujo principal este cubierto.');
    }
    if (lowerPath.endsWith('manage.py')) {
      suggestions.push('Este parece el punto de entrada Django; valida settings, migraciones y comando de arranque antes de cambiar logica.');
    }
    if (lowerPath.endsWith('sitecustomize.py')) {
      suggestions.push('Este archivo parchea compatibilidad del entorno; mantenlo minimo y evita que esconda fallos de dependencias.');
    }
  }

  if (language.includes('javascript') || language.includes('typescript') || /\.(mjs|cjs|jsx|tsx?)$/i.test(lowerPath)) {
    if (/\bany\b/.test(code) && language.includes('typescript')) {
      suggestions.push('Hay tipos any visibles; reemplaza uno por un tipo concreto donde mas reduzca incertidumbre.');
    }
    if (/\bfetch\s*\(/.test(code) && !/catch\s*\(/.test(code)) {
      suggestions.push('Hay llamadas fetch; confirma manejo de error y estado de carga para evitar fallos silenciosos.');
    }
    if (/\buseEffect\s*\(/.test(code)) {
      suggestions.push('Revisa dependencias de useEffect y separa efectos de datos, eventos y render cuando sea posible.');
    }
  }

  if (/requirements\.txt$|pyproject\.toml$|package\.json$/i.test(lowerPath)) {
    suggestions.push('Archivo de dependencias detectado: compara versiones, scripts de arranque y librerias realmente usadas.');
    nextSteps.push('Ejecuta el comando minimo de instalacion o arranque y observa el primer error concreto.');
  }

  if (/(^|\/)(test|tests|__tests__|spec|specs)\//i.test(lowerPath) || /\.(test|spec)\./i.test(lowerPath)) {
    suggestions.push('Estas en pruebas: agrega un caso pequeno que falle primero y luego corrige la implementacion.');
  } else if (/\b(function|def|class|public\s+\w+|private\s+\w+)\b/.test(code) && !/\b(describe\(|it\(|pytest|unittest|assert\s|@Test)\b/i.test(code)) {
    suggestions.push('No se ven pruebas cerca; agrega una verificacion minima para proteger el siguiente cambio.');
  }

  const functionCount = countMatches(code, /\b(function|def|public\s+\w+|private\s+\w+)\b/g);
  if (functionCount >= 12 || snapshot.lineCount >= 350) {
    suggestions.push('El archivo se ve cargado; busca una funcion pequena que puedas extraer o probar sin reestructurar todo.');
  }

  if (suggestions.length === 0) {
    suggestions.push(`Trabaja sobre ${snapshot.fileName}: identifica entrada, estado que cambia y salida antes del siguiente cambio.`);
  }
  if (nextSteps.length === 0) {
    nextSteps.push('Haz un cambio pequeno, ejecuta una validacion corta y vuelve a leer el resultado.');
    nextSteps.push('Si aparece error, copia la primera linea util y enfoca la siguiente pista alli.');
  }

  const chips = uniqueCompactStrings([
    snapshot.repoFullName ? `repo ${snapshot.repoFullName}` : snapshot.workspaceName || 'workspace',
    snapshot.language,
    `${snapshot.lineCount} lineas`,
    hasSelection
      ? `seleccion ${snapshot.selectionLineCount}${snapshot.selectionTruncated ? `/${snapshot.selectionOriginalLineCount}` : ''} lineas`
      : `cursor linea ${snapshot.line}`,
    isCodespaceRuntime() ? 'Codespaces' : 'VS Code',
  ], 5);
  const compactSuggestions = uniqueCompactStrings(suggestions, 4);
  const focusLine = hasSelection ? snapshot.selectionStartLine : snapshot.line;
  const focusColumn = hasSelection ? 1 : snapshot.column;
  // La pista local no escribe codigo (0.0.34): antes inventaba un «TODO: ...» que
  // «Modificar seleccion» llegaba a poner en lugar del bloque del estudiante.
  const completionText = '';
  const applyMode = inferSuggestionApplyMode(
    snapshot,
    `${compactSuggestions.join('\n')}\n${nextSteps.join('\n')}`,
    completionText,
  );

  return {
    uriString: snapshot.uriString,
    filePath: snapshot.filePath,
    fileName: snapshot.fileName,
    language: snapshot.language,
    repoFullName: snapshot.repoFullName,
    title: `Sugerencias para ${snapshot.fileName}`,
    summary: fileOverview || `Archivo activo: ${snapshot.filePath} (${snapshot.language}, linea ${snapshot.line}).`,
    fileOverview,
    lineSummary: hasSelection
      ? `Foco actual: seleccion lineas ${snapshot.selectionStartLine}-${snapshot.selectionEndLine} (${snapshot.selectionLineCount} linea(s) analizadas${snapshot.selectionTruncated ? ` de ${snapshot.selectionOriginalLineCount}` : ''}).`
      : snapshot.currentLineText.trim()
        ? `Foco actual: linea ${snapshot.line}.`
      : '',
    suggestions: compactSuggestions,
    fileSuggestions: compactSuggestions,
    lineSuggestions: snapshot.currentLineText.trim() ? compactSuggestions.slice(0, 2) : [],
    nextSteps: uniqueCompactStrings(nextSteps, 3),
    chips,
    source: 'local',
    backendError: '',
    ragSources: [],
    ragCourseCode: '',
    updatedAt: new Date().toISOString(),
    line: focusLine,
    column: focusColumn,
    selectionLineCount: snapshot.selectionLineCount,
    selectionOriginalLineCount: snapshot.selectionOriginalLineCount,
    selectionTruncated: snapshot.selectionTruncated,
    selectionRangeKey: snapshot.selectionRangeKey,
    ...(hasSelection ? { selectionText: snapshot.selectionText } : {}),
    fileSummaryCacheKey: snapshot.fileSummaryCacheKey,
    metricId: stableStringHash([
      snapshot.cacheKey,
      fileOverview,
      compactSuggestions.join('\n'),
      'local',
    ].join('\n---adaceen-metric---\n')),
    completionText,
    completionMode: '',
    applyMode,
    triggerKind: 'cursor',
    actionsVisible: false,
  };
}
