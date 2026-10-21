import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// out/unit-tests/*.test.js -> package.json de la extension.
const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
  version: string;
  capabilities?: { untrustedWorkspaces?: { supported: boolean | string; restrictedConfigurations?: string[] } };
  contributes: {
    commands: Array<{ command: string; title: string }>;
    menus: { commandPalette: Array<{ command: string; when: string }> };
    views: Record<string, Array<{ id: string; type?: string; name: string }>>;
    configuration: { properties: Record<string, unknown> };
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

  it('0.0.34: sigue activa en modo restringido (vscode.dev preguntaba si confiar y ADACEEN quedaba apagada)', () => {
    const trust = manifest.capabilities?.untrustedWorkspaces;
    assert.ok(trust, 'sin capabilities.untrustedWorkspaces VS Code la desactiva si el estudiante no confia en la carpeta');
    assert.equal(trust.supported, 'limited');
    const restricted = trust.restrictedConfigurations || [];
    for (const key of ['adaceen.backend.baseUrl', 'adaceen.backend.scanWorkerKey', 'adaceen.backend.sessionId', 'adaceen.backend.autoApplyCodeActions']) {
      assert.ok(restricted.includes(key), `${key}: una carpeta ajena no lo cambia en modo restringido`);
      assert.ok(key in manifest.contributes.configuration.properties, `${key} existe`);
    }
  });

  it('0.0.34: la vista «Este archivo» esta en el Explorador y sus comandos existen', () => {
    const fileView = (manifest.contributes.views.explorer || []).find((view) => view.id === 'adaceen.fileView');
    assert.ok(fileView, 'vista del resumen y el material en el Explorador');
    assert.equal(fileView.type, 'webview');
    for (const command of ['adaceen.openFileView', 'adaceen.openCourseMaterial', 'adaceen.showProposalDiff']) {
      assert.ok(manifest.contributes.commands.some((item) => item.command === command), command);
    }
    assert.ok(manifest.contributes.menus.commandPalette.some((item) => item.command === 'adaceen.openRagSource' && item.when === 'false'), 'sin argumento no sirve: fuera de la paleta');
  });
});
