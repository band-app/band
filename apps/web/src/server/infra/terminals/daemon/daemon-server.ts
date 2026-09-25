import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { createLogger } from "@band-app/logger";
import { TerminalPool } from "../terminal-pool";
import {
  type EndpointIdentity,
  endpointOwnership,
  ensurePrivateDir,
  privateBindPath,
  publishEndpoint,
} from "./endpoint";
import {
  type ClientRole,
  type ControlNotify,
  type ControlReply,
  type ControlRequest,
  type DaemonPaths,
  type DaemonRequests,
  EXIT_ENDPOINT_OCCUPIED,
  EXIT_ENDPOINT_UNAVAILABLE,
  type HelloMessage,
  type HelloReply,
  type PidRecord,
  PROTOCOL_VERSION,
  readFrames,
  type StreamEvent,
  writeFrame,
} from "./protocol";

const log = createLogger("terminal-daemon");

const HELLO_TIMEOUT_MS = 5_000;
const WATCHDOG_INTERVAL_MS = 2_000;
const IDLE_CHECK_INTERVAL_MS = 30_000;
/** How long shutdown waits for killed shells to exit. */
const SHUTDOWN_GRACE_MS = 2_000;
/** Exit after this long with no sessions and no connected servers. */
const IDLE_EXIT_MS = 5 * 60_000;
/**
 * A server that stops reading its stream connection (hung, or stopped in a
 * debugger) would otherwise make the daemon buffer output without bound.
 */
const MAX_STREAM_BACKLOG_BYTES = 64 * 1024 * 1024;

interface Client {
  id: string;
  control: Socket | null;
  stream: Socket | null;
  /** terminalId -> pool unsubscribe, one per terminal this client attached. */
  attached: Map<string, () => void>;
}

export interface DaemonOptions {
  paths: DaemonPaths;
  buildId: string;
  /** Called once the endpoint is published and the token and pid files are written. */
  onReady: () => void;
}

/**
 * The terminal daemon: a {@link TerminalPool} behind a Unix socket, so PTYs
 * outlive the web server. Knows nothing about workspaces, layouts or events;
 * `workspaceId` is opaque metadata used only for `list` / `killWorkspace`.
 *
 * Resolves with an exit code when the daemon could not take the endpoint.
 * Otherwise it serves until SIGTERM, idle exit, or losing the endpoint, and
 * calls `process.exit` itself.
 */
export async function runDaemon(options: DaemonOptions): Promise<number> {
  const { paths, buildId } = options;
  ensurePrivateDir(paths.runDir);
  ensurePrivateDir(dirname(paths.socket));

  const token = randomBytes(32).toString("hex");
  const pool = new TerminalPool();
  const clients = new Map<string, Client>();
  let shuttingDown = false;

  const server = createServer((socket) => acceptConnection(socket));
  const bindPath = privateBindPath(paths.socket);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(bindPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(bindPath, 0o600);

  const outcome = await publishEndpoint(bindPath, paths.socket);
  if (outcome.status !== "published") {
    log.warn({ outcome: outcome.status }, "terminal daemon could not publish its endpoint");
    // Closing unlinks only our private bind name, never the canonical one.
    await closeServer(server);
    return outcome.status === "occupied" ? EXIT_ENDPOINT_OCCUPIED : EXIT_ENDPOINT_UNAVAILABLE;
  }
  const identity: EndpointIdentity = outcome.identity;

  // Token and pid record are written only once the endpoint is ours, so a
  // daemon that lost the race can never overwrite the winner's.
  writePrivateFile(paths.token, token);
  const pidRecord: PidRecord = {
    pid: process.pid,
    protocol: PROTOCOL_VERSION,
    buildId,
    startedAt: new Date().toISOString(),
  };
  writePrivateFile(paths.pid, JSON.stringify(pidRecord));
  log.info({ pid: process.pid, socket: paths.socket, buildId }, "terminal daemon ready");

  pool.onExit((event) => {
    for (const client of clients.values()) {
      client.attached.delete(event.terminalId);
      send(client, "stream", { t: "exit", ...event } satisfies StreamEvent);
    }
  });

  // Stand down when the endpoint is gone or taken, or the run dir was deleted
  // (e.g. `rm -rf ~/.band`, or a test's temp home). No server can reach these
  // sessions any more, and a daemon must never serve an endpoint it no longer
  // holds, so kill them rather than leave orphaned shells.
  const watchdog = setInterval(() => {
    const ownership = endpointOwnership(paths.socket, identity);
    if (ownership === "lost" || !exists(paths.runDir)) {
      shutdown(`endpoint ${ownership === "lost" ? "lost" : "run dir removed"}`);
    }
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref();

  let idleSince: number | null = null;
  const idleTimer = setInterval(() => {
    if (pool.listAll().length > 0 || clients.size > 0) {
      idleSince = null;
      return;
    }
    idleSince ??= Date.now();
    if (Date.now() - idleSince >= IDLE_EXIT_MS) shutdown("idle");
  }, IDLE_CHECK_INTERVAL_MS);

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  // Detached, so a terminal hangup can't reach us, but be explicit.
  process.on("SIGHUP", () => {});

  options.onReady();
  return new Promise<number>(() => {
    // Serves until `shutdown` exits the process.
  });

  function shutdown(reason: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ reason, sessions: pool.listAll().length }, "terminal daemon shutting down");
    clearInterval(watchdog);
    clearInterval(idleTimer);
    const shells = pool.listAll().map((entry) => entry.pid);
    pool.killAll();
    for (const client of clients.values()) {
      client.control?.destroy();
      client.stream?.destroy();
    }
    // The endpoint is deliberately left in place; the next daemon replaces it.
    // Exit once the shells are gone (bounded), so whoever waits for this
    // process knows its shells have finished writing (history files, etc.).
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    const waitForShells = setInterval(() => {
      if (Date.now() < deadline && shells.some(isAlive)) return;
      clearInterval(waitForShells);
      process.exit(0);
    }, 50);
  }

  function acceptConnection(socket: Socket): void {
    let role: ClientRole | null = null;
    let client: Client | null = null;
    let mismatched = false;
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    socket.on("error", () => {
      // A peer reset surfaces as `close` below; nothing else to do.
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (client && role) dropClient(client);
    });

    readFrames(socket, (frame) => {
      if (!role && !mismatched) {
        clearTimeout(helloTimer);
        const hello = parseHello(frame);
        if (!hello || !tokenMatches(hello.token)) {
          writeFrame(socket, { t: "rejected", reason: "bad hello" } satisfies HelloReply);
          socket.end();
          return;
        }
        if (hello.protocol !== PROTOCOL_VERSION) {
          // A server of another version. The only thing it may do here is ask
          // this daemon to exit (see PROTOCOL_VERSION).
          mismatched = true;
          writeFrame(socket, {
            t: "mismatch",
            protocol: PROTOCOL_VERSION,
            pid: process.pid,
          } satisfies HelloReply);
          return;
        }
        if (hello.buildId !== buildId) {
          log.info({ daemon: buildId, server: hello.buildId }, "server build differs from daemon");
        }
        role = hello.role;
        client = registerClient(hello.clientId, role, socket);
        if (!client) {
          socket.destroy();
          return;
        }
        writeFrame(socket, {
          t: "ready",
          protocol: PROTOCOL_VERSION,
          pid: process.pid,
          buildId,
        } satisfies HelloReply);
        return;
      }
      if (mismatched) {
        if ((frame as { t?: unknown }).t === "shutdown") shutdown("replaced by another version");
        return;
      }
      if (role === "control" && client) handleControl(client, frame);
    });
  }

  function registerClient(clientId: string, role: ClientRole, socket: Socket): Client | null {
    let client = clients.get(clientId);
    if (!client) {
      client = { id: clientId, control: null, stream: null, attached: new Map() };
      clients.set(clientId, client);
    }
    // One socket per role per client; a second one is a confused peer.
    if (client[role]) return null;
    client[role] = socket;
    return client;
  }

  function dropClient(client: Client): void {
    if (clients.get(client.id) !== client) return;
    clients.delete(client.id);
    for (const unsubscribe of client.attached.values()) unsubscribe();
    client.attached.clear();
    client.control?.destroy();
    client.stream?.destroy();
  }

  function send(client: Client, role: ClientRole, message: unknown): void {
    const socket = client[role];
    if (!socket || socket.destroyed) return;
    if (socket.writableLength > MAX_STREAM_BACKLOG_BYTES) {
      log.warn({ clientId: client.id }, "server stopped reading; dropping its connection");
      dropClient(client);
      return;
    }
    writeFrame(socket, message);
  }

  function handleControl(client: Client, frame: unknown): void {
    const message = frame as (ControlRequest | ControlNotify) & { id?: unknown };
    if (typeof message.id !== "number") {
      handleNotify(client, message as ControlNotify);
      return;
    }
    const id = message.id;
    handleRequest(client, message as ControlRequest).then(
      (result) => send(client, "control", { id, ok: true, result } satisfies ControlReply),
      (err: unknown) =>
        send(client, "control", {
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } satisfies ControlReply),
    );
  }

  function handleNotify(client: Client, message: ControlNotify): void {
    switch (message.t) {
      case "resize":
        pool.resize(message.terminalId, message.cols, message.rows);
        return;
      case "nudgeResize":
        pool.nudgeResize(message.terminalId);
        return;
      case "detach": {
        const unsubscribe = client.attached.get(message.terminalId);
        client.attached.delete(message.terminalId);
        unsubscribe?.();
        return;
      }
      case "shutdown":
        // Only a server of another protocol version may ask; see acceptConnection.
        return;
    }
  }

  async function handleRequest(
    client: Client,
    request: ControlRequest,
  ): Promise<DaemonRequests[ControlRequest["t"]][1]> {
    switch (request.t) {
      case "spawn": {
        // Never create a session on an endpoint we no longer hold: no server
        // could ever reach it.
        if (endpointOwnership(paths.socket, identity) === "lost") {
          throw new Error("Terminal daemon no longer owns its endpoint");
        }
        const { workspaceId, terminalId, workspaceRoot, options, cleanupOnExit, baseEnv } = request;
        await pool.spawn(workspaceId, terminalId, workspaceRoot, options, {
          cleanupOnExit,
          baseEnv,
        });
        const entry = pool.info(terminalId);
        if (!entry) throw new Error(`Terminal exited during spawn: ${terminalId}`);
        return entry;
      }
      case "info":
        return pool.info(request.terminalId);
      case "list":
        return request.workspaceId === undefined ? pool.listAll() : pool.list(request.workspaceId);
      case "kill": {
        const entry = pool.info(request.terminalId);
        pool.kill(request.terminalId);
        return entry;
      }
      case "killWorkspace":
        pool.killWorkspace(request.workspaceId);
        return null;
      case "scrollback":
        return pool.getScrollback(request.terminalId, request.lines);
      case "write":
        return pool.write(request.terminalId, request.data);
      case "attach":
        return attach(client, request);
      case "ping":
        return { pid: process.pid, sessions: pool.listAll().length };
    }
  }

  async function attach(
    client: Client,
    request: Extract<ControlRequest, { t: "attach" }>,
  ): Promise<DaemonRequests["attach"][1]> {
    const { terminalId, cols, rows } = request;
    const dims = cols !== undefined && rows !== undefined ? { cols, rows } : undefined;
    const attached = await pool.attach(terminalId, dims, (d, seq) =>
      send(client, "stream", { t: "data", id: terminalId, seq, d } satisfies StreamEvent),
    );
    if (!attached) return null;
    // One subscription per (client, terminal): the server fans a terminal out
    // to all its viewers itself, and drops chunks it has already seen by `seq`.
    if (client.attached.has(terminalId) || clients.get(client.id) !== client) {
      attached.unsubscribe();
    } else {
      client.attached.set(terminalId, attached.unsubscribe);
    }
    return attached.snapshot;
  }

  function tokenMatches(candidate: string): boolean {
    const expected = Buffer.from(token);
    const actual = Buffer.from(candidate);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

function parseHello(frame: unknown): HelloMessage | null {
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

/** Write `path` with mode 0600, atomically, so a reader never sees half a token. */
function writePrivateFile(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    // Only a missing entry counts; EACCES and friends prove nothing.
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: gone. EPERM: the pid now belongs to another user, so ours is gone too.
    return false;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
