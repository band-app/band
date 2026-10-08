import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Host } from "@band-app/host-api";
import { LocalHost } from "@band-app/host-local";
import { stopAllAgentProcesses } from "@band-app/host-local/agents/agent-spawn";
import {
  type Channel,
  type LifecycleIdleReply,
  type LifecyclePolicy,
  LinkClient,
  type LinkClientOptions,
  METHOD_LIFECYCLE_IDLE,
  METHOD_LIFECYCLE_POLICY,
  METHOD_LIFECYCLE_SLEEP,
  type Ready,
  RPC_METHOD_NOT_FOUND,
  RpcError,
} from "@band-app/link";
import { createLogger } from "@band-app/logger";
import { ActivityTracker } from "./activity.ts";
import { exchangeBootstrapToken } from "./bootstrap.ts";
import { CliCache } from "./cli.ts";
import {
  BOOTSTRAP_TOKEN_PREFIX,
  ConfigError,
  httpUrl,
  linkUrl,
  type WorkerConfig,
} from "./config.ts";
import { Registrar, type WorkerContext } from "./context.ts";
import { GitCredentialBroker, gitCredentialEnv } from "./git-credentials.ts";
import { registerBasicMethods } from "./methods-basic.ts";
import { registerLifecycleMethods } from "./methods-lifecycle.ts";
import { registerStreamMethods } from "./methods-streams.ts";
import { PathPolicy } from "./path-policy.ts";
import { registerRelayMethods } from "./relay.ts";
import {
  ensureStateDir,
  loadExtraRoots,
  loadOrCreateWorkerId,
  readSessionToken,
  writeSessionToken,
  writeWorkerId,
} from "./state.ts";
import { createWorkerTerminalBackend } from "./terminals.ts";

const log = createLogger("band-worker");

const require = createRequire(import.meta.url);
export const WORKER_VERSION: string = require("../package.json").version;

/**
 * How long an ephemeral worker waits for a hub it has lost before it exits. It
 * cannot persist its worktrees without the hub, so it stays up much longer
 * than the idle time, in case the hub comes back.
 */
const LOST_HUB_EXIT_MS = 60 * 60_000;

/** Agent types the worker probes for in its hello. */
const AGENT_TYPES = ["claude-code", "codex", "opencode", "gemini-cli", "cursor-cli"];

export interface WorkerOptions {
  /** Link client settings to override, such as a faster redial for a test. */
  link?: Pick<LinkClientOptions, "reconnect" | "heartbeatMisses" | "handshakeTimeoutMs">;
  /**
   * The `credential.helper` value (git's `!` form) that runs this worker's helper. With it the
   * worker puts git credential settings in its own environment, which the git commands, agents
   * and terminals it starts inherit. A worker started in a test process has none.
   */
  gitCredentialHelper?: string;
  /**
   * Run terminals in a detached daemon that outlives the worker, so they survive a restart (see
   * `terminals.ts`). Off by default: a worker started in a test process would leave a daemon behind.
   */
  persistentTerminals?: boolean;
}

/** Git repos that are a root or sit directly in one. A repo with no remote URL has no mapping, so this finds it. */
async function gitReposAtRoots(roots: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const root of roots) {
    const candidates = [root];
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(join(root, entry.name));
      }
    } catch {
      // An unreadable root has no repos to find.
    }
    for (const dir of candidates) if (existsSync(join(dir, ".git"))) found.push(dir);
  }
  return found;
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
  /** The daemon backend, when terminals persist. It reports the exits that happened while the worker was down. */
  private terminalDaemon: { recoverExits(): Promise<number> } | null = null;

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
    const extraRoots = (await loadExtraRoots(config.stateDir)).filter((dir) => existsSync(dir));
    const policy = await PathPolicy.create([
      ...(config.roots.length > 0 ? config.roots : [join(config.stateDir, "worktrees")]),
      ...extraRoots,
    ]);
    const resolved = await resolveToken(config, workerId);
    const token = resolved.token;
    // The hub names the worker when it trades the bootstrap token, and a worker told its id keeps it.
    if (resolved.workerId !== workerId || config.workerId !== undefined) {
      workerId = resolved.workerId;
      await writeWorkerId(config.stateDir, workerId);
    }

    const terminals = createWorkerTerminalBackend(
      config.stateDir,
      options.persistentTerminals === true,
    );
    const backend = terminals.backend;
    const bandHome = config.bandHome ?? process.env.BAND_HOME ?? join(homedir(), ".band");
    const host = new LocalHost({
      terminalBackend: () => backend,
      repos: {
        mappingsFile: () => join(config.stateDir, "repos.json"),
        ...(config.reposDir ? { reposDir: () => config.reposDir as string } : {}),
      },
      context: {
        bandHome: () => bandHome,
        // The hub rotates the session token on every handshake, so read the newest one each time.
        remote: async (name) => {
          const current = (await readSessionToken(config.stateDir)) ?? token;
          const url = httpUrl(config.hubUrl, `/git/context/${name}.git`);
          const basic = Buffer.from(`worker:${current}`).toString("base64");
          return {
            url,
            env: {
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: `http.${url}.extraHeader`,
              GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
            },
          };
        },
      },
    });
    policy.useWorktrees({
      repoPaths: async () => [
        ...(await host.repos.list()).map((m) => m.path),
        ...(await gitReposAtRoots(policy.rootPaths)),
      ],
      worktreePaths: async (repo) => (await host.worktree.list(repo)).map((w) => w.path),
    });
    // The hello carries the capability report, so the first probe finishes before it.
    await host.awaitReport();
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
        tools: info.tools,
      },
    });
    const worker = new Worker(client, workerId, policy.rootPaths, config, config.stateDir);
    worker.terminalDaemon = terminals.daemon;

    const ctx: WorkerContext = {
      host,
      session: client.session,
      policy,
      activity: new ActivityTracker(),
      log,
      labels: config.labels,
      stateDir: config.stateDir,
      reposDir: config.reposDir,
      cli: new CliCache(client.session, config.stateDir, log),
    };
    const registrar = new Registrar(ctx);
    worker.disposers.push(registerBasicMethods(registrar, ctx));
    worker.disposers.push(registerStreamMethods(registrar, ctx));
    worker.disposers.push(registerRelayMethods(registrar, ctx));
    if (config.ephemeral) registerLifecycleMethods(registrar, ctx);
    if (options.gitCredentialHelper) {
      const broker = new GitCredentialBroker(ctx);
      const socketPath = await broker.start();
      worker.disposers.push(() => broker.close());
      Object.assign(
        process.env,
        gitCredentialEnv(process.env, options.gitCredentialHelper, socketPath),
      );
    }
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
      void ctx.cli?.sync();
      // Shells that ended while the worker was down: the hub hears of them now.
      void this.terminalDaemon
        ?.recoverExits()
        .catch((err) =>
          log.warn(
            { message: err instanceof Error ? err.message : String(err) },
            "could not recover terminal exits",
          ),
        );
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
      // The hub may replace the idle time (`lifecycle.policy`).
      let idleExitMs = this.config.idleExitMs;
      client.session.handle(METHOD_LIFECYCLE_POLICY, (params) => {
        const policy = (params ?? {}) as LifecyclePolicy;
        if (typeof policy.idleExitMs === "number" && policy.idleExitMs > 0) {
          idleExitMs = policy.idleExitMs;
          log.info({ idleExitMs }, "the hub set the idle time");
        }
        return null;
      });
      // The hub wants the worker stored and gone before its idle time (maximum lifetime of the machine).
      client.session.handle(METHOD_LIFECYCLE_SLEEP, () => {
        const started = !this.asking && !this.stopping;
        if (started) void this.askToExit(ctx);
        return { started };
      });
      const lostHubMs = Math.max(idleExitMs, LOST_HUB_EXIT_MS);
      const tick = setInterval(
        () => {
          for (const ch of hubChannels) if (ch.closed) hubChannels.delete(ch);
          if (hubChannels.size > 0) ctx.activity.touch();
          if (disconnectedSince !== null && Date.now() - disconnectedSince >= lostHubMs) {
            log.info({ lostHubMs }, "hub unreachable, exiting");
            void this.stop(0);
            return;
          }
          if (ctx.activity.idleMs() >= idleExitMs) void this.askToExit(ctx);
        },
        Math.min(1000, Math.max(20, idleExitMs / 4)),
      );
      this.timers.push(tick);
    }
  }

  private asking = false;

  /**
   * Idle for the idle time: asks the hub whether to exit. The hub checks that
   * nothing runs and stores every worktree on this worker before it says yes,
   * so the worker exits only on `exit: true`. Any other answer, or no answer,
   * counts as activity and the question comes again after another idle time.
   */
  private async askToExit(ctx: WorkerContext): Promise<void> {
    if (this.asking || this.stopping) return;
    this.asking = true;
    try {
      const reply = await this.client.session.request<LifecycleIdleReply>(
        METHOD_LIFECYCLE_IDLE,
        { idleMs: ctx.activity.idleMs() },
        { timeoutMs: 15 * 60_000 },
      );
      if (reply.exit) {
        log.info("the hub stored the worktrees, exiting");
        await this.stop(0);
        return;
      }
      log.info({ reason: reply.reason }, "the hub asked the worker to stay");
      ctx.activity.touch();
    } catch (err) {
      if (err instanceof RpcError && err.code === RPC_METHOD_NOT_FOUND) {
        // A hub that does not manage ephemeral lifecycles has nothing to store.
        log.info("idle, exiting");
        await this.stop(0);
        return;
      }
      log.warn(
        { message: err instanceof Error ? err.message : String(err) },
        "could not ask the hub to exit",
      );
      ctx.activity.touch();
    } finally {
      this.asking = false;
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
