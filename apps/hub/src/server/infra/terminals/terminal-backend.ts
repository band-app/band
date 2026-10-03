import type {
  SpawnOptions,
  TerminalAttachment,
  TerminalBackend,
  TerminalExitEvent,
  TerminalListEntry,
  TerminalSpawnRequest,
} from "@band-app/host-api";

/**
 * The backend contract lives in `@band-app/host-api`, because it is the PTY
 * part of the `Host` interface. Two implementations here:
 *
 *   - `DaemonTerminalBackend` — PTYs live in the detached terminal daemon, so
 *     they survive a web-server restart. The default on macOS and Linux.
 *   - `InProcessTerminalBackend` — PTYs live in this process and die with it.
 *     Used on Windows, when `BAND_TERMINAL_DAEMON=0`, and when the daemon
 *     cannot start.
 */
export type {
  SpawnOptions,
  TerminalAttachment,
  TerminalBackend,
  TerminalExitEvent,
  TerminalListEntry,
  TerminalSpawnRequest,
};

/**
 * Turns a `seq`-numbered output feed into a {@link TerminalAttachment}. Feed
 * it every chunk from the moment the subscription exists; it holds them until
 * {@link start}, then delivers only chunks after the snapshot's `seq`.
 *
 * The subscription has to exist before the snapshot is taken, so it sees some
 * chunks the snapshot already contains, and over the daemon socket it can see
 * chunks before the attach reply that carries the cut. Filtering on `seq` is
 * what makes both cases exact: a gap or a double-applied chunk corrupts
 * full-screen TUIs (claude-code, vim).
 */
export class AttachGate implements TerminalAttachment {
  snapshot = "";
  private cut = Number.POSITIVE_INFINITY;
  private pending: { data: string; seq: number }[] = [];
  private deliver: ((data: string) => void) | null = null;
  private detached = false;
  private held = false;

  constructor(
    private readonly onDetach: () => void,
    private readonly onHoldChange: (held: boolean) => void,
  ) {}

  /** Record the snapshot and the `seq` of the last chunk it contains. */
  setSnapshot(snapshot: string, seq: number): void {
    this.snapshot = snapshot;
    this.cut = seq;
  }

  push(data: string, seq: number): void {
    if (this.detached) return;
    if (!this.deliver) {
      this.pending.push({ data, seq });
      return;
    }
    if (seq > this.cut) this.deliver(data);
  }

  start(onData: (data: string) => void): void {
    if (this.detached || this.deliver) return;
    this.deliver = onData;
    const pending = this.pending;
    this.pending = [];
    for (const chunk of pending) {
      if (chunk.seq > this.cut) onData(chunk.data);
    }
  }

  setOutputHeld(held: boolean): void {
    if (this.detached || this.held === held) return;
    this.held = held;
    this.onHoldChange(held);
  }

  detach(): void {
    if (this.detached) return;
    this.setOutputHeld(false);
    this.detached = true;
    this.pending = [];
    this.deliver = null;
    this.onDetach();
  }
}
