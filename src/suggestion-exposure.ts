// ADACEEN (VS Code): cuanto estuvo a la vista cada sugerencia, para vscode_suggestion_ignored.
// Movido sin cambios desde src/telemetry.ts (solo se agrego "export" y los imports).

/**
 * Sigue cuanto tiempo estuvo a la vista una sugerencia para poder emitir
 * vscode_suggestion_ignored cuando se reemplaza o se descarta sin aplicarse.
 *
 * - markShown: la sugerencia se mostro (tras vscode_suggestion_shown).
 * - onPublish: cambia lo que se ve. Un marcador "cargando" no decide nada
 *   todavia (la respuesta nueva puede traer la misma sugerencia); una
 *   sugerencia distinta o null la dan por ignorada; la misma marcada como
 *   aplicada deja de seguirse.
 */
export class SuggestionExposureTracker<T> {
  private visible: { id: string; item: T; shownAt: number; hiddenAt: number | null } | null = null;

  get currentId(): string {
    return this.visible?.id || '';
  }

  /** Cuando se mostro la sugerencia que se sigue ahora (null si es otra o ninguna). */
  shownAt(id: string): number | null {
    return this.visible && this.visible.id === id ? this.visible.shownAt : null;
  }

  markShown(id: string, item: T, now: number) {
    if (!id) {
      return;
    }
    if (this.visible?.id === id) {
      this.visible.item = item;
      this.visible.hiddenAt = null;
      return;
    }
    this.visible = { id, item, shownAt: now, hiddenAt: null };
  }

  onPublish(
    next: { id: string; loading?: boolean; applied?: boolean } | null,
    now: number,
  ): { item: T; durationMs: number } | null {
    const current = this.visible;
    if (!current) {
      return null;
    }
    if (next && next.id === current.id) {
      if (next.applied) {
        this.visible = null;
      } else if (next.loading) {
        if (current.hiddenAt === null) {
          current.hiddenAt = now;
        }
      } else {
        current.hiddenAt = null;
      }
      return null;
    }
    if (next?.loading) {
      if (current.hiddenAt === null) {
        current.hiddenAt = now;
      }
      return null;
    }
    this.visible = null;
    const endedAt = current.hiddenAt ?? now;
    return { item: current.item, durationMs: Math.max(0, endedAt - current.shownAt) };
  }

  /**
   * La sugerencia sigue en otra (0.0.34: el estudiante pidio el codigo de una
   * accion y llego una version con codigo): no cuenta como ignorada.
   */
  forget(id: string) {
    if (this.visible?.id === id) {
      this.visible = null;
    }
  }

  /** El estudiante cerro la sugerencia (p. ej. la ventana flotante). */
  dismiss(id: string, now: number): { item: T; durationMs: number } | null {
    const current = this.visible;
    if (!current || current.id !== id) {
      return null;
    }
    this.visible = null;
    const endedAt = current.hiddenAt ?? now;
    return { item: current.item, durationMs: Math.max(0, endedAt - current.shownAt) };
  }
}
