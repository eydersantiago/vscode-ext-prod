import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  containsSecret,
  DEFAULT_MAX_TOTAL_SCAN_BYTES,
  describeScanPermission,
  isSecretPath,
  parseGitLsFiles,
} from '../scan-privacy';

// A12.12 · ADACEEN-155, riesgo 4: el escaneo no envia lo que ignora .gitignore ni archivos con claves.

describe('scan-privacy: rutas de archivos con claves', () => {
  it('reconoce .env, llaves y credenciales', () => {
    for (const secret of [
      '.env',
      '.env.local',
      'backend/.env.production',
      'config/produccion.env',
      'certs/servidor.pem',
      'claves/privada.key',
      'firma.p12',
      '.npmrc',
      'credentials.json',
      'client_secret_1234.apps.googleusercontent.com.json',
      'mi-service-account-prod.json',
      '.ssh/id_ed25519',
      'home/.aws/config',
      'infra/prod.tfvars',
      'C:\\proyecto\\.env',
    ]) {
      assert.equal(isSecretPath(secret), true, secret);
    }
  });

  it('deja pasar el codigo y las plantillas sin valores', () => {
    for (const normal of [
      'src/main.cpp',
      'src/Usuario.h',
      'README.md',
      'package.json',
      '.env.example',
      'config/.env.sample',
      'docs/keyboard.md',
      'src/environment.ts',
      'tests/password_test.py',
    ]) {
      assert.equal(isSecretPath(normal), false, normal);
    }
  });
});

describe('scan-privacy: contenido con claves', () => {
  it('detecta llaves privadas y tokens con prefijo en cualquier archivo', () => {
    assert.equal(containsSecret('-----BEGIN RSA PRIVATE KEY-----\nMIIE...', 'src/util.cpp'), true);
    assert.equal(containsSecret('const token = "ghp_' + 'a'.repeat(36) + '";', 'src/app.ts'), true);
    assert.equal(containsSecret('AWS_KEY = "AKIAABCDEFGHIJKLMNOP"', 'src/deploy.py'), true);
    assert.equal(containsSecret('conn = "DefaultEndpointsProtocol=https;AccountKey=' + 'A'.repeat(30) + '"', 'src/app.cs'), true);
    assert.equal(containsSecret('url = "postgres://admin:clave123@db:5432/app"', 'src/db.py'), true);
  });

  it('en configuracion mira asignaciones; en el codigo del estudiante no', () => {
    assert.equal(containsSecret('{ "db": { "password": "SuperClave2026" } }', 'config/appsettings.json'), true);
    assert.equal(containsSecret('api_key: "abcdefghijk12345"', 'deploy/app.yml'), true);
    assert.equal(containsSecret('string password = "12345678";', 'src/Login.cpp'), false, 'ejercicio de login');
    assert.equal(containsSecret('{ "name": "adaceen", "version": "1.0.0" }', 'package.json'), false);
    assert.equal(containsSecret('', 'config.json'), false);
  });
});

describe('scan-privacy: git y mensaje de permiso', () => {
  it('lee la salida de git ls-files -z', () => {
    const visible = parseGitLsFiles('src/main.cpp\0README.md\0src\\Usuario.h\0\0');
    assert.deepEqual([...visible].sort(), ['README.md', 'src/Usuario.h', 'src/main.cpp']);
    assert.equal(parseGitLsFiles('').size, 0);
  });

  it('el permiso dice que se envia, cuanto y que no', () => {
    const text = describeScanPermission('eyder/fpoo-lab', 200, DEFAULT_MAX_TOTAL_SCAN_BYTES);
    assert.match(text, /eyder\/fpoo-lab/);
    assert.match(text, /200 archivos/);
    assert.match(text, /3 MB/);
    assert.match(text, /\.gitignore/);
    assert.match(text, /¿Lo permites\?$/);
  });
});
