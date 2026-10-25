import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { decodeSourceBytes } from '../source-text';

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
