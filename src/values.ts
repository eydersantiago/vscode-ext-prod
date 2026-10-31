// ADACEEN (VS Code): lectura de valores sueltos (JSON del backend, ajustes) sin importar vscode
// (0.0.38). settings.ts y workspace-index.ts los re-exportan para no cambiar a quien ya los usa.

/** Una cadena con texto (sin espacios a los lados), o undefined. */
export function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Un objeto (no null ni arreglo), o un objeto vacio. */
export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

/** Hash corto y estable de un texto (FNV-1a de 32 bits, en hexadecimal): claves de cache e ids. */
export function stableStringHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
