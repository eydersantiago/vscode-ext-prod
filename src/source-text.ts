// ADACEEN (VS Code): texto de un archivo leido de sus bytes (0.0.36), sin importar vscode.

/**
 * UTF-8 y, si no lo es, Windows-1252 (lo que guardan Dev-C++ y el Bloc de notas en espanol).
 * Antes un archivo con tildes en Latin-1 llegaba al tutor y al escaneo con «�».
 */
export function decodeSourceBytes(bytes: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
