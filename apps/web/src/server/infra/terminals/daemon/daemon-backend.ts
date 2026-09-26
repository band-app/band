import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createLogger } from "@band-app/logger";
import {
  AttachGate,
  type TerminalAttachment,
  type TerminalBackend,
  type TerminalSpawnRequest,
} from "../terminal-backend";
import type { TerminalExitEvent, TerminalListEntry } from "../terminal-pool";
import { DaemonClient, DaemonNotRunningError, DaemonRejectedError } from "./client";
import { type EndpointIdentity, entryIdentity } from "./endpoint";
import { launchDaemon, retireOlderDaemons } from "./launch";
import {
  type ControlNotify,
  type DaemonPaths,
  daemonPaths,
  ENDPOINT_LOST_ERROR,
  listRetiredDaemons,
  type PidRecord,
  type StreamEvent,
} from "./protocol";

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
  /** Identifies the daemon code. New sessions only start on a daemon of this build. */
  buildId: string;
}

interface KnownSession {
  workspaceId: string;
  cleanupOnExit: boolean;
  /** The daemon hosting it. */
  client: DaemonClient;
}

/**
 * PTYs hosted by the terminal daemon, so they survive a web-server restart.
 *
 * Connects lazily. Reads (`info`, `list`, `attach`...) use daemons that are
 * already running and otherwise report "no such terminal"; only `spawn`
 * launches one. That keeps a daemon from starting for every server that never
 * opens a terminal.
 *
 * New sessions start only on a daemon of this server's build (issue #652). A
 * daemon from another build runs that build's code, which may not even be on
 * disk any more, so when the endpoint is served by one, the first spawn
 * launches a daemon of this build that supersedes it. The old daemon drains:
 * it keeps its shells, and this server keeps using them over its connection
 * (or, after a restart, over the retired name the new daemon left for it).
 */
export class DaemonTerminalBackend implements TerminalBackend {
  private readonly paths: DaemonPaths;
  /** The daemon of this build, serving the endpoint. Every new session starts here. */
  private current: DaemonClient | null = null;
  /** Daemons of other builds, or draining ones. Used only for sessions they already host. */
  private readonly others = new Set<DaemonClient>();
  /** The other-build daemon found serving the endpoint, with its entry, for `--supersede`. */
  private stale: { client: DaemonClient; identity: EndpointIdentity } | null = null;
  /** Look for daemons again: set at start and whenever one is lost or replaced. */
  private needsDiscovery = true;
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
  /** Every session this server has seen, to route requests and report exits on disconnect. */
  private readonly known = new Map<string, KnownSession>();
  private readonly exitListeners = new Set<(event: TerminalExitEvent) => void>();

  constructor(private readonly options: DaemonBackendOptions) {
    this.paths = daemonPaths(options.runDir);
  }

  async spawn(request: TerminalSpawnRequest): Promise<TerminalListEntry> {
    let client = await this.connection(true);
    if (!client) throw new TerminalDaemonUnavailableError("Terminal daemon is shutting down");
    // Spawn is idempotent per id (#617). The current daemon checks its own
    // sessions, but a live one on an older daemon must be returned, not
    // started a second time here.
    if (this.others.size > 0) {
      const existing = await this.find(request.terminalId);
      if (existing) return existing.entry;
    }
    const params = {
      workspaceId: request.workspaceId,
      terminalId: request.terminalId,
      workspaceRoot: request.workspaceRoot,
      options: request.options,
      cleanupOnExit: request.cleanupOnExit,
      // The server's env, not the daemon's: it carries per-instance values
      // (`BAND_SERVER_URL`, `BAND_PORT`) that must reach the shell.
      baseEnv: stringEnv(process.env),
    };
    let entry: TerminalListEntry;
    try {
      entry = await client.request("spawn", params);
    } catch (err) {
      if (!(err instanceof Error) || err.message !== ENDPOINT_LOST_ERROR) throw err;
      // Another daemon took the endpoint (another server's build superseded
      // ours). Ours drains; start the session wherever the endpoint is now.
      this.demote(client);
      client = await this.connection(true);
      if (!client) throw new TerminalDaemonUnavailableError("Terminal daemon is shutting down");
      entry = await client.request("spawn", params);
    }
    this.remember(entry, client);
    return entry;
  }

  async info(terminalId: string): Promise<TerminalListEntry | null> {
    return (await this.find(terminalId))?.entry ?? null;
  }

  async list(workspaceId: string): Promise<TerminalListEntry[]> {
    return this.collect({ workspaceId });
  }

  async listAll(): Promise<TerminalListEntry[]> {
    return this.collect({});
  }

  async kill(terminalId: string): Promise<TerminalListEntry | null> {
    const found = await this.find(terminalId);
    if (!found) return null;
    return found.client.request("kill", { terminalId });
  }

  async killWorkspace(workspaceId: string): Promise<void> {
    await this.connection(false);
    await this.onEach((client) => client.request("killWorkspace", { workspaceId }), null);
  }

  async getScrollback(terminalId: string, lines?: number): Promise<string | null> {
    const client = await this.owner(terminalId);
    if (!client) return null;
    return client.request("scrollback", { terminalId, lines });
  }

  async write(terminalId: string, data: string): Promise<boolean> {
    // With a live connection, send before the first `await` so keystrokes
    // stay ordered with `resize` / `nudgeResize`, which are sent synchronously.
    const client = this.knownOwner(terminalId) ?? (await this.owner(terminalId));
    if (!client) return false;
    return client.request("write", { terminalId, data });
  }

  input(terminalId: string, data: string): void {
    this.notify(terminalId, { t: "input", terminalId, data });
  }

  resize(terminalId: string, cols: number, rows: number): void {
    this.notify(terminalId, { t: "resize", terminalId, cols, rows });
  }

  nudgeResize(terminalId: string): void {
    this.notify(terminalId, { t: "nudgeResize", terminalId });
  }

  async attach(
    terminalId: string,
    dims?: { cols: number; rows: number },
  ): Promise<TerminalAttachment | null> {
    const client = await this.owner(terminalId);
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
    this.known.set(terminalId, {
      workspaceId: snapshot.workspaceId,
      cleanupOnExit: snapshot.cleanupOnExit,
      client,
    });
    gate.setSnapshot(snapshot.data, snapshot.seq);
    return gate;
  }

  onExit(listener: (event: TerminalExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  /** Disconnect only. The daemons and every shell in them keep running. */
  async close(): Promise<void> {
    this.closed = true;
    for (const client of this.clients()) client.close();
    this.current = null;
    this.others.clear();
    this.stale = null;
  }

  // -------------------------------------------------------------------------

  /** Every live connection, the current daemon first. */
  private clients(): DaemonClient[] {
    const all = this.current ? [this.current, ...this.others] : [...this.others];
    return all.filter((client) => !client.isClosed);
  }

  /** The daemon a known session lives on, if its connection is still up. */
  private knownOwner(terminalId: string): DaemonClient | null {
    const client = this.known.get(terminalId)?.client;
    return client && !client.isClosed ? client : null;
  }

  private async owner(terminalId: string): Promise<DaemonClient | null> {
    return this.knownOwner(terminalId) ?? (await this.find(terminalId))?.client ?? null;
  }

  /** The live session `terminalId` and the daemon hosting it. */
  private async find(
    terminalId: string,
  ): Promise<{ client: DaemonClient; entry: TerminalListEntry } | null> {
    await this.connection(false);
    const known = this.knownOwner(terminalId);
    for (const client of known ? [known] : this.clients()) {
      const [entry] = await this.onEach((target) => target.request("info", { terminalId }), null, [
        client,
      ]);
      if (entry) {
        this.remember(entry, client);
        return { client, entry };
      }
    }
    return null;
  }

  private async collect(params: { workspaceId?: string }): Promise<TerminalListEntry[]> {
    await this.connection(false);
    const results = await this.onEach(async (client) => {
      const entries = await client.request("list", params);
      for (const entry of entries) this.remember(entry, client);
      return entries;
    }, []);
    return results.flat();
  }

  /**
   * Run `request` on each daemon in `targets` (all by default). Only the
   * current daemon's failure fails the call: an older one that errors (it is
   * exiting, say) counts as `fallback`.
   */
  private async onEach<T>(
    request: (client: DaemonClient) => Promise<T>,
    fallback: T,
    targets = this.clients(),
  ): Promise<T[]> {
    return Promise.all(
      targets.map(async (client) => {
        try {
          return await request(client);
        } catch (err) {
          if (client === this.current) throw err;
          log.warn({ err, pid: client.pid }, "an older terminal daemon failed a request");
          return fallback;
        }
      }),
    );
  }

  /**
   * The current daemon's connection, discovering daemons first if needed.
   * With `launch`, starts a daemon of this build when none serves the
   * endpoint and throws {@link TerminalDaemonUnavailableError} if that fails;
   * without it, resolves `null` when there is no current daemon (older ones
   * may still be connected).
   */
  private async connection(launch: boolean): Promise<DaemonClient | null> {
    if (this.closed) return null;
    const current = this.current && !this.current.isClosed ? this.current : null;
    if (current || (!launch && !this.needsDiscovery && this.clients().length > 0)) {
      return current;
    }
    // Loop, not `if`: two launching callers can both be parked on a
    // non-launching attempt that resolved null, and only the first may start
    // the next attempt; the second must join it rather than race a launch.
    while (this.connecting) {
      const shared = await this.connecting;
      if (shared || !launch) return shared;
      if (this.current && !this.current.isClosed) return this.current;
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
    if (this.needsDiscovery || this.clients().length === 0) await this.discover();
    if (this.current || !launch) return this.current;
    const { buildId } = this.options;
    try {
      await retireOlderDaemons(this.options.runDir, buildId);
      // `occupied` means another server's daemon won the race; either way a
      // daemon now serves the endpoint.
      const outcome = await launchDaemon({
        ...this.options,
        paths: this.paths,
        supersede: this.stale?.identity,
      });
      log.info(
        { outcome, socket: this.paths.socket, superseded: this.stale?.client.pid },
        "terminal daemon launched",
      );
      const client = await connectWithRetry(this.paths, buildId);
      if (this.clients().some((other) => other.pid === client.pid) || !this.isOwnBuild(client)) {
        client.close();
        throw new Error("a terminal daemon of another build still serves the endpoint");
      }
      this.adopt(client);
      this.current = client;
      this.stale = null;
      return client;
    } catch (err) {
      throw new TerminalDaemonUnavailableError(`Cannot start the terminal daemon: ${err}`, {
        cause: err,
      });
    }
  }

  /**
   * Connect to every daemon on this home not connected yet: the one serving
   * the endpoint, and superseded ones still reachable by a retired name.
   */
  private async discover(): Promise<void> {
    const { buildId } = this.options;
    const before = entryIdentity(this.paths.socket, lstatSync);
    let client: DaemonClient | null;
    try {
      client = await DaemonClient.connect(this.paths, buildId);
    } catch (err) {
      if (!(err instanceof DaemonNotRunningError)) {
        throw new TerminalDaemonUnavailableError(`Cannot reach the terminal daemon: ${err}`, {
          cause: err,
        });
      }
      client = null;
    }
    if (client) {
      // Same entry before and after the hello: the entry is this daemon's.
      const after = entryIdentity(this.paths.socket, lstatSync);
      const identity =
        before && after && before.dev === after.dev && before.ino === after.ino ? before : null;
      const existing = this.clients().find((other) => other.pid === client?.pid);
      if (existing) client.close();
      const serving = existing ?? this.adopt(client);
      if (serving !== this.current) {
        if (!existing && this.isOwnBuild(serving)) {
          // Ours now serves the endpoint (e.g. another server of this build
          // launched it after ours was superseded).
          if (this.current) this.demote(this.current);
          this.current = serving;
        } else {
          this.others.add(serving);
          this.stale = identity ? { client: serving, identity } : null;
          if (!existing) {
            log.info(
              { pid: serving.pid, daemon: serving.buildId, server: buildId },
              "terminal daemon is from another build; new terminals will start on one of this build",
            );
          }
        }
      }
    }
    for (const retired of listRetiredDaemons(this.paths)) {
      const pid = readPidRecord(retired.pid)?.pid;
      if (pid !== undefined && this.clients().some((other) => other.pid === pid)) continue;
      let old: DaemonClient;
      try {
        old = await DaemonClient.connect(retired, buildId);
      } catch {
        // Gone or not ready. The daemon that retired it removes its names.
        continue;
      }
      if (this.clients().some((other) => other.pid === old.pid)) old.close();
      else this.others.add(this.adopt(old));
    }
    this.needsDiscovery = false;
  }

  /**
   * Whether new sessions may start on `client`: it runs this build, and its
   * entry file still exists. A daemon whose code was deleted (a removed
   * worktree, a replaced app bundle) fails to load any module it hasn't
   * loaded yet, such as node-pty on its first spawn.
   */
  private isOwnBuild(client: DaemonClient): boolean {
    if (client.buildId !== this.options.buildId) return false;
    const record = readPidRecord(this.paths.pid);
    if (record?.pid !== client.pid || record.entry === undefined) return true;
    return existsSync(record.entry);
  }

  /** Stop starting sessions on `client`; keep using it for the ones it has. */
  private demote(client: DaemonClient): void {
    if (this.current === client) this.current = null;
    if (!client.isClosed) this.others.add(client);
    this.needsDiscovery = true;
  }

  private adopt(client: DaemonClient): DaemonClient {
    if (client.isClosed) throw new Error("Terminal daemon closed the connection");
    if (this.closed) {
      client.close();
      throw new Error("Terminal backend is closed");
    }
    client.onEvent((event) => this.handleEvent(event));
    client.onDisconnect(() => this.handleDisconnect(client));
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
   * A daemon is gone or unreachable, so every session it hosted is dead as
   * far as this server can tell. Report each one exited; browsers then show
   * the pane as finished instead of a socket that silently never answers. The
   * next spawn launches a fresh daemon if the current one was lost.
   */
  private handleDisconnect(client: DaemonClient): void {
    if (this.current === client) this.current = null;
    else if (!this.others.delete(client)) return;
    if (this.stale?.client === client) this.stale = null;
    this.needsDiscovery = true;
    const lost = [...this.known].filter(([, session]) => session.client === client);
    log.warn({ pid: client.pid, sessions: lost.length }, "lost a terminal daemon connection");
    for (const [terminalId] of lost) {
      this.forget(terminalId);
      const viewers = this.gates.get(terminalId);
      this.gates.delete(terminalId);
      // Release their buffers now. Their detach notify goes nowhere: the session is forgotten.
      for (const gate of viewers ?? []) gate.detach();
    }
    // Each session's own `cleanupOnExit`, so a self-closing pane (a cron run)
    // whose daemon died is pruned like any other exit of that pane.
    for (const [terminalId, { workspaceId, cleanupOnExit }] of lost) {
      this.emitExit({ terminalId, workspaceId, exitCode: -1, killed: false, cleanupOnExit });
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
    this.knownOwner(terminalId)?.notify({ t: "detach", terminalId });
  }

  private notify(terminalId: string, message: ControlNotify): void {
    const client = this.knownOwner(terminalId);
    if (client) {
      client.notify(message);
      return;
    }
    void this.owner(terminalId)
      .then((owner) => owner?.notify(message))
      .catch(() => {
        // Nothing to resize without a daemon.
      });
  }

  private remember(entry: TerminalListEntry, client: DaemonClient): void {
    this.known.set(entry.terminalId, {
      workspaceId: entry.workspaceId,
      cleanupOnExit: entry.cleanupOnExit,
      client,
    });
  }

  private forget(terminalId: string): void {
    this.known.delete(terminalId);
    this.lastSeq.delete(terminalId);
  }
}

function readPidRecord(path: string): PidRecord | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PidRecord;
  } catch {
    return null;
  }
}

async function connectWithRetry(paths: DaemonPaths, buildId: string): Promise<DaemonClient> {
  // A `rejected` hello right after launch is expected: the daemon publishes
  // its socket a moment before it writes the token file, so a client can
  // read the previous daemon's (or no) token. Retry only that.
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
