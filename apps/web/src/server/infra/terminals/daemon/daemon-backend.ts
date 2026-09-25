import { createLogger } from "@band-app/logger";
import {
  AttachGate,
  type TerminalAttachment,
  type TerminalBackend,
  type TerminalSpawnRequest,
} from "../terminal-backend";
import type { TerminalExitEvent, TerminalListEntry } from "../terminal-pool";
import { DaemonClient, DaemonNotRunningError, DaemonRejectedError } from "./client";
import { launchDaemon, retireOlderDaemons } from "./launch";
import { type ControlNotify, type DaemonPaths, daemonPaths, type StreamEvent } from "./protocol";

const log = createLogger("terminal-daemon-backend");

/** Retries for a daemon that published its socket a moment before its token file. */
const CONNECT_RETRIES = 5;
const CONNECT_RETRY_DELAY_MS = 100;

/**
 * The daemon could not be reached or started. `TerminalService` falls back to
 * in-process terminals when a spawn fails with this.
 */
export class TerminalDaemonUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TerminalDaemonUnavailableError";
  }
}

export interface DaemonBackendOptions {
  /** `dist/terminal-daemon.mjs`, or `terminal-daemon.ts` under tsx in dev. */
  entry: string;
  /** `<bandHome>/run`. */
  runDir: string;
  /** The daemon's working directory (`<bandHome>`). */
  cwd: string;
  /** Identifies the daemon code; a mismatch with a running daemon is only logged. */
  buildId: string;
}

/**
 * PTYs hosted by the terminal daemon, so they survive a web-server restart.
 *
 * Connects lazily. Reads (`info`, `list`, `attach`...) use a daemon that is
 * already running and otherwise report "no such terminal"; only `spawn`
 * launches one. That keeps a daemon from starting for every server that never
 * opens a terminal.
 */
export class DaemonTerminalBackend implements TerminalBackend {
  private readonly paths: DaemonPaths;
  private client: DaemonClient | null = null;
  /** The one in-flight connect, shared so simultaneous callers don't each open a connection. */
  private connecting: Promise<DaemonClient | null> | null = null;
  private closed = false;
  /** terminalId -> local viewers, each cut at its own snapshot. */
  private readonly gates = new Map<string, Set<AttachGate>>();
  /**
   * terminalId -> highest `seq` already fanned out. Two overlapping attaches
   * can briefly leave the daemon with two subscriptions for one terminal, so
   * the same chunk can arrive twice.
   */
  private readonly lastSeq = new Map<string, number>();
  /** terminalId -> workspaceId for every session this server has seen, to report on disconnect. */
  private readonly known = new Map<string, string>();
  private readonly exitListeners = new Set<(event: TerminalExitEvent) => void>();

  constructor(private readonly options: DaemonBackendOptions) {
    this.paths = daemonPaths(options.runDir);
  }

  async spawn(request: TerminalSpawnRequest): Promise<TerminalListEntry> {
    const client = await this.connection(true);
    if (!client) throw new TerminalDaemonUnavailableError("Terminal daemon is shutting down");
    const entry = await client.request("spawn", {
      workspaceId: request.workspaceId,
      terminalId: request.terminalId,
      workspaceRoot: request.workspaceRoot,
      options: request.options,
      cleanupOnExit: request.cleanupOnExit,
      // The server's env, not the daemon's: it carries per-instance values
      // (`BAND_SERVER_URL`, `BAND_PORT`) that must reach the shell.
      baseEnv: stringEnv(process.env),
    });
    this.remember(entry);
    return entry;
  }

  async info(terminalId: string): Promise<TerminalListEntry | null> {
    const client = await this.connection(false);
    if (!client) return null;
    const entry = await client.request("info", { terminalId });
    if (entry) this.remember(entry);
    return entry;
  }

  async list(workspaceId: string): Promise<TerminalListEntry[]> {
    const client = await this.connection(false);
    if (!client) return [];
    const entries = await client.request("list", { workspaceId });
    for (const entry of entries) this.remember(entry);
    return entries;
  }

  async listAll(): Promise<TerminalListEntry[]> {
    const client = await this.connection(false);
    if (!client) return [];
    const entries = await client.request("list", {});
    for (const entry of entries) this.remember(entry);
    return entries;
  }

  async kill(terminalId: string): Promise<TerminalListEntry | null> {
    const client = await this.connection(false);
    if (!client) return null;
    return client.request("kill", { terminalId });
  }

  async killWorkspace(workspaceId: string): Promise<void> {
    const client = await this.connection(false);
    if (!client) return;
    await client.request("killWorkspace", { workspaceId });
  }

  async getScrollback(terminalId: string, lines?: number): Promise<string | null> {
    const client = await this.connection(false);
    if (!client) return null;
    return client.request("scrollback", { terminalId, lines });
  }

  async write(terminalId: string, data: string): Promise<boolean> {
    // With a live connection, send before the first `await` so keystrokes
    // stay ordered with `resize` / `nudgeResize`, which are sent synchronously.
    const client =
      this.client && !this.client.isClosed ? this.client : await this.connection(false);
    if (!client) return false;
    return client.request("write", { terminalId, data });
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.notify({ t: "resize", terminalId, cols, rows });
  }

  nudgeResize(terminalId: string): void {
    this.notify({ t: "nudgeResize", terminalId });
  }

  async attach(
    terminalId: string,
    dims?: { cols: number; rows: number },
  ): Promise<TerminalAttachment | null> {
    const client = await this.connection(false);
    if (!client) return null;
    // Registered before the request: stream chunks can overtake the reply,
    // and the gate holds them until it knows the snapshot's cut.
    const gate: AttachGate = new AttachGate(() => this.removeGate(terminalId, gate));
    let viewers = this.gates.get(terminalId);
    if (!viewers) {
      viewers = new Set();
      this.gates.set(terminalId, viewers);
    }
    viewers.add(gate);
    let snapshot: Awaited<ReturnType<typeof client.request<"attach">>>;
    try {
      snapshot = await client.request("attach", { terminalId, ...dims });
    } catch (err) {
      gate.detach();
      throw err;
    }
    if (!snapshot) {
      gate.detach();
      return null;
    }
    // Remember it so a dropped daemon connection reports this viewer's exit.
    this.known.set(terminalId, snapshot.workspaceId);
    gate.setSnapshot(snapshot.data, snapshot.seq);
    return gate;
  }

  onExit(listener: (event: TerminalExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  /** Disconnect only. The daemon and every shell in it keep running. */
  async close(): Promise<void> {
    this.closed = true;
    this.client?.close();
    this.client = null;
  }

  // -------------------------------------------------------------------------

  /**
   * The live connection, connecting if needed. With `launch`, starts a daemon
   * when none is running and throws {@link TerminalDaemonUnavailableError} if
   * that fails; without it, resolves `null` when none is running.
   */
  private async connection(launch: boolean): Promise<DaemonClient | null> {
    if (this.closed) return null;
    if (this.client && !this.client.isClosed) return this.client;
    // Loop, not `if`: two launching callers can both be parked on a
    // non-launching attempt that resolved null, and only the first may start
    // the next attempt; the second must join it rather than race a launch.
    while (this.connecting) {
      const shared = await this.connecting;
      if (shared || !launch) return shared;
      if (this.client && !this.client.isClosed) return this.client;
    }
    const attempt = this.openConnection(launch);
    this.connecting = attempt;
    try {
      return await attempt;
    } finally {
      if (this.connecting === attempt) this.connecting = null;
    }
  }

  private async openConnection(launch: boolean): Promise<DaemonClient | null> {
    const { buildId } = this.options;
    try {
      return this.adopt(await DaemonClient.connect(this.paths, buildId));
    } catch (err) {
      if (!(err instanceof DaemonNotRunningError)) {
        throw new TerminalDaemonUnavailableError(`Cannot reach the terminal daemon: ${err}`, {
          cause: err,
        });
      }
      if (!launch) return null;
    }
    try {
      await retireOlderDaemons(this.options.runDir, buildId);
      // `occupied` means another server's daemon won the race; either way a
      // daemon now serves the endpoint.
      const outcome = await launchDaemon({ ...this.options, paths: this.paths });
      log.info({ outcome, socket: this.paths.socket }, "terminal daemon launched");
      return this.adopt(await connectWithRetry(this.paths, buildId));
    } catch (err) {
      throw new TerminalDaemonUnavailableError(`Cannot start the terminal daemon: ${err}`, {
        cause: err,
      });
    }
  }

  private adopt(client: DaemonClient): DaemonClient {
    if (client.isClosed) throw new Error("Terminal daemon closed the connection");
    if (this.closed) {
      client.close();
      throw new Error("Terminal backend is closed");
    }
    client.onEvent((event) => this.handleEvent(event));
    client.onDisconnect(() => this.handleDisconnect(client));
    this.client = client;
    return client;
  }

  private handleEvent(event: StreamEvent): void {
    if (event.t === "data") {
      if (event.seq <= (this.lastSeq.get(event.id) ?? 0)) return;
      this.lastSeq.set(event.id, event.seq);
      const viewers = this.gates.get(event.id);
      if (viewers) for (const gate of viewers) gate.push(event.d, event.seq);
      return;
    }
    const { t: _t, ...exit } = event;
    this.forget(exit.terminalId);
    this.emitExit(exit);
  }

  /**
   * The daemon is gone or unreachable, so every session it hosted is dead as
   * far as this server can tell. Report each one exited; browsers then show
   * the pane as finished instead of a socket that silently never answers. The
   * next spawn launches a fresh daemon.
   */
  private handleDisconnect(client: DaemonClient): void {
    if (this.client !== client) return;
    this.client = null;
    log.warn({ sessions: this.known.size }, "lost the terminal daemon connection");
    const lost = [...this.known];
    this.known.clear();
    this.lastSeq.clear();
    const gates = [...this.gates.values()].flatMap((viewers) => [...viewers]);
    this.gates.clear();
    // Release their buffers now. Their detach notify goes nowhere: `client` is null.
    for (const gate of gates) gate.detach();
    for (const [terminalId, workspaceId] of lost) {
      this.emitExit({ terminalId, workspaceId, exitCode: -1, killed: false, cleanupOnExit: false });
    }
  }

  private emitExit(event: TerminalExitEvent): void {
    for (const listener of this.exitListeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn({ err, terminalId: event.terminalId }, "terminal exit listener threw");
      }
    }
  }

  private removeGate(terminalId: string, gate: AttachGate): void {
    const viewers = this.gates.get(terminalId);
    if (!viewers?.delete(gate) || viewers.size > 0) return;
    this.gates.delete(terminalId);
    // Last local viewer gone: stop the daemon streaming this terminal to us.
    this.client?.notify({ t: "detach", terminalId });
  }

  private notify(message: ControlNotify): void {
    if (this.client && !this.client.isClosed) {
      this.client.notify(message);
      return;
    }
    void this.connection(false)
      .then((client) => client?.notify(message))
      .catch(() => {
        // Nothing to resize without a daemon.
      });
  }

  private remember(entry: TerminalListEntry): void {
    this.known.set(entry.terminalId, entry.workspaceId);
  }

  private forget(terminalId: string): void {
    this.known.delete(terminalId);
    this.lastSeq.delete(terminalId);
  }
}

async function connectWithRetry(paths: DaemonPaths, buildId: string): Promise<DaemonClient> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await DaemonClient.connect(paths, buildId);
    } catch (err) {
      const retriable =
        err instanceof DaemonRejectedError &&
        err.reply.t === "rejected" &&
        attempt < CONNECT_RETRIES;
      if (!retriable) throw err;
      await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAY_MS));
    }
  }
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
