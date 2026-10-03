/**
 * Everything the hub needs from wherever a host's PTYs live. The hub's
 * terminal daemon backend and in-process backend implement it today; a remote
 * host will tunnel the same calls over the worker link.
 */

/** Options for spawning a new PTY session. */
export interface SpawnOptions {
  /** Shell command to auto-run after the PTY spawns. */
  command?: string;
  /** Working directory, resolved relative to the workspace root. */
  cwd?: string;
  /** Extra environment variables merged into the base env. */
  env?: Record<string, string>;
}

/**
 * Fired once per session when its PTY exits, for natural exits and explicit
 * kills alike.
 */
export interface TerminalExitEvent {
  terminalId: string;
  workspaceId: string;
  exitCode: number;
  /** True when the exit came from a kill (`kill`, `killWorkspace`, daemon restart). */
  killed: boolean;
  cleanupOnExit: boolean;
}

/** Metadata about a live terminal, with no reference to the PTY itself. */
export interface TerminalListEntry {
  terminalId: string;
  workspaceId: string;
  pid: number;
  scrollbackLength: number;
  title: string;
  /** Prune the tab when the shell exits on its own. */
  cleanupOnExit: boolean;
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
  /**
   * Pause (`true`) or resume reading the terminal's PTY on this viewer's
   * behalf, for a client that has fallen behind parsing its output. Each
   * attachment holds at most once; the PTY resumes when no attachment (and no
   * other holder, such as a backed-up daemon stream) holds it. `detach`
   * releases a hold that is still set.
   */
  setOutputHeld(held: boolean): void;
  detach(): void;
}

/**
 * Async throughout because a daemon or remote host answers over a socket.
 * `write`, `resize` and `nudgeResize` are fire-and-forget: the backend keeps
 * their order on one connection, and none of their callers can act on a reply.
 */
export interface TerminalBackend {
  /**
   * Spawn (or return the already-live) PTY for `terminalId`. Idempotent per
   * id, including across concurrent calls.
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
  /** Keystrokes: like {@link write}, but fire-and-forget, ordered with `resize`. */
  input(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  /** Force a live TUI to repaint after a re-attach. */
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
   * End every terminal hosted by the current daemon and let the next spawn
   * start a fresh one. A no-op (`{ killedCount: 0 }`) when there is no
   * separate daemon process to restart.
   */
  restartDaemon(): Promise<{ killedCount: number }>;
  /**
   * Release this process's hold on the backend at server shutdown. The
   * in-process backend kills its PTYs; the daemon backend only disconnects,
   * which is what lets shells outlive the server.
   */
  close(): Promise<void>;
}
