import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import { join } from "node:path";
import type {
  SpawnOptions,
  TerminalExitEvent,
  TerminalListEntry,
  TerminalSnapshot,
} from "../terminal-pool";

/**
 * Wire protocol between the web server and the terminal daemon.
 *
 * Bump on ANY change to the messages below. A daemon outlives app updates, so
 * an old one can still be running when a new server boots; the version is in
 * every runtime file name, and a new server retires daemons of older versions
 * (see `retireOlderDaemons`). Their sessions are lost on that upgrade.
 *
 * The hello / mismatch / shutdown exchange is the one part that must never
 * change: it is how a newer server asks an older daemon to exit.
 */
export const PROTOCOL_VERSION = 1;

/** Daemon exit code for "a live daemon already owns the endpoint"; the launcher connects to it. */
export const EXIT_ENDPOINT_OCCUPIED = 20;
/** Daemon exit code for "could not publish the endpoint" (lost the race, or can't tell). */
export const EXIT_ENDPOINT_UNAVAILABLE = 21;

/** macOS `sockaddr_un.sun_path` is 104 bytes including the NUL. */
const MAX_SOCKET_PATH_BYTES = 103;

export interface DaemonPaths {
  runDir: string;
  socket: string;
  token: string;
  pid: string;
  log: string;
}

/**
 * Runtime files for one protocol version, all under `<bandHome>/run/`
 * except, when that path is too long for a Unix socket, the socket itself.
 * Derived only from `runDir`, so every server on the same `HOME` finds the
 * same daemon.
 */
export function daemonPaths(runDir: string, version = PROTOCOL_VERSION): DaemonPaths {
  const inRunDir = join(runDir, `terminal-daemon-v${version}.sock`);
  const socket =
    Buffer.byteLength(inRunDir) <= MAX_SOCKET_PATH_BYTES
      ? inRunDir
      : join(
          shortSocketDir(),
          `td-${createHash("sha256").update(runDir).digest("hex").slice(0, 16)}-v${version}.sock`,
        );
  return {
    runDir,
    socket,
    token: join(runDir, `terminal-daemon-v${version}.token`),
    pid: join(runDir, `terminal-daemon-v${version}.pid`),
    log: join(runDir, "terminal-daemon.log"),
  };
}

/**
 * Fallback socket directory for homes whose run dir makes the socket path
 * too long (deep `$TMPDIR`-based homes, mostly tests). `/tmp` rather than
 * `os.tmpdir()`: macOS gives each launch context its own `$TMPDIR`, and two
 * servers on one home must agree on the path. `/tmp` is shared, so this
 * directory is private ONLY because of the uid/mode checks in `endpoint.ts`
 * (`ensurePrivateDir` for the daemon, `checkEndpointOwner` for clients).
 * Never drop those checks.
 */
export function shortSocketDir(): string {
  return join("/tmp", `band-${process.getuid?.() ?? "user"}`);
}

export interface PidRecord {
  pid: number;
  protocol: number;
  buildId: string;
  startedAt: string;
  /** The socket this daemon published, which may live outside the run dir. */
  socket: string;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type ClientRole = "control" | "stream";

export interface HelloMessage {
  t: "hello";
  protocol: number;
  token: string;
  role: ClientRole;
  /** Pairs a client's control and stream connections. */
  clientId: string;
  buildId: string;
}

export type HelloReply =
  | { t: "ready"; protocol: number; pid: number; buildId: string }
  /** Token was valid but the versions differ; only `shutdown` is accepted next. */
  | { t: "mismatch"; protocol: number; pid: number }
  | { t: "rejected"; reason: string };

export interface SpawnParams {
  workspaceId: string;
  terminalId: string;
  workspaceRoot: string;
  options?: SpawnOptions;
  cleanupOnExit?: boolean;
  baseEnv: Record<string, string>;
}

/** Request name -> [params, result]. Answered on the control connection. */
export interface DaemonRequests {
  spawn: [SpawnParams, TerminalListEntry];
  info: [{ terminalId: string }, TerminalListEntry | null];
  list: [{ workspaceId?: string }, TerminalListEntry[]];
  kill: [{ terminalId: string }, TerminalListEntry | null];
  killWorkspace: [{ workspaceId: string }, null];
  scrollback: [{ terminalId: string; lines?: number }, string | null];
  write: [{ terminalId: string; data: string }, boolean];
  /**
   * Subscribe the caller's stream connection to the terminal and return a
   * snapshot. Stream chunks with `seq <= snapshot.seq` are already in it.
   */
  attach: [
    { terminalId: string; cols?: number; rows?: number },
    (TerminalSnapshot & { workspaceId: string; cleanupOnExit: boolean }) | null,
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
  | { t: "shutdown" };

export type ControlReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export type StreamEvent =
  | { t: "data"; id: string; seq: number; d: string }
  | ({ t: "exit" } & TerminalExitEvent);

// ---------------------------------------------------------------------------
// NDJSON framing
// ---------------------------------------------------------------------------

/** One JSON value per `\n`-terminated line. */
export function writeFrame(socket: Socket, message: unknown): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

/**
 * Parse `socket` as NDJSON, calling `onFrame` per line. A malformed line or
 * one over `maxLineBytes` destroys the socket: the peer is broken or hostile
 * and nothing after it can be trusted to be framed correctly.
 */
export function readFrames(
  socket: Socket,
  onFrame: (frame: unknown) => void,
  maxLineBytes = 64 * 1024 * 1024,
): void {
  // Pending chunks of an unfinished line. Joined only once a newline arrives,
  // and only the newest chunk is scanned for one, so a multi-MB frame (an
  // attach snapshot) costs O(size) rather than O(size^2) to reassemble.
  let chunks: string[] = [];
  let pendingBytes = 0;
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    if (!chunk.includes("\n")) {
      chunks.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes > maxLineBytes) socket.destroy(new Error("Frame too large"));
      return;
    }
    chunks.push(chunk);
    // Most frames arrive whole in one read; don't copy them.
    let buffer = chunks.length === 1 ? chunk : chunks.join("");
    chunks = [];
    pendingBytes = 0;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        let frame: unknown;
        try {
          frame = JSON.parse(line);
        } catch {
          socket.destroy(new Error("Malformed frame"));
          return;
        }
        onFrame(frame);
        if (socket.destroyed) return;
      }
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > 0) {
      chunks.push(buffer);
      pendingBytes = buffer.length;
      if (pendingBytes > maxLineBytes) socket.destroy(new Error("Frame too large"));
    }
  });
}
