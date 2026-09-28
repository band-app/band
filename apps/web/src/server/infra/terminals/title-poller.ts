import type { TerminalListEntry } from "./terminal-pool";

/**
 * Tab-title poll cadence. A 1 s poll picked up `cd`/`vim` transitions ~2 s
 * sooner but kept the event loop awake at 1 Hz; 3 s still reads as immediate.
 */
const TITLE_POLL_MS = 3_000;

/**
 * Reports each watched terminal's foreground process name (its tab title),
 * the way iTerm tracks the running command without OSC sequences.
 *
 * One `listAll` per tick serves every watched terminal, instead of one
 * daemon round trip per viewer, and the timer runs only while something is
 * watched. `listAll` is a function so it always reaches the current backend.
 */
export class TitlePoller {
  private readonly listeners = new Map<string, Set<(title: string) => void>>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(private readonly listAll: () => Promise<TerminalListEntry[]>) {}

  /** Call `listener` with `terminalId`'s title every tick. Returns an unsubscribe function. */
  watch(terminalId: string, listener: (title: string) => void): () => void {
    let set = this.listeners.get(terminalId);
    if (!set) {
      set = new Set();
      this.listeners.set(terminalId, set);
    }
    set.add(listener);
    this.timer ??= setInterval(() => this.poll(), TITLE_POLL_MS);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(terminalId) === set) {
        this.listeners.delete(terminalId);
      }
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  private poll(): void {
    // Skip a tick rather than stack polls behind a slow backend.
    if (this.polling) return;
    this.polling = true;
    this.listAll()
      .then((entries) => {
        for (const entry of entries) {
          if (!entry.title) continue;
          for (const listener of this.listeners.get(entry.terminalId) ?? []) {
            listener(entry.title);
          }
        }
      })
      .catch(() => {
        // A failed poll just skips this tick's title updates.
      })
      .finally(() => {
        this.polling = false;
      });
  }
}
