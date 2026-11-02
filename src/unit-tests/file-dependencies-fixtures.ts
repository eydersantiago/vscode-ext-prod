// ADACEEN (VS Code): archivo del indice de prueba compartido por las pruebas de file-dependencies*.
// Movido sin cambios desde src/unit-tests/file-dependencies.test.ts (solo se agrego "export" y los imports).
import { dependencyFamily, parseImports } from '../dependency-parse';
import { collectNamespaces, collectTypeReferences } from '../dependency-source-mask';
import type { DependencyIndexFile } from '../file-dependencies';

// Cuadro «Dependencias» de la vista «Este archivo» (0.0.36, pedido del 25/10/2026).

export function indexFile(path: string, text: string, language: string, outline = ''): DependencyIndexFile {
  const family = dependencyFamily(language, path);
  return {
    path,
    language,
    outline,
    imports: parseImports(text, family),
    typeRefs: collectTypeReferences(text, family),
    namespaces: collectNamespaces(text, family),
  };
}
