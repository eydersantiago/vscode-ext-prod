// ADACEEN (VS Code): lo que el estudiante escribe o elige al conectar (codigo de emparejamiento, sesion pegada), sus botones y avisos.
// Movido sin cambios desde src/editor-session.ts (solo se agrego "export" y los imports).
import { isLegacySessionUuid, isSafeSessionId } from './editor-session-records';

/** Alfabeto de los codigos de emparejamiento (sin I, L, O, 0 ni 1). */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Una sesion pegada que no es UUID tiene que ser larga: si no, es un codigo mal escrito. */
const PASTED_SESSION_MIN_CHARS = 24;
// ---------------------------------------------------------------------------
// Codigos de emparejamiento y sesiones pegadas

/**
 * Codigo de un solo uso del navegador: 8 caracteres del alfabeto en dos
 * grupos. Acepta minusculas, espacios y guiones (tambien los tipograficos que
 * aparecen al copiar); devuelve "XXXX-XXXX" o null.
 */
export function normalizePairingCode(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const compact = value.toUpperCase().replace(/[\s\-‐-―_.]+/g, '');
  if (compact.length !== 8) {
    return null;
  }
  for (const char of compact) {
    if (!PAIRING_CODE_ALPHABET.includes(char)) {
      return null;
    }
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export type ConnectInput =
  | { kind: 'code'; code: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'empty' }
  | { kind: 'invalid' };

/**
 * Lo que el estudiante escribe o pega en «Tengo un codigo o sesion» (o en
 * «Configurar sesion compartida», que abre la misma caja): un codigo XXXX-XXXX
 * (se canjea) o, por compatibilidad, el UUID de sesion que copiaba el navegador.
 */
export function classifyConnectInput(value: unknown): ConnectInput {
  const text = String(value ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!text) {
    return { kind: 'empty' };
  }
  const code = normalizePairingCode(text);
  if (code) {
    return { kind: 'code', code };
  }
  if (isLegacySessionUuid(text)) {
    return { kind: 'session', sessionId: text.toLowerCase() };
  }
  if (isSafeSessionId(text) && text.length >= PASTED_SESSION_MIN_CHARS) {
    return { kind: 'session', sessionId: text };
  }
  return { kind: 'invalid' };
}

/** Mensaje para validateInput de la caja de texto (undefined = valido). */
export function connectInputProblem(value: string): string | undefined {
  const input = classifyConnectInput(value);
  if (input.kind === 'code' || input.kind === 'session') {
    return undefined;
  }
  // Vacio no es error: la caja recien abierta no debe salir en rojo.
  return input.kind === 'empty'
    ? undefined
    : 'El código tiene 8 letras o números (XXXX-XXXX). También sirve el ID de sesión copiado del navegador.';
}

// ---------------------------------------------------------------------------
// Textos de «ADACEEN: Conectar» y del aviso de sesion perdida (editor-connect.ts
// los muestra; aqui se prueban sin vscode)

export type ConnectChoiceId = 'github' | 'code' | 'disconnect';

export type ConnectChoice = {
  id: ConnectChoiceId;
  /** Con icono de VS Code ($(...)); la guia cita el texto sin el icono. */
  label: string;
  detail: string;
};

/** Opcion de «ADACEEN: Conectar» para escribir o pegar (sin el icono). */
export const CONNECT_CODE_CHOICE = 'Tengo un código o sesión';

/** Caja de texto de «Tengo un codigo o sesion» (y de «Configurar sesion compartida»). */
export const CONNECT_CODE_PROMPT = {
  // Literal (no con CONNECT_CODE_CHOICE): la guia y sus pruebas buscan el texto tal cual.
  title: 'ADACEEN: Tengo un código o sesión',
  prompt: 'Escribe el código de 8 caracteres que muestra el navegador (por ejemplo K7P4-M2QX). También puedes pegar un ID de sesión de versiones anteriores.',
  placeHolder: 'XXXX-XXXX o ID de sesión',
} as const;

/**
 * Opciones de «ADACEEN: Conectar». Escribir o pegar es una sola opcion
 * («Tengo un codigo o sesion»): la caja acepta el codigo XXXX-XXXX o el ID de
 * sesion de antes (classifyConnectInput decide). «Desconectar este equipo» solo
 * aparece si la sesion vigente esta guardada en este VS Code.
 */
export function connectChoices(options: { canDisconnect: boolean }): ConnectChoice[] {
  const choices: ConnectChoice[] = [
    {
      id: 'github',
      label: '$(github) Con mi cuenta de GitHub (recomendado)',
      detail: 'Un clic en «Permitir». Usa la cuenta de GitHub que conectaste en ADACEEN.',
    },
    {
      id: 'code',
      label: '$(key) Tengo un código o sesión',
      detail: 'El código XXXX-XXXX que muestra el overlay de ADACEEN (dura 10 minutos). También acepta el ID de sesión de versiones anteriores.',
    },
  ];
  if (options.canDisconnect) {
    choices.push({
      id: 'disconnect',
      label: '$(debug-disconnect) Desconectar este equipo',
      detail: 'Olvida la sesión guardada en VS Code (por ejemplo, en un equipo compartido o si no eres tú).',
    });
  }
  return choices;
}

/**
 * Botones del aviso «ADACEEN: no se pudo conectar…». Un docente que probo con
 * GitHub (staff_requires_code) no tiene nada que reintentar: su boton abre
 * directamente la caja del codigo.
 */
export function connectFailureActions(error: string, canRetry: boolean): string[] {
  if (error === 'staff_requires_code') {
    return [CONNECT_CODE_CHOICE];
  }
  return canRetry ? ['Reintentar', 'Conectar de otra forma'] : ['Conectar de otra forma'];
}

/** Boton del aviso de sesion perdida (abre «ADACEEN: Conectar»). */
export const SESSION_LOST_ACTION = 'Conectar';

/**
 * Aviso unico cuando la sesion deja de valer. El texto nombra el boton que
 * ofrece («Conectar»); en el tunel recuerda ademas que «Abrir mi editor» en el
 * navegador escribe una sesion nueva y VS Code la toma solo.
 */
export function sessionLostWarning(fromTunnel: boolean): { message: string; action: string } {
  const lead = 'ADACEEN: tu sesión dejó de valer (por ejemplo, cerraste sesión en el navegador).';
  return {
    message: fromTunnel
      ? `${lead} Pulsa «${SESSION_LOST_ACTION}» o vuelve a pulsar «Abrir mi editor» en el navegador para que tus sugerencias y métricas queden a tu nombre.`
      : `${lead} Pulsa «${SESSION_LOST_ACTION}» para que tus sugerencias y métricas queden a tu nombre.`,
    action: SESSION_LOST_ACTION,
  };
}
