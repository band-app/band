import { execFile, spawn } from "node:child_process";
import { createReadStream, watch as fsWatch } from "node:fs";
import {
  cp,
  glob as fsGlob,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { getUsageReader } from "@band-app/coding-agent";
import type {
  AcpAgentDefinition,
  AgentDescriptor,
  ClaudeDefaults,
  ExecOptions,
  ExecResult,
  FileChange,
  FsEntryKind,
  FsStat,
  Host,
  HostAcp,
  HostAgentEnv,
  HostBrowser,
  HostContext,
  HostDesktop,
  HostFs,
  HostGit,
  HostInfo,
  HostLsp,
  HostMcp,
  HostScripts,
  HostSearch,
  HostWorktree,
  ScriptLabel,
  ScriptPlan,
  SearchMatch,
  SearchQuery,
  Stream,
  TerminalBackend,
  WatchOptions,
  Worktree,
  WorktreeInfo,
  WorktreeSpec,
} from "@band-app/host-api";
import { resolveAcpLaunch } from "./agents/acp-launch";
import { spawnAgentProcess } from "./agents/agent-spawn";
import {
  configuredClaudeDefaults,
  findClaudeCliArgs,
  reportedClaudeDefaults,
} from "./agents/claude-defaults";
import { checkHooks, installHooks } from "./agents/hooks-install";
import { openMcpStdio } from "./agents/mcp-stdio";
import { installSkills } from "./agents/skills-install";
import { ChromiumManager } from "./browser/chromium";
import { type ContextSource, ContextSync } from "./context/context-sync";
import { desktopUnavailableReason, openDesktop } from "./desktop/desktop";
import { execGh, execGit, listWorktrees } from "./git/git-client";
import { connectLspServer, killAllServers, killWorktreeServers } from "./lsp/lsp-manager";
import { duBytes } from "./process/du";
import { prependBinDirs } from "./process/path";
import { probeTools } from "./process/tools";
import { listFiles, streamMatches } from "./search/ripgrep-client";
import { loadEnvironment, loadScriptCommand } from "./setup/repo-config";
import { prepareScriptRun } from "./setup/script-run";
import { copyWorktreeFiles } from "./setup/worktree-files";
import { findLatestClaudeSessionId } from "./terminals/claude-resume";

/** How long `info()` keeps the tool versions it probed. */
const TOOLS_TTL_MS = 60_000;

/** Same cap `execFile` callers in the hub use for command output. */
const EXEC_MAX_BUFFER = 50 * 1024 * 1024;

export const LOCAL_HOST_ID = "local";

export interface LocalHostOptions {
  /**
   * The terminal backend `host.pty` returns. A function, because the hub picks
   * its backend at boot (and can replace it), after the host exists.
   */
  terminalBackend: () => TerminalBackend;
  /**
   * Where this host's context working copies live and how to reach the hub's
   * repos. Without it `host.context` reports every context as unreachable.
   */
  context?: ContextSource;
  /**
   * Whether this host should look for `gh`. `gh` belongs to the GitHub plugin, so the hub says
   * no when that plugin is disabled, and the host then runs no `gh` process and reports `gh` as
   * unknown. Defaults to yes.
   */
  ghEnabled?: () => boolean | Promise<boolean>;
}

/**
 * The machine the hub runs on. Each method delegates to the code the hub
 * already uses for that job, so a call through the host behaves as the direct
 * call did.
 */
export class LocalHost implements Host {
  readonly id = LOCAL_HOST_ID;
  readonly git: HostGit = {
    exec: async (args, cwd) => ({ stdout: await execGit(args, cwd), stderr: "" }),
    gh: async (args, cwd) => ({ stdout: await execGh(args, cwd), stderr: "" }),
  };
  readonly worktree: HostWorktree = {
    create: (spec) => createWorktree(spec),
    remove: (spec) => removeWorktree(spec),
    list: (repoPath): Promise<WorktreeInfo[]> => listWorktrees(repoPath),
  };
  readonly fs: HostFs = localFs;
  readonly search: HostSearch = {
    stream: (query: SearchQuery, root: string): Stream<SearchMatch> =>
      streamMatches({ ...query, cwd: root }),
    listFiles: (root) => listFiles(root),
  };
  readonly lsp: HostLsp = {
    connect: (spec) => connectLspServer(spec),
    killWorktree: async (worktreeId) => killWorktreeServers(worktreeId),
    killAll: async () => killAllServers(),
  };
  readonly acp: HostAcp = {
    resolveLaunch: (def: AcpAgentDefinition) => resolveAcpLaunch(def),
    spawn: (launch, cwd) => spawnAgentProcess(launch, cwd),
  };
  readonly mcp: HostMcp = {
    openStdio: (spec) => openMcpStdio(spec),
  };
  private readonly chromium = new ChromiumManager(() =>
    join(process.env.BAND_HOME ?? join(homedir(), ".band"), "browser-profiles"),
  );
  readonly browser: HostBrowser = {
    open: (spec) => this.chromium.open(spec),
    connect: (worktreeId) => this.chromium.connect(worktreeId),
    close: (worktreeId) => this.chromium.close(worktreeId),
  };
  readonly desktop: HostDesktop = { open: () => openDesktop() };
  readonly context: HostContext;
  readonly scripts: HostScripts = {
    command: (worktree) => scriptCommand(this, worktree),
    runHidden: (script, cwd, timeoutMs) => runScriptHidden(script, cwd, timeoutMs),
    prepare: (worktree) => prepareScript(this, worktree),
    copyFiles: (repoPath, worktreePath) => copyWorktreeFiles(this, repoPath, worktreePath),
    environment: (worktree) => loadEnvironment(this, worktree.worktreePath, worktree.repoPath),
  };
  readonly agentEnv: HostAgentEnv = {
    claudeDefaults: async (cwd, cli): Promise<ClaudeDefaults> => {
      const { model, effort } = configuredClaudeDefaults({ cwd, env: process.env, cli });
      return { model, effort };
    },
    reportedClaudeDefaults: async ({ cwd, sessionId, since }): Promise<ClaudeDefaults> => {
      const { model, effort } = reportedClaudeDefaults({
        cwd,
        env: process.env,
        sessionId,
        since,
      });
      return { model, effort };
    },
    claudeCliArgs: (adapterPid, sessionId) => findClaudeCliArgs(adapterPid, sessionId),
    latestClaudeSession: async (cwd) => findLatestClaudeSessionId(cwd),
    usageReader: async (agent: AgentDescriptor) =>
      getUsageReader(agent.agentType, { command: agent.command }),
    installSkills: (options) => installSkills(options),
    hooksStatus: () => checkHooks(),
    installHooks: () => installHooks(),
  };

  constructor(private readonly options: LocalHostOptions) {
    const source = options.context;
    const sync = source ? new ContextSync(source) : null;
    this.context = {
      preamble: async (request) => (sync ? sync.preamble(request) : { text: "", memoryDir: null }),
      pull: async (request) =>
        sync
          ? sync.pull(request)
          : request.contexts.map((c) => ({
              name: c.name,
              status: "missing" as const,
              error: "this host has no context source",
            })),
      push: async (request) =>
        sync
          ? sync.push(request)
          : request.contexts.map((c) => ({
              name: c.name,
              status: "failed" as const,
              conflicts: [],
              blocked: [],
              error: "this host has no context source",
            })),
    };
    // The first probe takes about half a second (seven processes). Starting it
    // now keeps the first `hosts.list` after boot from waiting on it.
    void this.toolVersions();
  }

  get pty(): TerminalBackend {
    return this.options.terminalBackend();
  }

  /**
   * Probing runs seven processes. `info()` returns the last answer at once and
   * refreshes it in the background once it is older than `TOOLS_TTL_MS`.
   */
  private tools: { at: number; value: Promise<Record<string, string>> } | null = null;
  private toolsRefreshing = false;

  private toolVersions(): Promise<Record<string, string>> {
    const now = Date.now();
    if (!this.tools) {
      this.tools = { at: now, value: probeTools() };
    } else if (now - this.tools.at > TOOLS_TTL_MS && !this.toolsRefreshing) {
      this.toolsRefreshing = true;
      void probeTools()
        .then((value) => {
          this.tools = { at: Date.now(), value: Promise.resolve(value) };
        })
        .finally(() => {
          this.toolsRefreshing = false;
        });
    }
    return this.tools.value;
  }

  /**
   * `git --version` and `gh --version` run once per host, on the first `info()`, and callers
   * that arrive meanwhile share that probe. `info()` is called by every `hosts.list`, so the
   * answer is kept. A `git` or `gh` installed after the hub started shows up on the next hub
   * restart. With `ghEnabled` returning false there is no `gh` probe at all.
   */
  private cliFacts: Promise<{ versions: Record<string, string>; gh: boolean }> | null = null;

  private probeCliFacts(): Promise<{ versions: Record<string, string>; gh: boolean }> {
    this.cliFacts ??= (async () => {
      const versions: Record<string, string> = { node: process.versions.node };
      let gh = false;
      try {
        versions.git = (await execGit(["--version"], process.cwd()))
          .trim()
          .replace(/^git version /, "");
      } catch {
        // No git on PATH: `versions.git` stays unset and the capability is off.
      }
      if ((await this.options.ghEnabled?.()) ?? true) {
        try {
          versions.gh = (await execGh(["--version"], process.cwd())).split("\n")[0]?.trim() ?? "";
          gh = true;
        } catch {
          // No gh on PATH.
        }
      }
      return { versions, gh };
    })();
    return this.cliFacts;
  }

  async info(): Promise<HostInfo> {
    const { versions: probed, gh } = await this.probeCliFacts();
    const versions = { ...probed };
    return {
      id: this.id,
      os: process.platform,
      arch: process.arch,
      hostname: hostname(),
      home: homedir(),
      labels: [],
      roots: [],
      versions,
      tools: await this.toolVersions(),
      capabilities: {
        git: "git" in versions,
        gh,
        fsWatch: true,
        search: true,
        lsp: true,
        pty: true,
        acp: true,
        desktop: desktopUnavailableReason() === null,
      },
    };
  }

  exec(bin: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...options.env };
      env.PATH = prependBinDirs(env.PATH);
      execFile(
        bin,
        args,
        { cwd: options.cwd, env, maxBuffer: EXEC_MAX_BUFFER, timeout: options.timeoutMs },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(stderr.trim() || err.message));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
  }
}

// ---------------------------------------------------------------------------
// worktree
// ---------------------------------------------------------------------------

async function createWorktree(spec: WorktreeSpec): Promise<Worktree> {
  const args = ["worktree", "add", "-b", spec.branch, spec.path];
  if (spec.base) args.push(spec.base);
  await execGit(args, spec.repoPath);
  return { path: spec.path, branch: spec.branch };
}

async function removeWorktree(spec: { repoPath: string; path: string }): Promise<void> {
  // A locked worktree refuses removal, even with --force.
  await execGit(["worktree", "unlock", spec.path], spec.repoPath).catch(() => undefined);
  await execGit(["worktree", "remove", "--force", spec.path], spec.repoPath);
}

// ---------------------------------------------------------------------------
// fs
// ---------------------------------------------------------------------------

function kindOf(entry: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): FsEntryKind {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "other";
}

const localFs: HostFs = {
  async stat(path, options): Promise<FsStat> {
    const stats = options?.followSymlinks ? await stat(path) : await lstat(path);
    return { kind: kindOf(stats), size: stats.size, mtimeMs: stats.mtimeMs };
  },
  async readFile(path) {
    return new Uint8Array(await readFile(path));
  },
  realpath: (path) => realpath(path),
  async *readStream(path) {
    for await (const chunk of createReadStream(path)) {
      const buffer = chunk as Buffer;
      yield new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
  },
  writeFile: (path, data, options) =>
    writeFile(path, data, {
      mode: options?.mode,
      ...(options?.exclusive ? { flag: "wx" } : {}),
    }),
  async glob(pattern, cwd) {
    const matches: string[] = [];
    for await (const match of fsGlob(pattern, { cwd })) matches.push(match);
    return matches;
  },
  mkdtemp: (prefix) => mkdtemp(join(tmpdir(), prefix)),
  async list(path) {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, kind: kindOf(entry) }));
  },
  async mkdir(path, options) {
    await mkdir(path, { recursive: options?.recursive });
  },
  rm: (path, options) => rm(path, options),
  rename: (from, to) => rename(from, to),
  // dereference: copy a symlink's target bytes, as copyFileSync did, so the copy never links back into the source tree.
  copy: (from, to, options) =>
    cp(from, to, {
      recursive: options?.recursive ?? false,
      dereference: true,
      ...(options?.exclusive ? { errorOnExist: true, force: false } : {}),
    }),
  du: (path) => duBytes(path),
  watch: (root, options) => watchTree(root, options),
};

/**
 * Wraps `fs.watch` as a stream. Events queue until the consumer reads them,
 * and the watcher closes when the consumer stops or the signal aborts.
 */
function watchTree(root: string, options: WatchOptions = {}): Stream<FileChange> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<FileChange> {
      const queue: FileChange[] = [];
      let wake: (() => void) | null = null;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        watcher.close();
        wake?.();
      };
      const watcher = fsWatch(
        root,
        { recursive: options.recursive ?? true, persistent: false },
        (kind, filename) => {
          if (done || filename === null) return;
          queue.push({ path: filename.toString().split("\\").join("/"), kind });
          wake?.();
        },
      );
      // A watch that fails after it started (the root was deleted) ends the stream.
      watcher.on("error", finish);
      if (options.signal?.aborted) finish();
      else options.signal?.addEventListener("abort", finish, { once: true });

      return {
        async next(): Promise<IteratorResult<FileChange>> {
          while (queue.length === 0 && !done) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = null;
          }
          const change = queue.shift();
          if (change) return { value: change, done: false };
          return { value: undefined, done: true };
        },
        async return(): Promise<IteratorResult<FileChange>> {
          finish();
          return { value: undefined, done: true };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// scripts
// ---------------------------------------------------------------------------

async function prepareScript(
  host: Host,
  worktree: {
    repoPath: string;
    worktreePath: string;
    label: ScriptLabel;
  },
): Promise<ScriptPlan | null> {
  const value = await scriptCommand(host, worktree);
  if (value === null) return null;
  return prepareScriptRun(host, value, worktree.label);
}

async function scriptCommand(
  host: Host,
  worktree: {
    repoPath: string;
    worktreePath: string;
    label: ScriptLabel;
  },
): Promise<string | null> {
  return loadScriptCommand(host, worktree.worktreePath, worktree.repoPath, worktree.label);
}

/**
 * Run `script` through `cmd.exe /d /s /c` in `cwd`, without a terminal, and
 * resolve with its exit code (or `null` on `timeoutMs`). The Windows path:
 * terminals there cannot run the bash wrapper `prepareScriptRun` builds.
 */
function runScriptHidden(script: string, cwd: string, timeoutMs?: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const { PORT: _port, ...parentEnv } = process.env;
    const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", script], {
      cwd,
      env: { ...parentEnv, PATH: prependBinDirs(process.env.PATH) },
      stdio: "ignore",
      windowsHide: true,
    });
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill();
            resolve(null);
          }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}
