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
  HostDirect,
  HostFs,
  HostGit,
  HostInfo,
  HostLsp,
  HostMcp,
  HostPlugins,
  HostRelay,
  HostRepos,
  HostScripts,
  HostSearch,
  HostSpeech,
  HostWorktree,
  InstallSkillsResult,
  ScriptPlan,
  SearchMatch,
  SpeechTranscribeResult,
  Stream,
  TerminalExitEvent,
  WatchOptions,
  Worktree,
  WorktreeInfo,
} from "@band-app/host-api";
import {
  type Channel,
  type DirectRegisterParams,
  type DirectRegisterReply,
  decodeFrames,
  encodeFrame,
  type LinkSession,
  METHOD_DIRECT_REGISTER,
  METHOD_PLUGIN_CALL,
  METHOD_RELAY_REGISTER,
  METHOD_RELAY_REVOKE,
  type PluginCallParams,
  type RelayRegisterReply,
} from "@band-app/link";
import { RemoteAgent } from "./agent";
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
  /** Agents in the worker's agent daemon, which outlive a link session. */
  private readonly heldAgents = new Map<string, RemoteAgent>();
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
      const held = this.heldAgents.has(agentId);
      this.agents.get(agentId)?.({ code: code ?? null, signal: signal ?? null });
      this.agents.delete(agentId);
      if (held) {
        this.heldAgents.delete(agentId);
        // The daemon keeps an exited agent until told the hub has seen it.
        this.rpc.request("acp.forget", { agentId }).catch(() => undefined);
      }
    });
    session.onNotification("scripts.exited", (params) => {
      const { planId, code } = params as { planId: string; code: number };
      this.plans.get(planId)?.resolve(code);
      this.plans.delete(planId);
    });
    session.once("destroyed", () => this.handleSessionLost());
  }

  /** The session ended for good: whatever ran on it is gone, except agents the worker's daemon holds. */
  private handleSessionLost(): void {
    for (const [agentId, resolve] of [...this.agents]) {
      const held = this.heldAgents.get(agentId);
      if (held) {
        // Still running on the worker. It waits there for the worker to come back.
        held.detach();
        continue;
      }
      resolve({ code: null, signal: "link-lost" });
      this.agents.delete(agentId);
    }
    for (const plan of this.plans.values()) plan.resolve(-1);
    this.plans.clear();
    this.pty.handleSessionLost();
  }

  /**
   * Reattaches the agents that waited for this worker, then tells it which agents the hub still
   * wants so it can end the ones nobody does. Call it after the worker's hello.
   */
  async reattachAgents(): Promise<void> {
    await Promise.all([...this.heldAgents.values()].map((agent) => agent.reattach()));
    const keep = [...this.heldAgents.values()].filter((a) => !a.isGone).map((a) => a.agentId);
    await this.rpc.request("acp.reconcile", { keep }).catch(() => undefined);
  }

  /**
   * Ends the agents this worker holds for the hub, and waits for the worker to confirm. Called when
   * the hub shuts down, because nothing reattaches them after it comes back.
   */
  async stopAgents(timeoutMs = 3_000): Promise<void> {
    await Promise.all([...this.heldAgents.values()].map((agent) => agent.stop(timeoutMs)));
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
    readStream: (path, range) =>
      this.streamOf("fs.readStream", { path, start: range?.start, end: range?.end }),
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

  readonly speech: HostSpeech = {
    transcribe: async (req) => {
      const { audio, ...rest } = req;
      if (audio.byteLength <= INLINE_WRITE_BYTES) {
        return this.rpc.call("speech.transcribe", {
          ...rest,
          audio: { base64: Buffer.from(audio).toString("base64") },
        });
      }
      // Over the message limit: the worker reads the channel to its end.
      const ch = this.rpc.session().openChannel("speech.audio", {});
      ch.discardIncoming();
      const done = this.rpc.call<SpeechTranscribeResult>("speech.transcribe", {
        ...rest,
        audio: { chan: ch.id },
      });
      done.catch(() => undefined);
      try {
        await ch.send(audio);
        ch.end();
      } catch (err) {
        ch.reset("send failed");
        await done.catch(() => undefined);
        throw err;
      }
      return done;
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

  readonly direct: HostDirect = {
    issue: async (scope, ttlMs) => {
      const token = `bwd_${randomBytes(24).toString("base64url")}`;
      const params: DirectRegisterParams = { token, scope, ttlMs };
      const reply = await this.rpc.call<DirectRegisterReply>(METHOD_DIRECT_REGISTER, params);
      // The worker's clock decides, and it is the clock of the client that renews the token.
      return { port: reply.port, token, expiresAt: reply.expiresAt };
    },
  };

  readonly plugins: HostPlugins = {
    call: (pluginId, method, params, scope) => {
      const call: PluginCallParams = { pluginId, method, params, ...scope };
      return this.rpc.call(METHOD_PLUGIN_CALL, call);
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
    accountUsage: (options) => this.rpc.call("agentEnv.accountUsage", options ?? {}),
    hooksStatus: () => this.rpc.call("agentEnv.hooksStatus"),
    installHooks: () => this.rpc.call("agentEnv.installHooks"),
    removeHooks: () => this.rpc.call("agentEnv.removeHooks"),
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
    ch.discardIncoming();
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
        { root, recursive: options?.recursive, ignore: options?.ignore },
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
      held?: boolean;
      ghToken?: boolean;
    }>("acp.spawn", { ...launch, cwd });
    const stdio = this.rpc.channel(reply.stdio);
    const stderr = this.rpc.channel(reply.stderr);
    if (reply.held) {
      const agent = new RemoteAgent(
        this.rpc,
        reply.agentId,
        reply.pid ?? undefined,
        stdio,
        stderr,
        { specHash: launch.specHash ?? null, ghToken: reply.ghToken === true },
        (agentId) => {
          this.heldAgents.delete(agentId);
          this.agents.delete(agentId);
        },
      );
      this.heldAgents.set(reply.agentId, agent);
      this.agents.set(reply.agentId, (exit) => agent.notifyExit(exit));
      return agent;
    }
    let closed = false;
    // Whoever never calls `stdin.end()` would leave the worker waiting on this channel for good,
    // so the agent exiting ends the hub's side.
    const exit = new Promise<AgentExit>((resolve) =>
      this.agents.set(reply.agentId, (result) => {
        resolve(result);
        closed = true;
        stdio.end();
      }),
    );
    return {
      pid: reply.pid ?? undefined,
      ghToken: reply.ghToken === true,
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
      // Nothing reads the output after a close, and the peer's end marker needs consuming.
      ch.discardIncoming();
    },
  };
}
