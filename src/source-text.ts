// ADACEEN (VS Code): texto de un archivo leido de sus bytes (0.0.36), sin importar vscode.

/** ¿Hay al menos una secuencia UTF-8 valida de varios bytes (una tilde guardada en UTF-8)? */
function hasUtf8Sequence(bytes: Uint8Array) {
  for (let index = 0; index < bytes.length; index += 1) {
    const lead = bytes[index];
    const length = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
    if (!length || index + length > bytes.length) {
      continue;
    }
    let valid = true;
    for (let offset = 1; offset < length; offset += 1) {
      if ((bytes[index + offset] & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
    }
    if (valid) {
      return true;
    }
  }
  return false;
}

/**
 * UTF-8 y, si no lo es, Windows-1252 (lo que guardan Dev-C++ y el Bloc de notas en espanol).
 * Un archivo UTF-8 con un byte suelto pegado de otra codificacion sigue siendo UTF-8: solo ese
 * byte queda como «�» (antes todo el archivo se leia como Windows-1252 y las tildes salian
 * «Ã­»; revision independiente del 25/10/2026).
 */
export function decodeSourceBytes(bytes: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder(hasUtf8Sequence(bytes) ? 'utf-8' : 'windows-1252').decode(bytes);
  }
}
