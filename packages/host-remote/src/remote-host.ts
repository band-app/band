import { randomBytes } from "node:crypto";
import type { UsageReader } from "@band-app/coding-agent";
import type {
  AcpAgentDefinition,
  AgentDescriptor,
  AgentExit,
  AgentStdio,
  ClaudeCliArgs,
  ClaudeDefaults,
  Duplex,
  ExecOptions,
  ExecResult,
  FileChange,
  FsBrowseResult,
  FsEntry,
  FsStat,
  Host,
  HostAcp,
  HostAgentEnv,
  HostBrowser,
  HostDesktop,
  HostFs,
  HostGit,
  HostInfo,
  HostLsp,
  HostMcp,
  HostRelay,
  HostRepos,
  HostScripts,
  HostSearch,
  HostWorktree,
  InstallSkillsResult,
  ScriptPlan,
  SearchMatch,
  Stream,
  TerminalExitEvent,
  WatchOptions,
  Worktree,
  WorktreeInfo,
} from "@band-app/host-api";
import {
  type Channel,
  decodeFrames,
  encodeFrame,
  type LinkSession,
  METHOD_RELAY_REGISTER,
  METHOD_RELAY_REVOKE,
  type RelayRegisterReply,
} from "@band-app/link";
import { RemoteTerminalBackend } from "./pty";
import { channelBytes, channelJsonLines, RemoteRpc } from "./rpc";

/** Largest payload sent inside a `writeFile` request. Bigger data goes down a channel, because a link message is capped at 1 MiB. */
const INLINE_WRITE_BYTES = 256 * 1024;

export interface RemoteHostOptions {
  /** The host id, which is the worker id. */
  id: string;
  /** The worker's current link session. Read on every call, because a restarted worker gets a new one. */
  session: () => LinkSession | undefined;
  /** Replaces the 30 second limit of calls that have no limit of their own. */
  defaultTimeoutMs?: number;
}

interface PendingPlan {
  resolve: (code: number) => void;
}

/**
 * A worker's machine, seen through the same `Host` interface as `LocalHost`.
 * Every method is one call (or one channel) on the worker link, named as in
 * `apps/worker`. A call that cannot reach the worker rejects with
 * `HostOfflineError`, one that outlasts its limit with `HostTimeoutError`, and
 * a path outside the worker's roots with `HostPathDeniedError`.
 *
 * Call {@link attachSession} for each new link session, so the notifications
 * the worker sends (`pty.exit`, `acp.exit`, `scripts.exited`) reach this host.
 */
export class RemoteHost implements Host {
  readonly id: string;
  readonly pty: RemoteTerminalBackend;
  private readonly rpc: RemoteRpc;

  private readonly agents = new Map<string, (exit: AgentExit) => void>();
  private readonly plans = new Map<string, PendingPlan>();

  constructor(options: RemoteHostOptions) {
    this.id = options.id;
    this.rpc = new RemoteRpc(options.id, options.session, { defaultMs: options.defaultTimeoutMs });
    this.pty = new RemoteTerminalBackend(this.rpc);
  }

  /** Routes this session's notifications to the host. Call it once per session. */
  attachSession(session: LinkSession): void {
    session.onNotification("pty.exit", (params) =>
      this.pty.handleExit(params as TerminalExitEvent),
    );
    session.onNotification("acp.exit", (params) => {
      const { agentId, code, signal } = params as { agentId: string } & AgentExit;
      this.agents.get(agentId)?.({ code: code ?? null, signal: signal ?? null });
      this.agents.delete(agentId);
    });
    session.onNotification("scripts.exited", (params) => {
      const { planId, code } = params as { planId: string; code: number };
      this.plans.get(planId)?.resolve(code);
      this.plans.delete(planId);
    });
    session.once("destroyed", () => this.handleSessionLost());
  }

  /** The session ended for good: whatever ran on it is gone. */
  private handleSessionLost(): void {
    for (const resolve of this.agents.values()) resolve({ code: null, signal: "link-lost" });
    this.agents.clear();
    for (const plan of this.plans.values()) plan.resolve(-1);
    this.plans.clear();
    this.pty.handleSessionLost();
  }

  async info(): Promise<HostInfo> {
    const info = await this.rpc.call<HostInfo>("host.info");
    return { ...info, id: this.id };
  }

  exec(bin: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs === undefined ? undefined : options.timeoutMs + 5_000;
    return this.rpc.call("exec", { bin, args, options }, { timeoutMs });
  }

  readonly git: HostGit = {
    exec: (args, cwd) => this.rpc.call("git.exec", { args, cwd }),
    gh: (args, cwd) => this.rpc.call("git.gh", { args, cwd }),
  };

  readonly worktree: HostWorktree = {
    create: (spec): Promise<Worktree> => this.rpc.call("worktree.create", spec),
    remove: (spec) => this.rpc.call("worktree.remove", spec),
    list: (repoPath): Promise<WorktreeInfo[]> => this.rpc.call("worktree.list", { repoPath }),
  };

  readonly repos: HostRepos = {
    inspect: (path) => this.rpc.call("repos.inspect", { path }),
    ensure: (spec) => this.rpc.call("repos.ensure", { ...spec }),
    map: (remoteUrl, path) => this.rpc.call("repos.map", { remoteUrl, path }),
    unmap: (remoteUrl) => this.rpc.call("repos.unmap", { remoteUrl }),
    addRoot: (path) => this.rpc.call("repos.addRoot", { path }),
    list: () => this.rpc.call("repos.list", {}),
  };
  readonly fs: HostFs = {
    stat: (path, options): Promise<FsStat> =>
      this.rpc.call("fs.stat", { path, followSymlinks: options?.followSymlinks }),
    realpath: (path) => this.rpc.call("fs.realpath", { path }),
    readFile: (path) => this.rpc.callBytes("fs.readFile", { path }),
    readStream: (path) => this.streamOf("fs.readStream", { path }),
    writeFile: (path, data, options) => this.writeFile(path, data, options),
    glob: (pattern, cwd) => this.rpc.call("fs.glob", { pattern, cwd }),
    mkdtemp: (prefix) => this.rpc.call("fs.mkdtemp", { prefix }),
    list: (path): Promise<FsEntry[]> => this.rpc.call("fs.list", { path }),
    browse: (path): Promise<FsBrowseResult> => this.rpc.call("fs.browse", { path }),
    mkdir: (path, options) => this.rpc.call("fs.mkdir", { path, recursive: options?.recursive }),
    rm: (path, options) =>
      this.rpc.call("fs.rm", { path, recursive: options?.recursive, force: options?.force }),
    rename: (from, to) => this.rpc.call("fs.rename", { from, to }),
    copy: (from, to, options) =>
      this.rpc.call("fs.copy", {
        from,
        to,
        recursive: options?.recursive,
        exclusive: options?.exclusive,
      }),
    du: (path) => this.rpc.call("fs.du", { path }),
    watch: (root, options) => this.watch(root, options),
  };

  readonly search: HostSearch = {
    stream: (query, root) => this.searchStream(query, root),
    listFiles: (root) => this.rpc.call("search.listFiles", { root }),
  };

  readonly lsp: HostLsp = {
    connect: async (spec): Promise<Duplex> => {
      const reply = await this.rpc.request<{ chan: number }>("lsp.connect", spec);
      return duplexOf(this.rpc.channel(reply.chan));
    },
    killWorktree: (worktreeId) => this.rpc.call("lsp.killWorktree", { worktreeId }),
    killAll: () => this.rpc.call("lsp.killAll"),
  };

  readonly desktop: HostDesktop = {
    open: async (): Promise<Duplex> => {
      const reply = await this.rpc.request<{ chan: number }>("desktop.open", {});
      return duplexOf(this.rpc.channel(reply.chan));
    },
  };

  readonly acp: HostAcp = {
    resolveLaunch: (def: AcpAgentDefinition) =>
      this.rpc.call("acp.resolveLaunch", {
        type: def.type,
        label: def.label,
        command: def.command,
      }),
    spawn: (launch, cwd) => this.spawnAgent(launch, cwd),
  };

  readonly mcp: HostMcp = {
    openStdio: async (spec) => {
      const reply = await this.rpc.request<{ chan: number; pid: number | null }>(
        "mcp.stdio.open",
        spec,
      );
      const stdio = this.rpc.channel(reply.chan);
      let closed = false;
      return {
        pid: reply.pid ?? undefined,
        stdin: {
          write: (chunk) => {
            if (closed) return;
            stdio
              .send(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
              .catch(() => undefined);
          },
          end: () => {
            closed = true;
            stdio.end();
          },
        },
        stdout: channelBytes(stdio),
        // The worker kills the process when its channel is reset.
        kill: () => {
          closed = true;
          stdio.reset("mcp session closed");
        },
      };
    },
  };

  // The worker keeps the browser. `browser.connect` opens one channel of length-prefixed CDP
  // messages, and resetting it drops the connection but not the browser.
  readonly browser: HostBrowser = {
    open: (spec) => this.rpc.call("browser.open", spec, { timeoutMs: 60_000 }),
    connect: async (worktreeId) => {
      const reply = await this.rpc.request<{ chan: number }>("browser.connect", { worktreeId });
      const ch = this.rpc.channel(reply.chan);
      return {
        send: (message) => {
          ch.send(encodeFrame(message)).catch(() => undefined);
        },
        messages: decodeFrames(channelBytes(ch)),
        close: () => ch.reset("cdp connection closed"),
      };
    },
    close: (worktreeId) => this.rpc.call("browser.close", { worktreeId }, { timeoutMs: 30_000 }),
  };

  readonly scripts: HostScripts = {
    command: (worktree) => this.rpc.call("scripts.command", worktree),
    runHidden: (script, cwd, timeoutMs) =>
      this.rpc.call("scripts.runHidden", { script, cwd, timeoutMs }),
    prepare: (worktree) => this.prepareScript(worktree),
    copyFiles: (repoPath, worktreePath) =>
      this.rpc.call("scripts.copyFiles", { repoPath, worktreePath }),
    environment: (worktree) => this.rpc.call("scripts.environment", worktree),
  };

  readonly relay: HostRelay = {
    issue: async (scope) => {
      const token = `brt_${randomBytes(24).toString("base64url")}`;
      const reply = await this.rpc.call<RelayRegisterReply>(METHOD_RELAY_REGISTER, {
        ...scope,
        token,
      });
      let revoked = false;
      return {
        env: {
          BAND_SERVER_URL: reply.url,
          BAND_TOKEN: token,
          // The agent reads the port of the worktree's Chromium from this file once the pane opened it.
          ...(reply.browserPortFile && { BAND_CDP_PORT_FILE: reply.browserPortFile }),
        },
        revoke: async () => {
          if (revoked) return;
          revoked = true;
          await this.rpc.call(METHOD_RELAY_REVOKE, { token }).catch(() => undefined);
        },
      };
    },
  };

  readonly agentEnv: HostAgentEnv = {
    claudeDefaults: (cwd?: string, cli?: ClaudeCliArgs): Promise<ClaudeDefaults> =>
      this.rpc.call("agentEnv.claudeDefaults", { cwd, cli }),
    reportedClaudeDefaults: (opts): Promise<ClaudeDefaults> =>
      this.rpc.call("agentEnv.reportedClaudeDefaults", opts),
    claudeCliArgs: (adapterPid, sessionId) =>
      this.rpc.call("agentEnv.claudeCliArgs", { adapterPid, sessionId }),
    latestClaudeSession: (cwd) => this.rpc.call("agentEnv.latestClaudeSession", { cwd }),
    usageReader: (agent) => this.usageReader(agent),
    // The worker takes no `home` override. It is for tests of the local install.
    installSkills: (): Promise<InstallSkillsResult> => this.rpc.call("agentEnv.installSkills"),
    hooksStatus: () => this.rpc.call("agentEnv.hooksStatus"),
    installHooks: () => this.rpc.call("agentEnv.installHooks"),
  };

  // ---- fs -----------------------------------------------------------------

  private async writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { exclusive?: boolean; mode?: number },
  ): Promise<void> {
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    const base = { path, exclusive: options?.exclusive, mode: options?.mode };
    if (bytes.byteLength <= INLINE_WRITE_BYTES) {
      const inline =
        typeof data === "string" ? data : { base64: Buffer.from(bytes).toString("base64") };
      await this.rpc.call("fs.writeFile", { ...base, data: inline });
      return;
    }
    // The worker reads the channel to its end, which needs this side to keep
    // sending while the request is open.
    const ch = this.rpc.session().openChannel("fs.write", { path });
    const done = this.rpc.call("fs.writeFile", { ...base, data: { chan: ch.id } });
    // A call that fails first (a denied path) must not leave an unhandled rejection behind the send.
    done.catch(() => undefined);
    try {
      await ch.send(bytes);
      ch.end();
    } catch (err) {
      ch.reset("write failed");
      await done.catch(() => undefined);
      throw err;
    }
    await done;
  }

  private streamOf(method: string, params: unknown, signal?: AbortSignal): Stream<Uint8Array> {
    const self = this;
    return (async function* () {
      const reply = await self.rpc.request<{ chan: number }>(method, params, { signal });
      yield* channelBytes(self.rpc.channel(reply.chan), signal);
    })();
  }

  private watch(root: string, options?: WatchOptions): Stream<FileChange> {
    const self = this;
    return (async function* () {
      const reply = await self.rpc.request<{ chan: number }>(
        "fs.watch",
        { root, recursive: options?.recursive },
        { signal: options?.signal },
      );
      yield* channelJsonLines<FileChange>(self.rpc.channel(reply.chan), options?.signal);
    })();
  }

  private searchStream(
    query: Parameters<HostSearch["stream"]>[0],
    root: string,
  ): Stream<SearchMatch> {
    const self = this;
    return (async function* () {
      const reply = await self.rpc.request<{ chan: number }>("search.stream", { root, query });
      yield* channelJsonLines<SearchMatch>(self.rpc.channel(reply.chan));
    })();
  }

  // ---- agents -------------------------------------------------------------

  private async spawnAgent(
    launch: Parameters<HostAcp["spawn"]>[0],
    cwd: string,
  ): Promise<AgentStdio> {
    const reply = await this.rpc.request<{
      agentId: string;
      pid: number | null;
      stdio: number;
      stderr: number;
    }>("acp.spawn", { ...launch, cwd });
    const stdio = this.rpc.channel(reply.stdio);
    const stderr = this.rpc.channel(reply.stderr);
    const exit = new Promise<AgentExit>((resolve) => this.agents.set(reply.agentId, resolve));
    let closed = false;
    return {
      pid: reply.pid ?? undefined,
      stdin: {
        write: (chunk) => {
          if (closed) return;
          stdio.send(typeof chunk === "string" ? Buffer.from(chunk) : chunk).catch(() => undefined);
        },
        end: () => {
          closed = true;
          stdio.end();
        },
      },
      stdout: channelBytes(stdio),
      stderr: channelBytes(stderr),
      exit,
      kill: (signal) => {
        this.rpc.request("acp.kill", { agentId: reply.agentId, signal }).catch(() => undefined);
      },
    };
  }

  // ---- scripts and usage --------------------------------------------------

  private async prepareScript(
    worktree: Parameters<HostScripts["prepare"]>[0],
  ): Promise<ScriptPlan | null> {
    const reply = await this.rpc.call<{ planId: string; command: string } | null>(
      "scripts.prepare",
      worktree,
    );
    if (!reply) return null;
    const exited = new Promise<number>((resolve) => this.plans.set(reply.planId, { resolve }));
    let disposed = false;
    return {
      command: reply.command,
      exited,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.plans.delete(reply.planId);
        this.rpc.request("scripts.dispose", { planId: reply.planId }).catch(() => undefined);
      },
    };
  }

  private async usageReader(agent: AgentDescriptor): Promise<UsageReader | undefined> {
    const who = { agentType: agent.agentType, command: agent.command };
    if (!(await this.rpc.call<boolean>("agentEnv.hasUsageReader", who))) return undefined;
    return {
      listSessions: (dir) => this.rpc.call("agentEnv.usageListSessions", { ...who, dir }),
      getSessionUsage: (sessionId, dir) =>
        this.rpc.call("agentEnv.usageSession", { ...who, sessionId, dir }),
    };
  }
}

/**
 * A byte pipe over one channel: writes go up, the process's output comes down.
 * A reader may stop and a later one pick up where it left off, as with a
 * local server's pipe, so leaving a loop does not reset the channel.
 */
function duplexOf(ch: Channel): Duplex {
  let closed = false;
  return {
    write: (chunk) => {
      if (closed) return;
      ch.send(typeof chunk === "string" ? Buffer.from(chunk) : chunk).catch(() => undefined);
    },
    output: { [Symbol.asyncIterator]: () => ch[Symbol.asyncIterator]() },
    close: () => {
      closed = true;
      ch.end();
    },
  };
}
