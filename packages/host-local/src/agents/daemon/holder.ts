import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createLogger } from "@band-app/logger";
import { type EndpointIdentity, entryIdentity } from "../../daemon-kit/endpoint";
import { launchDaemon } from "../../daemon-kit/launch";
import { type DaemonPaths, listRetiredDaemons, type PidRecord } from "../../daemon-kit/protocol";
import { AgentDaemonClient, DaemonNotRunningError } from "./client";
import {
  type AgentRecord,
  type AgentStreamName,
  agentDaemonPaths,
  ENDPOINT_LOST_ERROR,
  IDENTITY,
  type SpawnParams,
  type StreamEvent,
} from "./protocol";

const log = createLogger("agent-holder");

const CONNECT_RETRIES = 5;
const CONNECT_RETRY_DELAY_MS = 100;
const LAUNCH_ATTEMPTS = 2;

/** The daemon could not be reached or started. The caller spawns the agent itself instead. */
export class AgentDaemonUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentDaemonUnavailableError";
  }
}

export interface AgentHolderOptions {
  /** `dist/agent-daemon.mjs`, or `agent-daemon.ts` under tsx in a checkout. */
  entry: string;
  /** `<state dir>/run/agents`. */
  runDir: string;
  /** The daemon's working directory (the state dir). */
  cwd: string;
  /** Identifies the daemon code. New agents only start on a daemon of this build. */
  buildId: string;
  /** Node flags for the daemon, such as a loader for a `.ts` entry. */
  execArgv?: string[];
}

type OutputListener = (stream: AgentStreamName, off: number, data: Buffer) => void;
type ExitListener = (exit: { code: number | null; signal: string | null }) => void;

interface Listeners {
  output: OutputListener;
  exit: ExitListener;
}

/**
 * The worker's connection to its agent daemon. Connects lazily: only `spawn` launches a daemon,
 * so a worker that never runs a chat agent starts none.
 *
 * New agents start only on a daemon of this build. When the endpoint is served by one of another
 * build, the first spawn launches a daemon of this build that supersedes it; the old daemon keeps
 * its agents until they end, and this holder keeps reaching them over its connection or, after a
 * worker restart, over the retired name the new daemon left.
 */
export class AgentHolder {
  private readonly paths: DaemonPaths;
  private current: AgentDaemonClient | null = null;
  private readonly others = new Set<AgentDaemonClient>();
  private stale: EndpointIdentity | null = null;
  private connecting: Promise<void> | null = null;
  private needsDiscovery = true;
  /** agentId -> the daemon that holds it. */
  private readonly owners = new Map<string, AgentDaemonClient>();
  private readonly listeners = new Map<string, Listeners>();
  private closed = false;

  constructor(private readonly options: AgentHolderOptions) {
    this.paths = agentDaemonPaths(options.runDir);
  }

  async spawn(params: SpawnParams): Promise<AgentRecord> {
    let client = await this.ensureCurrent();
    let record: AgentRecord;
    try {
      record = await client.request("spawn", params);
    } catch (err) {
      if (!(err instanceof Error) || err.message !== ENDPOINT_LOST_ERROR) throw err;
      // Another build took the endpoint while we were connected. Start where it is now.
      this.demote(client);
      client = await this.ensureCurrent();
      record = await client.request("spawn", params);
    }
    this.owners.set(record.agentId, client);
    return record;
  }

  /** Every agent held by any daemon of this worker. Starts no daemon. */
  async list(): Promise<AgentRecord[]> {
    await this.discover();
    const out: AgentRecord[] = [];
    for (const client of this.clients()) {
      try {
        for (const record of await client.request("list", {})) {
          this.owners.set(record.agentId, client);
          out.push(record);
        }
      } catch (err) {
        log.warn({ err, pid: client.pid }, "could not list an agent daemon's agents");
      }
    }
    return out;
  }

  /**
   * Replays the agent's output from these offsets, then streams it live. `output` gets each chunk
   * with its offset, and `exit` fires once, also when the agent had already exited. Resolves with
   * the agent's record, or null when no daemon holds it.
   */
  async attach(
    agentId: string,
    offsets: { stdout: number; stderr: number },
    listeners: Listeners,
  ): Promise<AgentRecord | null> {
    const client = await this.ownerOf(agentId);
    if (!client) return null;
    // Registered before the request: the replay can arrive ahead of the reply.
    this.listeners.set(agentId, listeners);
    try {
      const record = await client.request("attach", { agentId, ...offsets });
      if (!record) this.listeners.delete(agentId);
      return record;
    } catch (err) {
      this.listeners.delete(agentId);
      throw err;
    }
  }

  /** Stops streaming to the current listeners. The agent keeps running. */
  detach(agentId: string): void {
    this.listeners.delete(agentId);
  }

  async ack(agentId: string, offsets: { stdout: number; stderr: number }) {
    const client = await this.ownerOf(agentId);
    return client ? client.request("ack", { agentId, ...offsets }) : null;
  }

  async write(agentId: string, data: Uint8Array, end = false): Promise<boolean> {
    const client = await this.ownerOf(agentId);
    if (!client) return false;
    return client.request("write", { agentId, data: Buffer.from(data).toString("base64"), end });
  }

  async kill(agentId: string, signal?: string): Promise<boolean> {
    const client = await this.ownerOf(agentId);
    return client ? client.request("kill", { agentId, signal }) : false;
  }

  async forget(agentId: string): Promise<void> {
    const client = this.owners.get(agentId);
    this.owners.delete(agentId);
    this.listeners.delete(agentId);
    await client?.request("forget", { agentId }).catch(() => undefined);
  }

  /** Disconnect only. The daemons and every agent keep running. */
  close(): void {
    this.closed = true;
    for (const client of this.clients()) client.close();
    this.current = null;
    this.others.clear();
  }

  // -------------------------------------------------------------------------

  private clients(): AgentDaemonClient[] {
    const all = this.current ? [this.current, ...this.others] : [...this.others];
    return all.filter((client) => !client.isClosed);
  }

  private async ownerOf(agentId: string): Promise<AgentDaemonClient | null> {
    const known = this.owners.get(agentId);
    if (known && !known.isClosed) return known;
    this.owners.delete(agentId);
    await this.discover();
    for (const client of this.clients()) {
      const records = await client.request("list", {}).catch(() => [] as AgentRecord[]);
      if (records.some((record) => record.agentId === agentId)) {
        this.owners.set(agentId, client);
        return client;
      }
    }
    return null;
  }

  private adopt(client: AgentDaemonClient): AgentDaemonClient {
    client.onEvent((event) => this.dispatch(event));
    client.onDisconnect(() => this.handleDisconnect(client));
    return client;
  }

  private dispatch(event: StreamEvent): void {
    const target = this.listeners.get(event.id);
    if (!target) return;
    if (event.t === "out") target.output(event.stream, event.off, Buffer.from(event.d, "base64"));
    else target.exit({ code: event.code, signal: event.signal });
  }

  /** The daemon went away: what it held is gone, so its listeners hear an exit. */
  private handleDisconnect(client: AgentDaemonClient): void {
    if (this.current === client) this.current = null;
    this.others.delete(client);
    this.needsDiscovery = true;
    for (const [agentId, owner] of [...this.owners]) {
      if (owner !== client) continue;
      this.owners.delete(agentId);
      const target = this.listeners.get(agentId);
      this.listeners.delete(agentId);
      target?.exit({ code: null, signal: "daemon-lost" });
    }
  }

  private demote(client: AgentDaemonClient): void {
    if (this.current === client) this.current = null;
    this.others.add(client);
    this.needsDiscovery = true;
  }

  private isOwnBuild(client: AgentDaemonClient): boolean {
    if (client.buildId !== this.options.buildId) return false;
    const record = readPidRecord(this.paths.pid);
    if (record?.pid !== client.pid || record.entry === undefined) return true;
    return existsSync(record.entry);
  }

  private async ensureCurrent(): Promise<AgentDaemonClient> {
    if (this.closed) throw new AgentDaemonUnavailableError("Agent holder is closed");
    for (;;) {
      if (this.current && !this.current.isClosed) return this.current;
      if (!this.connecting) {
        const attempt = this.launchCurrent().finally(() => {
          if (this.connecting === attempt) this.connecting = null;
        });
        this.connecting = attempt;
      }
      await this.connecting;
    }
  }

  private async launchCurrent(): Promise<void> {
    await this.discover();
    if (this.current && !this.current.isClosed) return;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt++) {
      try {
        const outcome = await launchDaemon({
          entry: this.options.entry,
          paths: this.paths,
          cwd: this.options.cwd,
          buildId: this.options.buildId,
          supersede: this.stale ?? undefined,
          execArgv: this.options.execArgv,
          label: IDENTITY.label,
        });
        log.info({ outcome, socket: this.paths.socket }, "agent daemon launched");
        const client = await this.connectWithRetry(this.paths);
        if (this.clients().some((other) => other.pid === client.pid) || !this.isOwnBuild(client)) {
          client.close();
          throw new Error("an agent daemon of another build still serves the endpoint");
        }
        this.current = this.adopt(client);
        this.stale = null;
        return;
      } catch (err) {
        lastErr = err;
        log.warn({ err, attempt }, "agent daemon launch attempt failed");
      }
    }
    this.needsDiscovery = true;
    throw new AgentDaemonUnavailableError(`Cannot start the agent daemon: ${lastErr}`, {
      cause: lastErr,
    });
  }

  private async connectWithRetry(paths: DaemonPaths): Promise<AgentDaemonClient> {
    let lastErr: unknown;
    for (let i = 0; i < CONNECT_RETRIES; i++) {
      try {
        return await AgentDaemonClient.connect(paths, this.options.buildId);
      } catch (err) {
        lastErr = err;
        await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAY_MS));
      }
    }
    throw lastErr;
  }

  /** Connects to the daemon serving the endpoint and to superseded ones left under retired names. */
  private async discover(): Promise<void> {
    if (!this.needsDiscovery && this.clients().length > 0) return;
    const before = entryIdentity(this.paths.socket, lstatSync);
    let client: AgentDaemonClient | null = null;
    try {
      client = await AgentDaemonClient.connect(this.paths, this.options.buildId);
    } catch (err) {
      if (!(err instanceof DaemonNotRunningError)) {
        throw new AgentDaemonUnavailableError(`Cannot reach the agent daemon: ${err}`, {
          cause: err,
        });
      }
    }
    if (client) {
      const after = entryIdentity(this.paths.socket, lstatSync);
      const identity =
        before && after && before.dev === after.dev && before.ino === after.ino ? before : null;
      const existing = this.clients().find((other) => other.pid === client?.pid);
      if (existing) client.close();
      const serving = existing ?? this.adopt(client);
      if (this.isOwnBuild(serving)) {
        this.others.delete(serving);
        this.current = serving;
      } else {
        this.others.add(serving);
        this.stale = identity;
      }
    }
    for (const retired of listRetiredDaemons(this.paths)) {
      const pid = readPidRecord(retired.pid)?.pid;
      if (pid !== undefined && this.clients().some((other) => other.pid === pid)) continue;
      try {
        const old = await AgentDaemonClient.connect(retired, this.options.buildId);
        if (this.clients().some((other) => other.pid === old.pid)) old.close();
        else this.others.add(this.adopt(old));
      } catch {
        // Gone or not ready. The daemon that retired it removes its names.
      }
    }
    this.needsDiscovery = false;
  }
}

function readPidRecord(path: string): PidRecord | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PidRecord;
  } catch {
    return null;
  }
}
