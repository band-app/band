/**
 * Whether a layout split is being dragged.
 *
 * While a sash moves, every pane around it changes size on each pointer move.
 * A terminal must not refit and send its PTY a new size at each step: it waits
 * for `endLayoutResize` and fits once. `terminal-cache.ts` reads this.
 */

let active = 0;
const endListeners = new Set<() => void>();

export function isLayoutResizing(): boolean {
  return active > 0;
}

export function beginLayoutResize(): void {
  active++;
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-band-layout-resizing", "");
  }
}

export function endLayoutResize(): void {
  if (active === 0) return;
  active--;
  if (active > 0) return;
  if (typeof document !== "undefined") {
    document.documentElement.removeAttribute("data-band-layout-resizing");
  }
  for (const fn of [...endListeners]) fn();
}

/** Called once each time the last sash drag ends. Returns an unsubscribe. */
export function onLayoutResizeEnd(fn: () => void): () => void {
  endListeners.add(fn);
  return () => endListeners.delete(fn);
}
