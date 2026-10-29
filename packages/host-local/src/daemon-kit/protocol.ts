import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import type { Socket } from "node:net";
import { basename, dirname, join } from "node:path";

/**
 * The parts of a daemon's wire protocol that do not depend on what the daemon
 * hosts: NDJSON framing, the token hello, runtime file names and exit codes.
 * Each daemon keeps its own `PROTOCOL_VERSION` and request types.
 */

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

export interface DaemonPathsSpec {
  runDir: string;
  /** File name stem, such as `terminal-daemon`. */
  name: string;
  /** Prefix of the socket name when it falls back to `shortSocketDir()`. */
  shortPrefix: string;
  version: number;
}

/**
 * Runtime files for one protocol version, all under `runDir` except, when that
 * path is too long for a Unix socket, the socket itself. Derived only from the
 * spec, so every server on the same `HOME` finds the same daemon.
 */
export function daemonPathsFor(spec: DaemonPathsSpec): DaemonPaths {
  const { runDir, name, shortPrefix, version } = spec;
  const inRunDir = join(runDir, `${name}-v${version}.sock`);
  const socket =
    Buffer.byteLength(inRunDir) <= MAX_SOCKET_PATH_BYTES
      ? inRunDir
      : join(
          shortSocketDir(),
          `${shortPrefix}-${createHash("sha256").update(runDir).digest("hex").slice(0, 16)}-v${version}.sock`,
        );
  return {
    runDir,
    socket,
    token: join(runDir, `${name}-v${version}.token`),
    pid: join(runDir, `${name}-v${version}.pid`),
    log: join(runDir, `${name}.log`),
  };
}

/**
 * Where a superseded daemon stays reachable. When a daemon of a newer build
 * takes over the endpoint from a live one (see `publishEndpoint`), it first
 * hardlinks the incumbent's socket to a private name and copies its token and
 * pid record beside it, so a restarted server can still reattach what the old
 * daemon hosts. The old daemon never learns of these names; the daemon that
 * created them removes them once the old one is gone.
 *
 * The socket name is shorter than the canonical one, so it always fits
 * `sun_path` when the canonical path does.
 */
export function retiredDaemonPaths(paths: DaemonPaths, tag: string): DaemonPaths {
  return {
    ...paths,
    socket: join(dirname(paths.socket), `.r${tag}`),
    token: paths.token.replace(/\.token$/, `.retired-${tag}.token`),
    pid: paths.pid.replace(/\.pid$/, `.retired-${tag}.pid`),
  };
}

/** The retired daemons recorded next to `paths`, found by their token files. */
export function listRetiredDaemons(paths: DaemonPaths): DaemonPaths[] {
  const prefix = `${basename(paths.token, ".token")}.retired-`;
  let names: string[];
  try {
    names = readdirSync(paths.runDir);
  } catch {
    return [];
  }
  return (
    names
      .filter((name) => name.startsWith(prefix) && name.endsWith(".token"))
      .map((name) => name.slice(prefix.length, -".token".length))
      // The daemon's tags are 4 random bytes; any other length breaks the sun_path fit above.
      .filter((tag) => /^[0-9a-f]{8}$/.test(tag))
      .map((tag) => retiredDaemonPaths(paths, tag))
  );
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
  /**
   * The daemon's entry file. A daemon whose entry is gone (its worktree or
   * app bundle was deleted) can't load code it hasn't loaded yet, so a server
   * never starts sessions on it. Absent in records from older daemons.
   */
  entry?: string;
}

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

export function parseHello(frame: unknown): HelloMessage | null {
  if (typeof frame !== "object" || frame === null) return null;
  const hello = frame as Partial<HelloMessage>;
  if (
    hello.t !== "hello" ||
    typeof hello.protocol !== "number" ||
    typeof hello.token !== "string" ||
    (hello.role !== "control" && hello.role !== "stream") ||
    typeof hello.clientId !== "string" ||
    typeof hello.buildId !== "string"
  ) {
    return null;
  }
  return hello as HelloMessage;
}

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
