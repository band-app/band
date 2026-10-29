import type { DaemonIdentity } from "../../daemon-kit/connection";
import { type DaemonPaths, daemonPathsFor } from "../../daemon-kit/protocol";
import type {
  SpawnOptions,
  TerminalExitEvent,
  TerminalListEntry,
  TerminalSnapshot,
} from "../terminal-pool";

/**
 * Wire protocol between the web server and the terminal daemon.
 *
 * Bump on any change to the messages below that an older peer would
 * misread. A daemon outlives app updates, so an old one can still be running
 * when a new server boots; the version is in every runtime file name, and a
 * new server retires daemons of older versions (see `retireOlderDaemons`).
 * Their sessions are lost on that upgrade. The one exception is a new
 * `ControlNotify` that is safe to ignore: a daemon drops notifies it doesn't
 * know, and since #652 new sessions only start on a daemon of the server's
 * own build, so adding one costs no shells.
 *
 * The hello / mismatch / shutdown exchange is the one part that must never
 * change: it is how a newer server asks an older daemon to exit.
 */
export const PROTOCOL_VERSION = 3;

/** How the kit's connection code names this daemon and which version a client speaks. */
export const IDENTITY: DaemonIdentity = { label: "Terminal daemon", protocol: PROTOCOL_VERSION };

/**
 * Daemon exit code for "could not load node-pty at startup". Failing fast
 * here (rather than serving spawn requests that would all fail the same way)
 * matters because Node's ESM loader caches a failed CommonJS evaluation for
 * the life of the process — only a fresh process gets a fresh chance.
 */
export const EXIT_NODE_PTY_UNAVAILABLE = 22;

/**
 * The error a daemon answers `spawn` with once another daemon has replaced
 * its endpoint. A server that sees it connects to the endpoint's new owner.
 */
export const ENDPOINT_LOST_ERROR = "Terminal daemon no longer owns its endpoint";

/**
 * Runtime files for one protocol version, all under `<bandHome>/run/`
 * except, when that path is too long for a Unix socket, the socket itself.
 * Derived only from `runDir`, so every server on the same `HOME` finds the
 * same daemon.
 */
export function daemonPaths(runDir: string, version = PROTOCOL_VERSION): DaemonPaths {
  return daemonPathsFor({ runDir, name: "terminal-daemon", shortPrefix: "td", version });
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface SpawnParams {
  worktreeId: string;
  terminalId: string;
  worktreeRoot: string;
  options?: SpawnOptions;
  cleanupOnExit?: boolean;
  baseEnv: Record<string, string>;
}

/** Request name -> [params, result]. Answered on the control connection. */
export interface DaemonRequests {
  spawn: [SpawnParams, TerminalListEntry];
  info: [{ terminalId: string }, TerminalListEntry | null];
  list: [{ worktreeId?: string }, TerminalListEntry[]];
  kill: [{ terminalId: string }, TerminalListEntry | null];
  killWorktree: [{ worktreeId: string }, null];
  scrollback: [{ terminalId: string; lines?: number }, string | null];
  write: [{ terminalId: string; data: string }, boolean];
  /**
   * Subscribe the caller's stream connection to the terminal and return a
   * snapshot. Stream chunks with `seq <= snapshot.seq` are already in it.
   */
  attach: [
    { terminalId: string; cols?: number; rows?: number },
    (TerminalSnapshot & { worktreeId: string; cleanupOnExit: boolean }) | null,
  ];
  ping: [Record<string, never>, { pid: number; sessions: number }];
}

export type DaemonRequestName = keyof DaemonRequests;

export type ControlRequest = {
  [K in DaemonRequestName]: { id: number; t: K } & DaemonRequests[K][0];
}[DaemonRequestName];

/** Fire-and-forget, no `id`, no reply. Ordered with requests on one connection. */
export type ControlNotify =
  /** Keystrokes: fire-and-forget, unlike the `write` request, which reports whether the terminal was live. */
  | { t: "input"; terminalId: string; data: string }
  | { t: "resize"; terminalId: string; cols: number; rows: number }
  | { t: "nudgeResize"; terminalId: string }
  | { t: "detach"; terminalId: string }
  /**
   * Pause / resume reading the PTY because this server's viewers are behind
   * on parsing its output. At most one hold per client and terminal; `detach`
   * and a dropped connection release it. Added without a version bump: an
   * older daemon ignores notifies it doesn't know (see `handleNotify`).
   */
  | { t: "hold"; terminalId: string }
  | { t: "release"; terminalId: string }
  | { t: "shutdown" };

export type ControlReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export type StreamEvent =
  | { t: "data"; id: string; seq: number; d: string }
  | ({ t: "exit" } & TerminalExitEvent);
