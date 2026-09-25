import type { SpawnOptions, TerminalExitEvent, TerminalListEntry } from "./terminal-pool";

export type { SpawnOptions, TerminalExitEvent, TerminalListEntry };

/**
 * Everything `TerminalService` needs from wherever the PTYs live. Two
 * implementations:
 *
 *   - `DaemonTerminalBackend` — PTYs live in the detached terminal daemon, so
 *     they survive a web-server restart. The default on macOS and Linux.
 *   - `InProcessTerminalBackend` — PTYs live in this process and die with it.
 *     Used on Windows, when `BAND_TERMINAL_DAEMON=0`, and when the daemon
 *     cannot start.
 *
 * Async throughout because the daemon answers over a socket. `write`,
 * `resize` and `nudgeResize` are fire-and-forget: the daemon keeps their
 * order on one connection, and none of their callers can act on a reply.
 */
export interface TerminalBackend {
  /**
   * Spawn (or return the already-live) PTY for `terminalId`. Idempotent per
   * id, including across concurrent calls (issue #617).
   */
  spawn(request: TerminalSpawnRequest): Promise<TerminalListEntry>;
  /** Metadata for one live terminal, or `null` if it isn't live. */
  info(terminalId: string): Promise<TerminalListEntry | null>;
  list(workspaceId: string): Promise<TerminalListEntry[]>;
  listAll(): Promise<TerminalListEntry[]>;
  /** Kill one terminal. Resolves with its entry, or `null` if it wasn't live. */
  kill(terminalId: string): Promise<TerminalListEntry | null>;
  killWorkspace(workspaceId: string): Promise<void>;
  getScrollback(terminalId: string, lines?: number): Promise<string | null>;
  /** Resolves `false` when the terminal isn't live. */
  write(terminalId: string, data: string): Promise<boolean>;
  resize(terminalId: string, cols: number, rows: number): void;
  /** Force a live TUI to repaint after a re-attach — see `TerminalPool.nudgeResize`. */
  nudgeResize(terminalId: string): void;
  /**
   * Replay-on-attach. Resizes to `dims`, then resolves with a serialized
   * snapshot of the terminal. Call {@link TerminalAttachment.start} once the
   * snapshot is on its way to the client: from then on `onData` receives
   * every chunk produced after the snapshot, each exactly once and in order.
   * Resolves `null` when the terminal isn't live.
   */
  attach(
    terminalId: string,
    dims?: { cols: number; rows: number },
  ): Promise<TerminalAttachment | null>;
  /** Subscribe to every terminal's exit. Returns an unsubscribe function. */
  onExit(listener: (event: TerminalExitEvent) => void): () => void;
  /**
   * Release this process's hold on the backend at server shutdown. The
   * in-process backend kills its PTYs; the daemon backend only disconnects,
   * which is what lets shells outlive the server.
   */
  close(): Promise<void>;
}

export interface TerminalSpawnRequest {
  workspaceId: string;
  terminalId: string;
  /** Absolute worktree path; `options.cwd` resolves inside it. */
  workspaceRoot: string;
  options?: SpawnOptions;
  cleanupOnExit?: boolean;
}

export interface TerminalAttachment {
  snapshot: string;
  start(onData: (data: string) => void): void;
  detach(): void;
}

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

  constructor(private readonly onDetach: () => void) {}

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

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.pending = [];
    this.deliver = null;
    this.onDetach();
  }
}
