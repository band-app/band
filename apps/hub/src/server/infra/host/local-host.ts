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
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { getUsageReader } from "@band-app/coding-agent";
import {
  type AcpAgentDefinition,
  type AcpLaunch,
  type AgentDescriptor,
  type AgentStdio,
  type ClaudeDefaults,
  type ExecOptions,
  type ExecResult,
  type FileChange,
  type FsEntryKind,
  type FsStat,
  type Host,
  type HostAcp,
  type HostAgentEnv,
  type HostFs,
  type HostGit,
  type HostInfo,
  type HostLsp,
  type HostScripts,
  type HostSearch,
  type HostWorktree,
  type ScriptLabel,
  type ScriptPlan,
  type SearchMatch,
  type SearchQuery,
  type Stream,
  type TerminalBackend,
  type WatchOptions,
  type Worktree,
  type WorktreeInfo,
  type WorktreeSpec,
} from "@band-app/host-api";
import { resolveAcpLaunch } from "../agents/acp-launch";
import { configuredClaudeDefaults } from "../agents/claude-defaults";
import { checkHooks, installHooks } from "../agents/hooks-install";
import { installSkills } from "../agents/skills-install";
import { execGh, execGit, listWorktrees } from "../git/git-client";
import { connectLspServer, killAllServers, killWorkspaceServers } from "../lsp/lsp-manager";
import { duBytes } from "../process/du";
import { prependBinDirs } from "../process/path";
import { listFiles, streamMatches } from "../search/ripgrep-client";
import { loadProjectConfig } from "../setup/project-config";
import { prepareScriptRun } from "../setup/script-run";
import { copyWorkspaceFiles } from "../setup/workspace-files";
import { findLatestClaudeSessionId } from "../terminals/claude-resume";

/** Same cap `execFile` callers in the hub use for command output. */
const EXEC_MAX_BUFFER = 50 * 1024 * 1024;

export const LOCAL_HOST_ID = "local";

export interface LocalHostOptions {
  /**
   * The terminal backend `host.pty` returns. A function, because the hub picks
   * its backend at boot (and can replace it), after the host exists.
   */
  terminalBackend: () => TerminalBackend;
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
    killWorkspace: async (workspaceId) => killWorkspaceServers(workspaceId),
    killAll: async () => killAllServers(),
  };
  readonly acp: HostAcp = {
    resolveLaunch: (def: AcpAgentDefinition) => resolveAcpLaunch(def),
    spawn: (launch, cwd) => spawnAgent(launch, cwd),
  };
  readonly scripts: HostScripts = {
    command: (workspace) => scriptCommand(this, workspace),
    runHidden: (script, cwd, timeoutMs) => runScriptHidden(script, cwd, timeoutMs),
    prepare: (workspace) => prepareScript(this, workspace),
    copyFiles: (projectPath, worktreePath) => copyWorkspaceFiles(this, projectPath, worktreePath),
  };
  readonly agentEnv: HostAgentEnv = {
    claudeDefaults: async (cwd): Promise<ClaudeDefaults> => {
      const { model, effort } = configuredClaudeDefaults({ cwd, env: process.env });
      return { model, effort };
    },
    latestClaudeSession: async (cwd) => findLatestClaudeSessionId(cwd),
    usageReader: async (agent: AgentDescriptor) =>
      getUsageReader(agent.agentType, { command: agent.command }),
    installSkills: (options) => installSkills(options),
    hooksStatus: () => checkHooks(),
    installHooks: () => installHooks(),
  };

  constructor(private readonly options: LocalHostOptions) {}

  get pty(): TerminalBackend {
    return this.options.terminalBackend();
  }

  async info(): Promise<HostInfo> {
    const versions: Record<string, string> = { node: process.versions.node };
    let gh = false;
    try {
      versions.git = (await execGit(["--version"], process.cwd()))
        .trim()
        .replace(/^git version /, "");
    } catch {
      // No git on PATH: `versions.git` stays unset and the capability is off.
    }
    try {
      versions.gh = (await execGh(["--version"], process.cwd())).split("\n")[0]?.trim() ?? "";
      gh = true;
    } catch {
      // No gh on PATH.
    }
    return {
      id: this.id,
      os: process.platform,
      arch: process.arch,
      hostname: hostname(),
      labels: [],
      roots: [],
      versions,
      capabilities: {
        git: "git" in versions,
        gh,
        fsWatch: true,
        search: true,
        lsp: true,
        pty: true,
        acp: true,
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
// acp
// ---------------------------------------------------------------------------

async function spawnAgent(launch: AcpLaunch, cwd: string): Promise<AgentStdio> {
  const child = spawn(launch.command, launch.args, {
    cwd,
    env: { ...process.env, ...launch.env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const stdin = child.stdin;
  const stdout = child.stdout;
  const stderr = child.stderr;
  return {
    pid: child.pid,
    stdin: {
      write: (chunk) => void stdin.write(chunk),
      end: () => stdin.end(),
    },
    stdout: stdout as AsyncIterable<Buffer>,
    stderr: stderr as AsyncIterable<Buffer>,
    exit: new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    kill: (signal) => void child.kill(signal),
  };
}

// ---------------------------------------------------------------------------
// scripts
// ---------------------------------------------------------------------------

async function prepareScript(
  host: Host,
  workspace: {
    projectPath: string;
    worktreePath: string;
    label: ScriptLabel;
  },
): Promise<ScriptPlan | null> {
  const value = await scriptCommand(host, workspace);
  if (value === null) return null;
  return prepareScriptRun(host, value, workspace.label);
}

async function scriptCommand(
  host: Host,
  workspace: {
    projectPath: string;
    worktreePath: string;
    label: ScriptLabel;
  },
): Promise<string | null> {
  const value = (await loadProjectConfig(host, workspace.worktreePath, workspace.projectPath))?.[
    workspace.label
  ];
  return typeof value === "string" && value.trim() !== "" ? value : null;
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
