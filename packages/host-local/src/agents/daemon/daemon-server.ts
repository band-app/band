import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { createLogger } from "@band-app/logger";
import {
  type EndpointIdentity,
  endpointOwnership,
  ensurePrivateDir,
  isProvenDead,
  privateBindPath,
  probeEndpoint,
  publishEndpoint,
} from "../../daemon-kit/endpoint";
import {
  copyPrivateFile,
  removeRetiredFiles,
  tokenMatches,
  writePrivateFile,
} from "../../daemon-kit/private-files";
import {
  type ClientRole,
  type DaemonPaths,
  EXIT_ENDPOINT_OCCUPIED,
  EXIT_ENDPOINT_UNAVAILABLE,
  type HelloReply,
  type PidRecord,
  parseHello,
  readFrames,
  retiredDaemonPaths,
  writeFrame,
} from "../../daemon-kit/protocol";
import { OutputRing } from "./output-ring";
import {
  type AgentRecord,
  type AgentStreamName,
  type ControlReply,
  type ControlRequest,
  type DaemonRequests,
  ENDPOINT_LOST_ERROR,
  PROTOCOL_VERSION,
  type StreamEvent,
} from "./protocol";

const log = createLogger("agent-daemon");

const HELLO_TIMEOUT_MS = 5_000;
const WATCHDOG_INTERVAL_MS = 2_000;
const SHUTDOWN_GRACE_MS = 2_000;
/** How long a freshly launched daemon waits for its first worker. */
const INITIAL_ADOPTION_MS = 2 * 60_000;
/** A worker that stops reading its stream (hung, stopped in a debugger) is dropped at this backlog. */
const MAX_STREAM_BACKLOG_BYTES = 64 * 1024 * 1024;
const DEFAULT_BUFFER_BYTES = 8 * 1024 * 1024;
const DEFAULT_EXIT_KEEP_MS = 10 * 60_000;
/** How long an exit waits for the agent's last output to be read. */
const EXIT_FLUSH_MS = 200;

/** Per agent and stream, above which the daemon stops reading the agent. Read on every chunk. */
function bufferCap(): number {
  const value = Number(process.env.BAND_AGENT_BUFFER_BYTES);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_BUFFER_BYTES;
}

/** How long an exited agent nobody attached to is kept for the hub to find. Read when the agent exits. */
function exitKeepMs(): number {
  const value = Number(process.env.BAND_AGENT_EXIT_KEEP_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_EXIT_KEEP_MS;
}

interface Client {
  id: string;
  control: Socket | null;
  stream: Socket | null;
  /** agentId -> true for the agents streaming to this client. */
  attached: Set<string>;
}

interface Held {
  record: AgentRecord;
  child: ChildProcess;
  rings: Record<AgentStreamName, OutputRing>;
  paused: Record<AgentStreamName, boolean>;
  subscribers: Set<Client>;
  keepTimer: NodeJS.Timeout | null;
}

export interface DaemonOptions {
  paths: DaemonPaths;
  buildId: string;
  /** This daemon's entry file, recorded so a worker can tell when it has been deleted. */
  entry: string;
  /** The canonical entry of a live daemon of another build to take the endpoint from. It drains. */
  supersede?: EndpointIdentity;
  /** Called once the endpoint is published and the token and pid files are written. */
  onReady: () => void;
}

/**
 * The agent daemon: ACP agent processes behind a Unix socket, so they outlive the worker. It
 * knows nothing about chats or worktrees. It keeps each agent's output from the last offset the
 * worker acknowledged and stops reading an agent that leaves more than the cap unread.
 *
 * Resolves with an exit code when it could not take the endpoint. Otherwise it serves until
 * SIGTERM (kill every agent and exit), idleness (no agents, no connection), a lost endpoint
 * (drain: take no new agents, exit when the last one ends) or a removed run dir (kill and exit).
 */
export async function runDaemon(options: DaemonOptions): Promise<number> {
  const { paths, buildId, supersede } = options;
  ensurePrivateDir(paths.runDir);
  ensurePrivateDir(dirname(paths.socket));

  const token = randomBytes(32).toString("hex");
  const held = new Map<string, Held>();
  const clients = new Map<string, Client>();
  let shuttingDown = false;
  let openConnections = 0;
  let spawning = 0;
  let endpointLost = false;
  let retirementRequested = false;
  /** Wall-clock end of the worker's lease, or null before the first renewal (an older hub). */
  let leaseExpiresAt: number | null = null;

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

  let retired = supersede ? retiredDaemonPaths(paths, randomBytes(4).toString("hex")) : null;
  if (retired) {
    copyPrivateFile(paths.token, retired.token);
    copyPrivateFile(paths.pid, retired.pid);
  }
  const outcome = await publishEndpoint(
    bindPath,
    paths.socket,
    supersede && retired ? { incumbent: supersede, retiredPath: retired.socket } : undefined,
  );
  if (retired && (outcome.status !== "published" || !outcome.superseded)) {
    removeRetiredFiles(retired);
    retired = null;
  }
  if (outcome.status !== "published") {
    log.warn({ outcome: outcome.status }, "agent daemon could not publish its endpoint");
    await closeServer(server);
    return outcome.status === "occupied" ? EXIT_ENDPOINT_OCCUPIED : EXIT_ENDPOINT_UNAVAILABLE;
  }
  const identity: EndpointIdentity = outcome.identity;

  writePrivateFile(paths.token, token);
  const pidRecord: PidRecord = {
    pid: process.pid,
    protocol: PROTOCOL_VERSION,
    buildId,
    startedAt: new Date().toISOString(),
    socket: paths.socket,
    entry: options.entry,
  };
  writePrivateFile(paths.pid, JSON.stringify(pidRecord));
  log.info({ pid: process.pid, socket: paths.socket, buildId }, "agent daemon ready");

  let probingRetired = false;
  const watchdog = setInterval(() => {
    if (!existsSync(paths.runDir)) {
      shutdown("run dir removed");
      return;
    }
    if (leaseExpiresAt !== null && Date.now() > leaseExpiresAt) {
      leaseExpiresAt = null;
      killAllAgents("the worker's lease ran out");
    }
    if (!endpointLost && endpointOwnership(paths.socket, identity) === "lost") {
      endpointLost = true;
      log.warn({ agents: held.size }, "agent daemon lost its endpoint; draining");
      reevaluateIdle();
    }
    if (retired && !probingRetired) {
      const target = retired;
      probingRetired = true;
      void probeEndpoint(target.socket).then((probe) => {
        probingRetired = false;
        if (!isProvenDead(probe) || retired !== target) return;
        removeRetiredFiles(target);
        retired = null;
        reevaluateIdle();
      });
    }
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref();

  let adoptionTimer: NodeJS.Timeout | null = setTimeout(() => {
    adoptionTimer = null;
    retirementRequested = true;
    reevaluateIdle();
  }, INITIAL_ADOPTION_MS);

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGHUP", () => {});

  options.onReady();
  return new Promise<number>(() => {
    // Serves until `shutdown` exits the process.
  });

  function isIdle(): boolean {
    if (spawning > 0 || held.size > 0) return false;
    if (retired) return false;
    if (endpointLost) return true;
    return openConnections === 0 && clients.size === 0;
  }

  function reevaluateIdle(): void {
    if (shuttingDown || !isIdle()) return;
    if (endpointLost) shutdown("endpoint lost; drained");
    else if (retirementRequested) shutdown("idle");
  }

  function shutdown(reason: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    if (retired) {
      log.warn({ retired: retired.socket }, "exiting while a superseded daemon is still running");
    }
    log.info({ reason, agents: held.size }, "agent daemon shutting down");
    clearInterval(watchdog);
    if (adoptionTimer) clearTimeout(adoptionTimer);
    const pids: number[] = [];
    for (const agent of held.values()) {
      if (agent.record.exit === null && agent.record.pid) {
        pids.push(agent.record.pid);
        signalGroup(agent.child, "SIGTERM");
      }
    }
    for (const client of clients.values()) {
      client.control?.destroy();
      client.stream?.destroy();
    }
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    const wait = setInterval(() => {
      if (Date.now() < deadline && pids.some(groupAlive)) return;
      for (const pid of pids) if (groupAlive(pid)) killGroup(pid, "SIGKILL");
      clearInterval(wait);
      process.exit(0);
    }, 50);
  }

  /** Stops every running agent, with the same escalation as a `kill` request. */
  function killAllAgents(reason: string): void {
    const running = [...held.values()].filter((agent) => !agent.record.exit);
    if (running.length === 0) return;
    log.warn({ agents: running.length, reason }, "killing the held agents");
    for (const agent of running) {
      signalGroup(agent.child, "SIGTERM");
      const pid = agent.record.pid;
      if (pid) {
        setTimeout(() => {
          if (groupAlive(pid)) killGroup(pid, "SIGKILL");
        }, SHUTDOWN_GRACE_MS).unref();
      }
    }
  }

  function acceptConnection(socket: Socket): void {
    let role: ClientRole | null = null;
    let client: Client | null = null;
    let mismatched = false;
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    openConnections += 1;
    socket.on("error", () => {
      // A reset surfaces as `close`.
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      openConnections -= 1;
      if (client && role) dropClient(client);
      reevaluateIdle();
    });
    readFrames(socket, (frame) => {
      if (!role && !mismatched) {
        clearTimeout(helloTimer);
        const hello = parseHello(frame);
        if (!hello || !tokenMatches(token, hello.token)) {
          writeFrame(socket, { t: "rejected", reason: "bad hello" } satisfies HelloReply);
          socket.end();
          return;
        }
        if (hello.protocol !== PROTOCOL_VERSION) {
          mismatched = true;
          writeFrame(socket, {
            t: "mismatch",
            protocol: PROTOCOL_VERSION,
            pid: process.pid,
          } satisfies HelloReply);
          return;
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
      // A mismatched peer is never told to stop us: that would kill the agents.
      if (mismatched) return;
      if (role === "control" && client) void handleControl(client, frame as ControlRequest);
    });
  }

  function registerClient(clientId: string, role: ClientRole, socket: Socket): Client | null {
    let client = clients.get(clientId);
    if (!client) {
      client = { id: clientId, control: null, stream: null, attached: new Set() };
      clients.set(clientId, client);
    }
    if (client[role]) return null;
    client[role] = socket;
    retirementRequested = false;
    if (adoptionTimer) {
      clearTimeout(adoptionTimer);
      adoptionTimer = null;
    }
    return client;
  }

  function dropClient(client: Client): void {
    if (clients.get(client.id) !== client) return;
    clients.delete(client.id);
    for (const agentId of client.attached) held.get(agentId)?.subscribers.delete(client);
    client.attached.clear();
    client.control?.destroy();
    client.stream?.destroy();
    if (clients.size === 0) retirementRequested = true;
    reevaluateIdle();
  }

  function send(client: Client, role: ClientRole, message: unknown): void {
    const socket = client[role];
    if (!socket || socket.destroyed) return;
    if (socket.writableLength > MAX_STREAM_BACKLOG_BYTES) {
      log.warn({ clientId: client.id }, "worker stopped reading; dropping its connection");
      dropClient(client);
      return;
    }
    writeFrame(socket, message);
  }

  function emit(agent: Held, event: StreamEvent): void {
    for (const client of agent.subscribers) send(client, "stream", event);
  }

  async function handleControl(client: Client, request: ControlRequest): Promise<void> {
    if ((request as { t?: unknown }).t === "shutdown") return;
    let reply: ControlReply;
    try {
      const result = await handle(client, request);
      reply = { id: request.id, ok: true, result };
    } catch (err) {
      reply = {
        id: request.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    send(client, "control", reply);
  }

  async function handle(client: Client, request: ControlRequest): Promise<unknown> {
    switch (request.t) {
      case "spawn":
        return spawnAgent(request);
      case "attach":
        return attach(client, request);
      case "ack":
        return ack(request);
      case "write": {
        const agent = held.get(request.agentId);
        if (!agent || agent.record.exit || !agent.child.stdin?.writable) return false;
        const bytes = Buffer.from(request.data, "base64");
        agent.record.stdinWritten += bytes.length;
        if (bytes.length > 0) agent.child.stdin.write(bytes);
        if (request.end) agent.child.stdin.end();
        return true;
      }
      case "kill": {
        const agent = held.get(request.agentId);
        if (!agent || agent.record.exit) return false;
        const signal = (request.signal as NodeJS.Signals | undefined) ?? "SIGTERM";
        signalGroup(agent.child, signal);
        const pid = agent.record.pid;
        if (signal !== "SIGKILL" && pid) {
          // An adapter that ignores SIGTERM must not outlive a fence or a revoked credential.
          setTimeout(() => {
            if (groupAlive(pid)) killGroup(pid, "SIGKILL");
          }, SHUTDOWN_GRACE_MS).unref();
        }
        return true;
      }
      case "lease":
        leaseExpiresAt = Date.now() + request.ttlMs;
        return true;
      case "list":
        return [...held.values()].map((agent) => ({ ...agent.record }));
      case "forget":
        return forget(request.agentId);
      case "ping":
        return { pid: process.pid, agents: held.size };
    }
  }

  async function spawnAgent(
    params: DaemonRequests["spawn"][0],
  ): Promise<DaemonRequests["spawn"][1]> {
    if (endpointLost || shuttingDown) throw new Error(ENDPOINT_LOST_ERROR);
    spawning += 1;
    try {
      const child = spawn(params.command, params.args, {
        cwd: params.cwd,
        env: params.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.stdin?.on("error", () => undefined);
      const agent: Held = {
        record: {
          agentId: randomUUID(),
          pid: child.pid ?? null,
          cwd: params.cwd,
          startedAt: Date.now(),
          specHash: params.specHash,
          adapterVersion: params.adapterVersion,
          ghToken: params.ghToken,
          stdinWritten: 0,
          exit: null,
        },
        child,
        rings: { stdout: new OutputRing(), stderr: new OutputRing() },
        paused: { stdout: false, stderr: false },
        subscribers: new Set(),
        keepTimer: null,
      };
      held.set(agent.record.agentId, agent);
      for (const name of ["stdout", "stderr"] as const) {
        child[name]?.on("data", (chunk: Buffer) => onOutput(agent, name, chunk));
      }
      child.once("exit", (code, signal) => onExit(agent, code, signal));
      return { ...agent.record };
    } finally {
      spawning -= 1;
    }
  }

  function onOutput(agent: Held, name: AgentStreamName, chunk: Buffer): void {
    const ring = agent.rings[name];
    const off = ring.push(chunk);
    emit(agent, {
      t: "out",
      id: agent.record.agentId,
      stream: name,
      off,
      d: chunk.toString("base64"),
    });
    // Past the cap the agent is not read, so it blocks on a full pipe until an ack frees space.
    if (ring.held >= bufferCap() && !agent.paused[name]) {
      agent.paused[name] = true;
      agent.child[name]?.pause();
      log.warn(
        { agentId: agent.record.agentId, stream: name, held: ring.held },
        "agent output is above the buffer cap; the agent blocks until the worker acknowledges it",
      );
    }
  }

  function onExit(agent: Held, code: number | null, signal: NodeJS.Signals | null): void {
    // The last output is read before the exit is reported, but a process that kept the pipes open
    // (Codex's app-server) must not hold the exit back.
    const finish = () => {
      if (agent.record.exit) return;
      agent.record.exit = { code, signal };
      emit(agent, { t: "exit", id: agent.record.agentId, code, signal });
      agent.keepTimer = setTimeout(() => forget(agent.record.agentId), exitKeepMs());
      agent.keepTimer.unref();
    };
    // A paused stream cannot flush; the exit is reported and the output stays for an attach.
    const timer = setTimeout(finish, EXIT_FLUSH_MS);
    let open = 2;
    for (const name of ["stdout", "stderr"] as const) {
      const stream = agent.child[name];
      if (!stream || stream.readableEnded || stream.destroyed) {
        open -= 1;
        continue;
      }
      stream.once("end", () => {
        open -= 1;
        if (open === 0) {
          clearTimeout(timer);
          finish();
        }
      });
    }
    if (open === 0) {
      clearTimeout(timer);
      finish();
    }
  }

  function attach(
    client: Client,
    params: DaemonRequests["attach"][0],
  ): DaemonRequests["attach"][1] {
    const agent = held.get(params.agentId);
    if (!agent) return null;
    // Replay and subscribe in one step: nothing is sent between them, so no byte repeats or is missed.
    for (const name of ["stdout", "stderr"] as const) {
      const from = name === "stdout" ? params.stdout : params.stderr;
      for (const { off, data } of agent.rings[name].from(from)) {
        send(client, "stream", {
          t: "out",
          id: agent.record.agentId,
          stream: name,
          off,
          d: data.toString("base64"),
        } satisfies StreamEvent);
      }
    }
    agent.subscribers.add(client);
    client.attached.add(agent.record.agentId);
    if (agent.record.exit) {
      send(client, "stream", {
        t: "exit",
        id: agent.record.agentId,
        ...agent.record.exit,
      } satisfies StreamEvent);
    }
    return { ...agent.record };
  }

  function ack(params: DaemonRequests["ack"][0]): DaemonRequests["ack"][1] {
    const agent = held.get(params.agentId);
    if (!agent) return null;
    for (const name of ["stdout", "stderr"] as const) {
      const ring = agent.rings[name];
      ring.ack(name === "stdout" ? params.stdout : params.stderr);
      if (agent.paused[name] && ring.held < bufferCap() / 2) {
        agent.paused[name] = false;
        agent.child[name]?.resume();
      }
    }
    return { stdin: agent.record.stdinWritten };
  }

  function forget(agentId: string): boolean {
    const agent = held.get(agentId);
    if (!agent) return false;
    if (!agent.record.exit) return false;
    if (agent.keepTimer) clearTimeout(agent.keepTimer);
    for (const client of agent.subscribers) client.attached.delete(agentId);
    held.delete(agentId);
    reevaluateIdle();
    return true;
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  killGroup(child.pid, signal, child);
}

function killGroup(pid: number, signal: NodeJS.Signals, child?: ChildProcess): void {
  try {
    process.kill(-pid, signal);
  } catch {
    child?.kill(signal);
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
