import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// out/unit-tests/*.test.js -> package.json de la extension.
const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
  version: string;
  contributes: {
    commands: Array<{ command: string; title: string }>;
    menus: { commandPalette: Array<{ command: string; when: string }> };
  };
};

describe('package.json', () => {
  it('«ADACEEN: Configurar sesión compartida» sigue en la paleta (el navegador manda a buscarlo con F1)', () => {
    const command = manifest.contributes.commands.find((item) => item.command === 'adaceen.setBackendSessionId');
    assert.ok(command, 'el comando sigue existiendo por compatibilidad');
    assert.equal(command.title, 'ADACEEN: Configurar sesión compartida');
    const hidden = manifest.contributes.menus.commandPalette.find((item) => item.command === 'adaceen.setBackendSessionId');
    assert.equal(hidden, undefined, 'F1 lo encuentra: el overlay con un backend sin emparejamiento y los navegadores anteriores lo citan');
  });

  it('«ADACEEN: Conectar» sigue en la paleta', () => {
    assert.ok(manifest.contributes.commands.some((item) => item.command === 'adaceen.connect' && item.title === 'ADACEEN: Conectar'));
    assert.ok(!manifest.contributes.menus.commandPalette.some((item) => item.command === 'adaceen.connect'));
  });
});
