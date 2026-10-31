import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { decodeSourceBytes, readWorkspaceText } from '../source-text';

// Archivos leidos de sus bytes para el indice y el escaneo (0.0.36).

describe('texto de un archivo leido de sus bytes (0.0.36)', () => {
  it('UTF-8 tal cual; Windows-1252 (Dev-C++, Bloc de notas) sin «�»', () => {
    assert.equal(decodeSourceBytes(new TextEncoder().encode('// año, señal: área')), '// año, señal: área');
    const latin1 = Uint8Array.from([0x2f, 0x2f, 0x20, 0x61, 0xf1, 0x6f, 0x2c, 0x20, 0xe1, 0x72, 0x65, 0x61]); // "// año, área" en Windows-1252
    assert.equal(decodeSourceBytes(latin1), '// año, área');
  });
});

describe('un byte suelto no cambia la codificacion de todo el archivo (0.0.36)', () => {
  it('UTF-8 con un byte pegado de otra parte sigue siendo UTF-8; solo ese byte se pierde', () => {
    const utf8 = new TextEncoder();
    const bytes = Uint8Array.from([...utf8.encode('// año\n'), 0xe9, ...utf8.encode('\n#include "señal.h"')]);
    assert.equal(decodeSourceBytes(bytes), '// año\n�\n#include "señal.h"');
  });

  it('sin ninguna tilde en UTF-8, un byte alto es Windows-1252', () => {
    assert.equal(decodeSourceBytes(Uint8Array.from([0x2f, 0x2f, 0x20, 0x63, 0x61, 0x66, 0xe9])), '// café');
  });
});

describe('un par UTF-8 por casualidad no vuelve UTF-8 un archivo de Windows-1252 (0.0.36)', () => {
  it('«Í» seguida de una comilla curva es un par valido, pero las demas tildes sueltas mandan', () => {
    const bytes = Uint8Array.from([
      ...new TextEncoder().encode('// l'), 0xed, ...new TextEncoder().encode('nea\n#include "l'), 0xf3, ...new TextEncoder().encode('gica.h"\ncout << "'),
      0x93, 0x53, 0xcd, 0x94, ...new TextEncoder().encode('";\n'),
    ]);
    assert.equal(decodeSourceBytes(bytes), '// línea\n#include "lógica.h"\ncout << "“SÍ”";\n');
  });
});

describe('leer un archivo del proyecto (0.0.38)', () => {
  const uri = { toString: () => 'file:///p/main.cpp' };
  const fs = (size: number, bytes = new TextEncoder().encode('int main(){}')) => {
    let reads = 0;
    return {
      fs: { stat: async () => ({ size }), readFile: async () => { reads += 1; return bytes; } },
      reads: () => reads,
    };
  };

  it('del editor si esta abierto (con lo no guardado), si no del disco', async () => {
    const disk = fs(12);
    assert.deepEqual(await readWorkspaceText(uri, new Map(), disk.fs, 1000), { text: 'int main(){}', languageId: '', bytes: 12 });
    const open = new Map([['file:///p/main.cpp', { getText: () => 'int main(){ return 0; }', languageId: 'cpp' }]]);
    const editor = fs(12);
    assert.deepEqual(await readWorkspaceText(uri, open, editor.fs, 1000), { text: 'int main(){ return 0; }', languageId: 'cpp', bytes: 12 });
    assert.equal(editor.reads(), 0, 'no lee el disco');
  });

  it('un archivo mas grande que el tope no se lee', async () => {
    const big = fs(5000);
    assert.equal(await readWorkspaceText(uri, new Map(), big.fs, 1000), null);
    assert.equal(big.reads(), 0);
  });
});
