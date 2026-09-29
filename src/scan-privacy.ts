// ADACEEN (VS Code): privacidad del escaneo del workspace (A12.12 · ADACEEN-155, riesgo 4).
// Funciones puras (sin la API de vscode) para decidir que NO sale del equipo: lo que ignora
// .gitignore, los archivos de claves y credenciales y lo que pasa del tope total.

/** Tope total del contenido que se envia en un escaneo (el backend acepta hasta 6 MB). */
export const DEFAULT_MAX_TOTAL_SCAN_BYTES = 3 * 1024 * 1024;

const SECRET_FILE_NAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.htpasswd',
  '.pgpass',
  'credentials',
  'credentials.json',
  'client_secret.json',
  'service-account.json',
  'serviceaccount.json',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'known_hosts',
  'authorized_keys',
]);

const SECRET_EXTENSIONS = new Set([
  'pem',
  'key',
  'p12',
  'pfx',
  'jks',
  'keystore',
  'ppk',
  'asc',
  'gpg',
  'tfvars',
  'kdbx',
]);

/** Plantillas de .env que no traen valores reales. */
const ENV_TEMPLATE_SUFFIXES = ['.example', '.sample', '.template', '.dist'];

/**
 * ¿La ruta es de un archivo que suele guardar claves o credenciales? (.env, llaves privadas,
 * .npmrc, credentials.json, client_secret*.json, *.pem, carpetas .aws/.ssh/.docker/.kube...).
 */
export function isSecretPath(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  const fileName = segments[segments.length - 1] || '';
  if (!fileName) {
    return false;
  }

  if (segments.slice(0, -1).some((segment) => ['.ssh', '.aws', '.docker', '.kube', '.gnupg', '.azure', '.gcloud'].includes(segment))) {
    return true;
  }

  if (fileName === '.env' || fileName.startsWith('.env.') || fileName.endsWith('.env')) {
    return !ENV_TEMPLATE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
  }

  if (SECRET_FILE_NAMES.has(fileName)) {
    return true;
  }
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(fileName)) {
    return true;
  }
  if (/^client_secret.*\.json$/.test(fileName) || /service[-_]?account.*\.json$/.test(fileName)) {
    return true;
  }

  const dot = fileName.lastIndexOf('.');
  const extension = dot > 0 ? fileName.slice(dot + 1) : '';
  return SECRET_EXTENSIONS.has(extension);
}

/** Patrones de alta confianza: claves privadas y tokens con prefijo conocido. */
const HIGH_CONFIDENCE_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, // tokens de GitHub
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, // Slack
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/, // OpenAI / Stripe
  /\b(?:AccountKey|SharedAccessKey)=[A-Za-z0-9+/=]{20,}/, // cadenas de conexion de Azure
  /\bmongodb(?:\+srv)?:\/\/[^\s:@/]+:[^\s@/]+@/, // URL con usuario y clave
  /\bpostgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@/,
];

/** Asignaciones genericas (password: ..., "apiKey": "...") que solo se miran en archivos de configuracion. */
const CONFIG_ASSIGNMENT_PATTERN =
  /["']?(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|connection[_-]?string)["']?\s*[:=]\s*["']?[^\s"',;]{8,}/i;

const CONFIG_EXTENSIONS = new Set(['json', 'yml', 'yaml', 'xml', 'properties', 'ini', 'toml', 'cfg', 'conf', 'env']);

/**
 * ¿El contenido parece traer una clave? En cualquier archivo se buscan patrones de alta
 * confianza (llaves privadas, tokens con prefijo); en los de configuracion (json, yml, xml...)
 * tambien asignaciones como `"password": "..."`. En el codigo del estudiante no se usan las
 * genericas: un ejercicio con `string password = "1234";` no es un secreto real.
 */
export function containsSecret(text: string, relativePath: string) {
  if (!text) {
    return false;
  }
  if (HIGH_CONFIDENCE_SECRET_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  const fileName = relativePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
  const dot = fileName.lastIndexOf('.');
  const extension = dot > 0 ? fileName.slice(dot + 1) : '';
  return CONFIG_EXTENSIONS.has(extension) && CONFIG_ASSIGNMENT_PATTERN.test(text);
}

/**
 * Salida de `git ls-files -z --cached --others --exclude-standard` (rutas separadas por NUL,
 * relativas a la carpeta): los archivos que git no ignora.
 */
export function parseGitLsFiles(output: string) {
  return new Set(
    output
      .split('\0')
      .map((item) => item.replace(/\\/g, '/').trim())
      .filter(Boolean),
  );
}

export type ScanPrivacyCounts = {
  skippedByGitignore: number;
  skippedAsSecret: number;
  skippedByBudget: number;
};

export function emptyScanPrivacyCounts(): ScanPrivacyCounts {
  return { skippedByGitignore: 0, skippedAsSecret: 0, skippedByBudget: 0 };
}

/** Texto del permiso que VS Code pide antes de enviar el escaneo pedido desde el navegador. */
export function describeScanPermission(repoFullName: string, maxFiles: number, maxTotalBytes: number) {
  const megabytes = Math.max(1, Math.round(maxTotalBytes / (1024 * 1024)));
  return `ADACEEN: el navegador pidió leer tu proyecto «${repoFullName}» para analizarlo. `
    + `Se envían hasta ${maxFiles} archivos de código (${megabytes} MB como máximo), `
    + 'sin lo que ignora .gitignore ni archivos con claves o contraseñas. ¿Lo permites?';
}
