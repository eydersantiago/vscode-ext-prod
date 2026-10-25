// ADACEEN (VS Code): texto de un archivo leido de sus bytes (0.0.36), sin importar vscode.

/**
 * ¿Parece UTF-8 con algun byte suelto? Mas secuencias UTF-8 validas de varios bytes (tildes
 * guardadas en UTF-8) que bytes altos sueltos. Un archivo en Windows-1252 casi no tiene pares
 * validos por casualidad (Í seguida de una comilla curva si lo es: una sola no alcanza).
 */
function looksLikeUtf8(bytes: Uint8Array) {
  let valid = 0;
  let invalid = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const lead = bytes[index];
    if (lead < 0x80) {
      continue;
    }
    const length = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
    let ok = length > 0 && index + length <= bytes.length;
    for (let offset = 1; ok && offset < length; offset += 1) {
      ok = (bytes[index + offset] & 0xc0) === 0x80;
    }
    if (ok) {
      valid += 1;
      index += length - 1;
    } else {
      invalid += 1;
    }
  }
  return valid > invalid;
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
    if (looksLikeUtf8(bytes)) {
      return new TextDecoder('utf-8').decode(bytes);
    }
    // El TextDecoder de Node lee «windows-1252» como latin1: 0x93 queda como un caracter de
    // control y no como “. Se corrigen esos 27 (el del navegador ya lo hace bien).
    return new TextDecoder('windows-1252').decode(bytes).replace(/[\u0080-\u009f]/g, (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80] || ch);
  }
}

/** Windows-1252 entre 0x80 y 0x9f (los vacios no tienen caracter y quedan como estaban). */
const CP1252_HIGH = [
  '€', '', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '', 'Ž', '',
  '', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '', 'ž', 'Ÿ',
];
