import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildRagSourceTargetUrl, parseBackendSuggestionSections, stripCutNoteAfterFence, unwrapEmphasisLine } from '../suggestion-format';
import { extractSuggestionCode } from '../suggestion-code';
import type { ActiveSuggestionRagSource } from '../types';

// Secciones de la respuesta de /suggest-tab y notas del backend fuera del bloque (0.0.38).

const CUT_OUTPUT = [
  '1) Resumen:',
  '- Falta validar el retiro.',
  '',
  '```cpp',
  'int main(){',
  '}',
  '```',
  '',
  '_El tutor muestra 5 de 12 lineas: el resto lo escribes tu._',
  '',
  '2) Sugerencias:',
  '- Valida el monto antes de restar.',
].join('\n');

describe('notas del backend fuera del bloque (0.0.38)', () => {
  it('sin quitar la nota, una linea en cursiva se lee como texto (sin los guiones bajos)', () => {
    const sections = parseBackendSuggestionSections(CUT_OUTPUT);
    assert.deepEqual(sections.resumen, ['Falta validar el retiro.', 'El tutor muestra 5 de 12 lineas: el resto lo escribes tu.']);
    assert.ok(sections.all.every((line) => !/^_|_$/.test(line)));
  });

  it('con cut, la nota del recorte no queda como texto de la sugerencia (la extension la dice con cut)', () => {
    const stripped = stripCutNoteAfterFence(CUT_OUTPUT);
    const sections = parseBackendSuggestionSections(stripped);
    assert.deepEqual(sections.resumen, ['Falta validar el retiro.']);
    assert.deepEqual(sections.sugerencias, ['Valida el monto antes de restar.']);
    assert.ok(!sections.all.some((line) => /muestra 5 de 12/.test(line)));
    assert.equal(extractSuggestionCode(stripped), extractSuggestionCode(CUT_OUTPUT), 'el codigo queda igual');
  });

  it('solo quita una linea en cursiva sola, la primera despues del primer bloque', () => {
    assert.equal(stripCutNoteAfterFence('```cpp\nx++;\n```\nTexto normal.'), '```cpp\nx++;\n```\nTexto normal.');
    assert.equal(stripCutNoteAfterFence('sin bloque\n_nota_'), 'sin bloque\n_nota_');
    assert.equal(stripCutNoteAfterFence('```\nx\n```\n\n_nota_'), '```\nx\n```\n');
  });

  it('una linea en cursiva se lee como texto; lo que no es cursiva queda igual', () => {
    assert.equal(unwrapEmphasisLine('_El tutor muestra 5 de 12 lineas._'), 'El tutor muestra 5 de 12 lineas.');
    assert.equal(unwrapEmphasisLine('*(codigo omitido: en esta etapa la ayuda es solo una pista)*'), '(codigo omitido: en esta etapa la ayuda es solo una pista)');
    assert.equal(unwrapEmphasisLine('usa_snake_case en las variables'), 'usa_snake_case en las variables');
    assert.equal(unwrapEmphasisLine('__init__'), '__init__');
  });
});

describe('enlace a una fuente RAG sin vscode (0.0.38)', () => {
  it('completa la ruta del visor con la URL del backend que pasa quien llama', () => {
    const source = { url: '/api/rag/sources/abc/view?chunk=3', pageStart: 4 } as ActiveSuggestionRagSource;
    assert.match(buildRagSourceTargetUrl(source, 'https://api.adaceen.test'), /^https:\/\/api\.adaceen\.test\/api\/rag\/sources\/abc\/view/);
  });
});
