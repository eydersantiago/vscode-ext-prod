// ADACEEN (VS Code): reglas de la cola de reemplazos del navegador (A12.12 · ADACEEN-155,
// riesgo 2). Funciones puras (sin la API de vscode) para que se puedan probar:
// - el aviso «Aplicar reemplazo»/«Omitir» se cierra solo, para no parar la cola;
// - un cambio ya aplicado se confirma con reintentos y nunca se reporta como fallido;
// - un cambio que volvio a la cola (lease vencido) no se aplica dos veces.

/** Tiempo que espera el aviso no modal antes de darlo por no respondido. */
export const CODE_ACTION_PROMPT_TIMEOUT_MS = 2 * 60 * 1000;

/** Esperas entre los reintentos de «complete» (despues del primer intento). */
export const CODE_ACTION_COMPLETE_RETRY_DELAYS_MS: readonly number[] = [1000, 3000];

export const PROMPT_TIMED_OUT = Symbol('prompt-timed-out');

/** Espera la respuesta de un aviso, o PROMPT_TIMED_OUT si nadie contesta a tiempo. */
export function promptWithTimeout<T>(
  prompt: PromiseLike<T>,
  timeoutMs: number,
): Promise<T | typeof PROMPT_TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(PROMPT_TIMED_OUT), timeoutMs);
    Promise.resolve(prompt).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export type CompletionOutcome = {
  /** completed: el backend lo registro; already_closed: ya estaba cerrado (404); unconfirmed: no se pudo avisar. */
  outcome: 'completed' | 'already_closed' | 'unconfirmed';
  attempts: number;
  lastError?: string;
};

function httpStatusOf(error: unknown) {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : 0;
}

/**
 * Confirma al backend un cambio que YA se aplico. Reintenta ante fallos pasajeros; un 404 es
 * que el cambio ya estaba cerrado (otro intento lo registro). Nunca devuelve «fallido»: el
 * cambio esta en el archivo y reportarlo como fallido seria un dato falso para la tesis.
 */
export async function confirmAppliedCodeAction(
  send: () => Promise<unknown>,
  options: { delaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<CompletionOutcome> {
  const delays = options.delaysMs ?? CODE_ACTION_COMPLETE_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError = '';
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (attempt > 0) {
      await sleep(delays[attempt - 1]);
    }
    try {
      await send();
      return { outcome: 'completed', attempts: attempt + 1 };
    } catch (error) {
      if (httpStatusOf(error) === 404) {
        return { outcome: 'already_closed', attempts: attempt + 1 };
      }
      lastError = String(error);
    }
  }
  return { outcome: 'unconfirmed', attempts: delays.length + 1, lastError };
}

/**
 * Un reemplazo que volvio a la cola (su primer reclamo vencio) pudo haberse aplicado ya: si el
 * archivo ya no tiene el codigo original y si tiene el nuevo, no se vuelve a aplicar. Solo para
 * reemplazos (no inserciones ni borrados, donde el texto nuevo podria existir por otra razon).
 */
export function replacementAlreadyApplied(input: {
  documentText: string;
  originalText: string;
  replacementText: string;
  applyMode: 'replace' | 'insert' | 'delete';
  attempts: number;
}) {
  if (input.applyMode !== 'replace' || input.attempts < 2) {
    return false;
  }
  const original = input.originalText.trim();
  const replacement = input.replacementText.trim();
  if (!original || !replacement || original === replacement || replacement.includes(original)) {
    return false;
  }
  return !input.documentText.includes(input.originalText) && input.documentText.includes(input.replacementText);
}
