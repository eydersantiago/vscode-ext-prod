// ADACEEN (VS Code): recordatorio de como pedir ayuda (0.0.40), sin importar vscode.
//
// Desde la 0.0.40 el tutor ya no responde solo al mover el cursor: hay que seleccionar un
// fragmento y elegir un pedido. Pedido de Eyder (5-11-2026): que la extension lo diga al entrar
// y cada 30 minutos. Si en ese rato el estudiante ya pidio ayuda, ya sabe como: no se repite.

export const SELECTION_HINT_TEXT =
  'ADACEEN: selecciona un fragmento de tu código y elige «Sugerencia ADACEEN», «Proponer una mejora» o «Proponer código para continuar» para que el tutor te ayude.';

export const SELECTION_HINT_ACTION = 'Entendido';

/** Minutos entre recordatorios por defecto (ajuste adaceen.suggestions.selectionHintMinutes). */
export const SELECTION_HINT_DEFAULT_MINUTES = 30;

export type SelectionHintState = {
  /** Cuando se mostro por ultima vez (null: todavia no en esta ventana de VS Code). */
  lastShownAt: number | null;
  /** Ultimo pedido de ayuda del estudiante (null: ninguno en esta ventana). */
  lastRequestAt: number | null;
};

/** Minutos del ajuste a milisegundos; 0, negativo o invalido apaga el recordatorio. */
export function selectionHintIntervalMs(minutes: unknown) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.round(Math.max(1, value) * 60_000);
}

/**
 * ¿Toca mostrar el recordatorio ahora? Al entrar (nunca se mostro) si; despues, cuando paso el
 * intervalo desde el ultimo y el estudiante no pidio ayuda en ese mismo rato.
 */
export function selectionHintDue(state: SelectionHintState, now: number, intervalMs: number) {
  if (intervalMs <= 0) {
    return false;
  }
  if (state.lastShownAt === null) {
    return true;
  }
  if (now - state.lastShownAt < intervalMs) {
    return false;
  }
  return state.lastRequestAt === null || now - state.lastRequestAt >= intervalMs;
}
