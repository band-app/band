import { createRequire } from "node:module";
import { join } from "node:path";
import type { Host } from "@band-app/host-api";
import { LocalHost } from "@band-app/host-local";
import { stopAllAgentProcesses } from "@band-app/host-local/agents/agent-spawn";
import { InProcessTerminalBackend } from "@band-app/host-local/terminals/in-process-backend";
import { type Channel, LinkClient, type LinkClientOptions, type Ready } from "@band-app/link";
import { createLogger } from "@band-app/logger";
import { ActivityTracker } from "./activity.ts";
import { exchangeBootstrapToken } from "./bootstrap.ts";
import { BOOTSTRAP_TOKEN_PREFIX, ConfigError, linkUrl, type WorkerConfig } from "./config.ts";
import { Registrar, type WorkerContext } from "./context.ts";
import { registerBasicMethods } from "./methods-basic.ts";
import { registerStreamMethods } from "./methods-streams.ts";
import { PathPolicy } from "./path-policy.ts";
import { registerRelayMethods } from "./relay.ts";
import {
  ensureStateDir,
  loadOrCreateWorkerId,
  readSessionToken,
  writeSessionToken,
  writeWorkerId,
} from "./state.ts";

const log = createLogger("band-worker");

const require = createRequire(import.meta.url);
export const WORKER_VERSION: string = require("../package.json").version;

/** Agent types the worker probes for in its hello. */
const AGENT_TYPES = ["claude-code", "codex", "opencode", "gemini-cli", "cursor-cli"];

export interface WorkerOptions {
  /** Link client settings to override, such as a faster redial for a test. */
  link?: Pick<LinkClientOptions, "reconnect" | "heartbeatMisses" | "handshakeTimeoutMs">;
}

export class Worker {
  /** Resolves with the process exit code once the worker has stopped. */
  readonly exited: Promise<number>;
  readonly workerId: string;
  readonly roots: string[];

  private readonly client: LinkClient;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly disposers: (() => void | Promise<void>)[] = [];
  private stopping: Promise<void> | null = null;
  private resolveExit!: (code: number) => void;
  private exitCode = 0;
  /** The save of the latest session token. Writes queue behind it, and shutdown waits for it. */
  private tokenSaved: Promise<void> = Promise.resolve();

  private constructor(
    client: LinkClient,
    workerId: string,
    roots: string[],
    private readonly config: WorkerConfig,
    private readonly stateDir: string,
  ) {
    this.client = client;
    this.workerId = workerId;
    this.roots = roots;
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  /**
   * Prepares the worker and dials the hub. Resolves once the hub has said
   * `ready`. Rejects when the hub refuses the worker or the config is unusable.
   * With the hub unreachable it keeps retrying, as the link client does.
   */
  static async start(config: WorkerConfig, options: WorkerOptions = {}): Promise<Worker> {
    await ensureStateDir(config.stateDir);
    let workerId = config.workerId ?? (await loadOrCreateWorkerId(config.stateDir));
    const policy = await PathPolicy.create(
      config.roots.length > 0 ? config.roots : [join(config.stateDir, "workspaces")],
    );
    const resolved = await resolveToken(config, workerId);
    const token = resolved.token;
    // The hub names the worker when it trades the bootstrap token, and a worker told its id keeps it.
    if (resolved.workerId !== workerId || config.workerId !== undefined) {
      workerId = resolved.workerId;
      await writeWorkerId(config.stateDir, workerId);
    }

    const backend = new InProcessTerminalBackend();
    const host = new LocalHost({ terminalBackend: () => backend });
    const info = await host.info();

    const client = new LinkClient({
      url: linkUrl(config.hubUrl),
      token,
      useSessionToken: true,
      ...options.link,
      hello: {
        workerId,
        buildId: `band-worker@${WORKER_VERSION}`,
        mode: config.ephemeral ? "ephemeral" : "attached",
        capabilities: Object.entries(info.capabilities)
          .filter(([, on]) => on)
          .map(([name]) => name),
        labels: config.labels,
        roots: policy.rootPaths,
        agents: await findAgents(host),
      },
    });
    const worker = new Worker(client, workerId, policy.rootPaths, config, config.stateDir);

    const ctx: WorkerContext = {
      host,
      session: client.session,
      policy,
      activity: new ActivityTracker(),
      log,
      labels: config.labels,
    };
    const registrar = new Registrar(ctx);
    worker.disposers.push(registerBasicMethods(registrar, ctx));
    worker.disposers.push(registerStreamMethods(registrar, ctx));
    worker.disposers.push(registerRelayMethods(registrar, ctx));
    worker.wire(ctx);

    try {
      await client.connect();
    } catch (err) {
      await worker.stop(1);
      throw err;
    }
    return worker;
  }

  async stop(code = 0): Promise<void> {
    this.stopping ??= this.shutdown(code);
    await this.stopping;
  }

  private async shutdown(code: number): Promise<void> {
    this.exitCode = code;
    for (const t of this.timers) clearInterval(t);
    await this.client.close();
    await this.tokenSaved;
    for (const dispose of this.disposers) await Promise.resolve(dispose()).catch(() => undefined);
    await stopAllAgentProcesses().catch(() => undefined);
    this.resolveExit(this.exitCode);
  }

  private wire(ctx: WorkerContext): void {
    const { client } = this;
    // Channels the hub opens are held until both sides have finished with them.
    const hubChannels = new Set<Channel>();
    client.session.on("channel", (ch: Channel) => {
      if (!this.config.ephemeral) return;
      for (const old of hubChannels) if (old.closed) hubChannels.delete(old);
      hubChannels.add(ch);
    });

    let disconnectedSince: number | null = null;
    client.on("connected", (ready: Ready, resumed: boolean) => {
      disconnectedSince = null;
      log.info({ workerId: this.workerId, resumed }, "connected to the hub");
      // The hub rotates the session token on every handshake. Keep the newest one.
      this.tokenSaved = this.tokenSaved
        .then(() => writeSessionToken(this.stateDir, ready.sessionToken))
        .catch((err) =>
          log.error(
            { message: err instanceof Error ? err.message : String(err) },
            "could not save the session token",
          ),
        );
    });
    client.on("disconnected", () => {
      disconnectedSince = Date.now();
      log.warn("lost the hub link, redialing");
    });
    client.on("rejected", (reason: string) => {
      log.error({ reason }, "the hub rejected this worker");
      void this.stop(1);
    });
    client.on("mismatch", (need: number) => {
      log.error({ need }, "the hub speaks another link protocol version");
      void this.stop(1);
    });

    if (this.config.ephemeral) {
      const { idleExitMs } = this.config;
      const tick = setInterval(
        () => {
          for (const ch of hubChannels) if (ch.closed) hubChannels.delete(ch);
          if (hubChannels.size > 0) ctx.activity.touch();
          const gone = disconnectedSince !== null && Date.now() - disconnectedSince >= idleExitMs;
          if (gone || ctx.activity.idleMs() >= idleExitMs) {
            log.info({ idleMs: idleExitMs }, gone ? "hub unreachable, exiting" : "idle, exiting");
            void this.stop(0);
          }
        },
        Math.min(1000, Math.max(20, idleExitMs / 4)),
      );
      this.timers.push(tick);
    }
  }
}

/**
 * The token to dial with. An explicit session token wins. A bootstrap token is
 * traded once, and the session token that comes back is kept, so a restart
 * with the same bootstrap token reuses it.
 */
async function resolveToken(
  config: WorkerConfig,
  workerId: string,
): Promise<{ token: string; workerId: string }> {
  const given = config.token;
  if (given && !given.startsWith(BOOTSTRAP_TOKEN_PREFIX)) return { token: given, workerId };
  const stored = await readSessionToken(config.stateDir);
  if (stored) return { token: stored, workerId };
  if (!given) throw new ConfigError("no token: pass --token or set BAND_WORKER_TOKEN");
  const exchanged = await exchangeBootstrapToken({
    hubUrl: config.hubUrl,
    bootstrapToken: given,
    workerId: config.workerId,
    name: config.name,
  });
  await writeSessionToken(config.stateDir, exchanged.sessionToken);
  return { token: exchanged.sessionToken, workerId: exchanged.workerId };
}

/** The agent types this machine can start, by asking the host to resolve each. */
async function findAgents(host: Host): Promise<string[]> {
  const found: string[] = [];
  for (const type of AGENT_TYPES) {
    try {
      if (typeof (await host.acp.resolveLaunch({ type })) !== "string") found.push(type);
    } catch {
      // A launch that throws is not available.
    }
  }
  return found;
}
