import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Host } from "@band-app/host-api";
import { LocalHost } from "@band-app/host-local";
import { stopAllAgentProcesses } from "@band-app/host-local/agents/agent-spawn";
import {
  CAPABILITY_CHAT_OWNERSHIP,
  CAPABILITY_DIRECT,
  type Channel,
  type LeaseRenewParams,
  type LifecycleIdleReply,
  type LifecyclePolicy,
  LinkClient,
  type LinkClientOptions,
  LinkRejectedError,
  METHOD_LEASE_RENEW,
  METHOD_LIFECYCLE_IDLE,
  METHOD_LIFECYCLE_POLICY,
  METHOD_LIFECYCLE_SHUTDOWN,
  METHOD_LIFECYCLE_SLEEP,
  type Ready,
  RPC_METHOD_NOT_FOUND,
  RpcError,
} from "@band-app/link";
import { createLogger } from "@band-app/logger";
import { VERSION_REFUSED_CODE } from "@band-app/shared/versions";

import pkg from "../package.json" with { type: "json" };
import { ActivityTracker } from "./activity.ts";
import { exchangeBootstrapToken } from "./bootstrap.ts";
import { ChatOwner } from "./chats/owner.ts";
import { ChatStore } from "./chats/store.ts";
import { CliCache } from "./cli.ts";
import { BOOTSTRAP_TOKEN_PREFIX, ConfigError, linkUrl, type WorkerConfig } from "./config.ts";
import { Registrar, type WorkerContext } from "./context.ts";
import { registerDirectMethods } from "./direct.ts";
import { GitCredentialBroker, gitCredentialEnv } from "./git-credentials.ts";
import { LeaseGuard } from "./lease.ts";
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
import { detectServiceManager, registerUpdateMethods, type ServiceManager } from "./update.ts";

const log = createLogger("band-worker");

// Imported, not required at run time, so the desktop app's bundle (no package.json beside it) has it too.
export const WORKER_VERSION: string = pkg.version;

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
  /** The service manager that supervises this worker. Defaults to what the environment says. */
  serviceManager?: ServiceManager | null;
  /** How long a worker the hub refused for its version waits before it gives up. Default 5 minutes. */
  versionRetryMs?: number;
}

/** The hub refused this worker's version. It waits, so a service manager's restart does not redial every few seconds. */
const VERSION_RETRY_MS = 5 * 60_000;

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
  /** The chats this worker owns, with `--own-chats`. */
  chats: ChatOwner | null = null;
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
    // Folders the worker creates itself are served whatever the roots, from the first call on.
    if (config.reposDir) await policy.allowManaged(config.reposDir);
    const host = new LocalHost({
      terminalBackend: () => backend,
      repos: {
        mappingsFile: () => join(config.stateDir, "repos.json"),
        ...(config.reposDir ? { reposDir: () => config.reposDir as string } : {}),
      },
    });
    const repoPaths = async () => [
      ...(await host.repos.list()).map((m) => m.path),
      ...(await gitReposAtRoots(policy.rootPaths)),
    ];
    policy.useWorktrees({
      repoPaths,
      worktreePaths: async (repo) => (await host.worktree.list(repo)).map((w) => w.path),
    });
    // The hello carries the capability report, so the first probe finishes before it.
    await host.awaitReport();
    const info = await host.info();

    const serviceManager =
      options.serviceManager !== undefined
        ? options.serviceManager
        : config.ephemeral
          ? null
          : detectServiceManager();
    const client = new LinkClient({
      url: linkUrl(config.hubUrl),
      token,
      useSessionToken: true,
      ...options.link,
      hello: {
        workerId,
        buildId: `band-worker@${WORKER_VERSION}`,
        version: WORKER_VERSION,
        ...(serviceManager ? { serviceManager } : {}),
        mode: config.ephemeral ? "ephemeral" : "attached",
        capabilities: [
          ...Object.entries(info.capabilities)
            .filter(([, on]) => on)
            .map(([name]) => name),
          // The loopback listener for the desktop app on this machine (`direct.ts`).
          CAPABILITY_DIRECT,
          ...(config.ownChats ? [CAPABILITY_CHAT_OWNERSHIP] : []),
        ],
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
      lease: new LeaseGuard({
        host,
        stateDir: config.stateDir,
        log,
        worktreePaths: async () => {
          const out = new Set<string>();
          for (const repo of new Set(await repoPaths())) {
            for (const w of await host.worktree.list(repo).catch(() => [])) out.add(w.path);
          }
          return [...out];
        },
      }),
      log,
      labels: config.labels,
      stateDir: config.stateDir,
      reposDir: config.reposDir,
      cli: new CliCache(client.session, config.stateDir, log),
      ownsChats: config.ownChats,
    };
    const registrar = new Registrar(ctx);
    registrar.json(METHOD_LEASE_RENEW, (a) => {
      const p = a as unknown as LeaseRenewParams;
      if (typeof p.ttlMs !== "number" || !Number.isFinite(p.ttlMs) || p.ttlMs <= 0) {
        throw new Error("lease.renew needs a positive ttlMs");
      }
      return ctx.lease.renew(
        p.ttlMs,
        Array.isArray(p.blockedPaths) ? p.blockedPaths.filter((x) => typeof x === "string") : [],
      );
    });
    worker.disposers.push(() => ctx.lease.close());
    worker.disposers.push(registerBasicMethods(registrar, ctx));
    worker.disposers.push(registerStreamMethods(registrar, ctx));
    worker.disposers.push(registerRelayMethods(registrar, ctx));
    if (config.ownChats) {
      const chats = new ChatOwner(ctx, await ChatStore.open(join(config.stateDir, "chats.db")));
      chats.register(registrar);
      chats.start();
      worker.chats = chats;
    }
    // The desktop app on this machine reaches files, terminals and owned chats on loopback.
    worker.disposers.push(registerDirectMethods(registrar, ctx, worker.chats));
    // After the listener, so no open chat stream reads a closed store.
    const chats = worker.chats;
    if (chats) worker.disposers.push(() => chats.close());
    // Every worker hands out its agents' session files: an ephemeral one when it sleeps, a static
    // one for the hub's checkpoints, so a restored chat resumes its session on another host.
    registerLifecycleMethods(registrar, ctx);
    registerUpdateMethods(registrar, serviceManager, (level, fields, msg) =>
      level === "error" ? log.error(fields, msg) : log.info(fields, msg),
    );
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
      if (err instanceof LinkRejectedError && err.code === VERSION_REFUSED_CODE) {
        const fromEnv = Number(process.env.BAND_WORKER_VERSION_RETRY_MS);
        await worker.waitOutRefusal(
          err.message.replace(/^rejected: /, ""),
          options.versionRetryMs ?? (fromEnv > 0 ? fromEnv : undefined),
        );
      }
      await worker.stop(1);
      throw err;
    }
    return worker;
  }

  private connectedOnce = false;
  private refusalWaiting = false;
  private versionRetryMs = VERSION_RETRY_MS;

  /** Logs why the hub refused this version and waits before the process exits, which is when a service manager would redial. */
  private async waitOutRefusal(reason: string, retryMs = VERSION_RETRY_MS): Promise<void> {
    this.versionRetryMs = retryMs;
    log.error(
      { reason, retryInMs: retryMs },
      `the hub refused this worker: ${reason}. Update it with: npm i -g @band-app/worker, then restart it`,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
  }

  async stop(code = 0): Promise<void> {
    this.stopping ??= this.shutdown(code);
    await this.stopping;
  }

  private async shutdown(code: number): Promise<void> {
    this.exitCode = code;
    for (const t of this.timers) clearInterval(t);
    await this.tellHubShuttingDown();
    await this.client.close();
    await this.tokenSaved;
    for (const dispose of this.disposers) await Promise.resolve(dispose()).catch(() => undefined);
    await stopAllAgentProcesses().catch(() => undefined);
    this.resolveExit(this.exitCode);
  }

  /**
   * A worker that stops cleanly tells the hub first, so the hub can take a last checkpoint of its
   * worktrees while the link is still up. An ephemeral worker has the sleep hand-off instead. The
   * wait is bounded and every failure is ignored: stopping must not hang on the hub.
   */
  private async tellHubShuttingDown(): Promise<void> {
    if (this.config.ephemeral || !this.client.session.attached) return;
    try {
      await this.client.session.request(METHOD_LIFECYCLE_SHUTDOWN, {}, { timeoutMs: 30_000 });
    } catch (err) {
      if (err instanceof RpcError && err.code === RPC_METHOD_NOT_FOUND) return;
      log.debug(
        { message: err instanceof Error ? err.message : String(err) },
        "the hub did not take a final checkpoint",
      );
    }
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
      this.connectedOnce = true;
      log.info({ workerId: this.workerId, resumed }, "connected to the hub");
      void ctx.cli?.sync();
      this.chats?.onConnected();
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
    client.on("rejected", (reason: string, code?: string) => {
      log.error({ reason }, "the hub rejected this worker");
      // The first connect handles its own refusal, in `start`.
      if (code === VERSION_REFUSED_CODE && this.connectedOnce) {
        if (this.refusalWaiting) return;
        this.refusalWaiting = true;
        void this.waitOutRefusal(reason, this.versionRetryMs).then(() => this.stop(1));
      } else if (this.connectedOnce || code !== VERSION_REFUSED_CODE) {
        void this.stop(1);
      }
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
