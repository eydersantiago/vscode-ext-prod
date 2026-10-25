import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  containsSecret,
  DEFAULT_MAX_TOTAL_SCAN_BYTES,
  describeScanPermission,
  isSecretPath,
  parseGitLsFiles,
  scrubOutline,
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

describe('scan-privacy: estructura de los archivos relacionados (0.0.36)', () => {
  it('quita las lineas con una clave y el valor de las constantes con nombre de clave', () => {
    const outline = [
      '1: class Config {',
      '3:   const std::string API_KEY = "abc123secreto";',
      '4:   const std::string TOKEN = "AKIAABCDEFGHIJKLMNOP";',
      '5:   std::string clave_admin = "1234";',
      '6:   int lados = 4;',
      '7:   std::string nombre = "Figura";',
      '9:   bool login(const std::string& password = "x");',
    ].join('\n');
    assert.equal(scrubOutline(outline, 'src/config.h'), [
      '1: class Config {',
      '3:   const std::string API_KEY = "…";',
      '5:   std::string clave_admin = "…";',
      '6:   int lados = 4;',
      '7:   std::string nombre = "Figura";',
      '9:   bool login(const std::string& password = "…");',
    ].join('\n'), 'la linea con una llave de AWS se quita entera; lo demas queda igual');
    assert.equal(scrubOutline('', 'a.h'), '');
  });
});

describe('scan-privacy: estructura sin claves, rapido (revision independiente, 0.0.36)', () => {
  it('una linea cortada con muchas barras invertidas no congela la extension', () => {
    const line = `12:   std::string menuClave = "${'\\n'.repeat(70)}xxxxxxxx`;
    const started = Date.now();
    const scrubbed = scrubOutline(line, 'src/menu.h');
    assert.ok(Date.now() - started < 200, 'antes tardaba minutos');
    assert.equal(scrubbed, '12:   std::string menuClave = "…"');
    const rutas = `13:   std::string rutaClaves = "C:${'\\\\d'.repeat(30)}`;
    const t2 = Date.now();
    scrubOutline(rutas, 'src/menu.h');
    assert.ok(Date.now() - t2 < 200);
  });

  it('enmascara cada nombre de clave, tambien en argumentos por defecto y cadenas cortadas', () => {
    assert.equal(
      scrubOutline('4: def conectar(host="localhost", usuario="root", password="MiClave2026"):', 'db.py'),
      '4: def conectar(host="localhost", usuario="root", password="…"):',
    );
    assert.equal(
      scrubOutline('7:   void entrar(const std::string& usuario = "admin", const std::string& clave = "MiClave2026");', 'login.h'),
      '7:   void entrar(const std::string& usuario = "admin", const std::string& clave = "…");',
    );
    assert.equal(scrubOutline('9:   std::string password_bd = "MiClaveSuperSecreta-1234567890…', 'cfg.h'), '9:   std::string password_bd = "…"');
  });

  it('una direccion con usuario y clave no llega al tutor, se llame como se llame la variable', () => {
    const mysql = '3:   const std::string url = "mysql://root:MiClave2026@localhost/tienda";';
    assert.equal(containsSecret(mysql, 'db.h'), true);
    assert.equal(scrubOutline(mysql, 'db.h'), '', 'la linea no viaja');
    assert.equal(
      scrubOutline('5: API = "https://ana:MiClave2026@api.ejemplo.com/v1"', 'cliente.py'),
      '5: API = "https://…@api.ejemplo.com/v1"',
    );
    assert.equal(scrubOutline('6: DOCS = "https://docs.ejemplo.com/v1"', 'cliente.py'), '6: DOCS = "https://docs.ejemplo.com/v1"');
  });

  it('tambien sin usuario (redis://:clave@), con pwd y en cadenas de conexion de C# o JDBC', () => {
    assert.equal(containsSecret('url = "redis://:MiClave2026@localhost:6379"', 'app.py'), true);
    assert.equal(scrubOutline('2:   std::string pwd = "MiClave2026";', 'banco.h'), '2:   std::string pwd = "…";');
    assert.equal(
      scrubOutline('7: const string conexion = "Server=localhost;Database=tienda;User Id=sa;Password=Secreta123;";', 'Datos.cs'),
      '7: const string conexion = "Server=localhost;Database=tienda;User Id=sa;Password=…;";',
    );
    assert.equal(
      scrubOutline('8: String url = "jdbc:mysql://localhost:3306/tienda?user=root&password=Secreta123";', 'Conexion.java'),
      '8: String url = "jdbc:mysql://localhost:3306/tienda?user=root&password=…";',
    );
  });
});

