import type { UsageReader } from "@band-app/coding-agent";
import type { TerminalBackend } from "./pty";

/**
 * A machine that owns workspaces. Every git, file, process, PTY, search, LSP
 * and agent operation for a workspace goes through the workspace's host, so
 * the hub never touches a worker's disk directly.
 *
 * The hub resolves a host with `HostRegistry.hostFor(workspaceId)`. Today the
 * only implementation is `LocalHost`, which runs in the hub process.
 *
 * Failure convention: a method rejects with an `Error` when the operation
 * fails (a non-zero exit, a missing file). Methods return `null` only where
 * the doc says "or null".
 */
export interface Host {
  /** Stable id. `local` for the machine the hub runs on. */
  readonly id: string;
  info(): Promise<HostInfo>;
  readonly git: HostGit;
  readonly worktree: HostWorktree;
  readonly fs: HostFs;
  readonly search: HostSearch;
  readonly lsp: HostLsp;
  readonly acp: HostAcp;
  /** Same interface the hub's terminal service already uses. */
  readonly pty: TerminalBackend;
  readonly scripts: HostScripts;
  /** Runs a binary on the host with `PATH` extended to the usual tool directories. */
  exec(bin: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  readonly agentEnv: HostAgentEnv;
  /**
   * How a process on the host reaches the hub. A host that runs in the hub
   * process (`LocalHost`) has none, because its processes use the hub's own
   * URL and token. A remote host's processes go through the worker's relay.
   */
  readonly relay?: HostRelay;
}

// ---------------------------------------------------------------------------
// Info and capabilities
// ---------------------------------------------------------------------------

/** What a host can do. A host that lacks one rejects the matching calls. */
export interface HostCapabilities {
  git: boolean;
  /** `gh` is installed and runnable. */
  gh: boolean;
  fsWatch: boolean;
  search: boolean;
  lsp: boolean;
  pty: boolean;
  acp: boolean;
}

export interface HostInfo {
  id: string;
  /** Operating system, as `process.platform` reports it. */
  os: NodeJS.Platform;
  /** CPU architecture, as `process.arch` reports it. */
  arch: string;
  hostname: string;
  /** The home directory of the user the host runs as. A `~` in a path the user types means this. */
  home?: string;
  /** Free-form tags used for placement (`gpu`, `epic-approved`). */
  labels: string[];
  /** Directories workspaces may live under. Empty means unrestricted. */
  roots: string[];
  /** Tool versions found on the host (`node`, `git`). */
  versions: Record<string, string>;
  capabilities: HostCapabilities;
  /**
   * Directories the host keeps for hub files that belong to workspaces
   * (chat uploads, files an agent shares). A remote host declares them, under
   * one of its roots. A local host leaves this out, and the hub uses its own
   * `BAND_HOME`.
   */
  dirs?: HostDirs;
}

export interface HostDirs {
  /** Chat uploads go in `<uploads>/<workspaceId>/`. */
  uploads: string;
  /** Files an agent shares go in `<shared>/<workspaceId>/`. */
  shared: string;
}

// ---------------------------------------------------------------------------
// Streams and exec
// ---------------------------------------------------------------------------

/**
 * A stream of values. Breaking out of a `for await` loop stops it, and
 * where a method takes a `signal`, aborting it ends the stream too.
 */
export type Stream<T> = AsyncIterable<T>;

export interface ExecOptions {
  cwd?: string;
  /** Merged over the host's environment. */
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Output of a command that exited with code 0. A non-zero exit rejects. */
export interface ExecResult {
  stdout: string;
  /** Empty for `git.exec` and `git.gh`, which report stderr only on failure. */
  stderr: string;
}

// ---------------------------------------------------------------------------
// git and worktrees
// ---------------------------------------------------------------------------

export interface HostGit {
  /** Runs `git ARGS` in `cwd`. Rejects with git's stderr on a non-zero exit. */
  exec(args: string[], cwd: string): Promise<ExecResult>;
  /** Runs `gh ARGS` in `cwd`. Rejects with gh's stderr on a non-zero exit. */
  gh(args: string[], cwd: string): Promise<ExecResult>;
}

export interface WorktreeSpec {
  /** Path of the project's main checkout. */
  repoPath: string;
  /** Absolute path of the new worktree. */
  path: string;
  /** New branch to create in the worktree. */
  branch: string;
  /** Commit-ish the branch starts from. Defaults to the checkout's HEAD. */
  base?: string;
}

export interface Worktree {
  path: string;
  branch: string;
}

export interface WorktreeInfo {
  path: string;
  /** Branch name, or `detached-<short sha>` for a detached HEAD. */
  branch: string;
  head: string;
  isBare: boolean;
}

export interface HostWorktree {
  create(spec: WorktreeSpec): Promise<Worktree>;
  /** Removes the worktree directory and its git metadata, even when it has local changes. */
  remove(spec: { repoPath: string; path: string }): Promise<void>;
  list(repoPath: string): Promise<WorktreeInfo[]>;
}

// ---------------------------------------------------------------------------
// fs
// ---------------------------------------------------------------------------

export type FsEntryKind = "file" | "directory" | "symlink" | "other";

export interface FsStat {
  kind: FsEntryKind;
  size: number;
  /** Epoch milliseconds. */
  mtimeMs: number;
}

export interface FsEntry {
  name: string;
  kind: FsEntryKind;
}

export interface FileChange {
  /** Path relative to the watched root, with `/` separators. */
  path: string;
  /** `rename` covers creation, deletion and moves, as in `fs.watch`. */
  kind: "change" | "rename";
}

export interface WatchOptions {
  /** Defaults to true. */
  recursive?: boolean;
  /** Ends the stream when aborted. */
  signal?: AbortSignal;
}

export interface HostFs {
  /**
   * Rejects when the path does not exist. A symlink reports `kind: "symlink"`
   * unless `followSymlinks` is set, which reports the entry it points at.
   */
  stat(path: string, options?: { followSymlinks?: boolean }): Promise<FsStat>;
  /** The canonical path, with every symlink resolved. Rejects when the path does not exist. */
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  /** Yields a file's bytes in chunks. Breaking out of the loop closes the file. */
  readStream(path: string): Stream<Uint8Array>;
  /**
   * Creates the file or replaces its content. The parent directory must
   * exist. With `exclusive`, rejects when the path already exists. `mode`
   * sets the permissions of a new file.
   */
  writeFile(
    path: string,
    data: string | Uint8Array,
    options?: { exclusive?: boolean; mode?: number },
  ): Promise<void>;
  /** Paths under `cwd` matching the glob `pattern`, relative to `cwd`. */
  glob(pattern: string, cwd: string): Promise<string[]>;
  /** Creates a private (mode 0700) directory in the host's temp dir, named from `prefix`, and returns its path. */
  mkdtemp(prefix: string): Promise<string>;
  list(path: string): Promise<FsEntry[]>;
  /** Rejects when the directory already exists, unless `recursive` is set. */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** Removes a file or directory tree. Rejects when the path is missing unless `force` is set. */
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /**
   * Copies a file or, with `recursive`, a directory tree. With `exclusive`,
   * rejects instead of overwriting an existing destination.
   */
  copy(
    from: string,
    to: string,
    options?: { recursive?: boolean; exclusive?: boolean },
  ): Promise<void>;
  /** Disk space the path occupies, in bytes. */
  du(path: string): Promise<number>;
  /** Yields changes under `root` until aborted or the consumer stops iterating. */
  watch(root: string, options?: WatchOptions): Stream<FileChange>;
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export interface SearchQuery {
  /** A literal string, or a regex when `regex` is true. */
  query: string;
  /** Defaults to false. */
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export interface SearchMatch {
  /** Path relative to the search root. */
  file: string;
  /** 1-based. */
  line: number;
  content: string;
}

export interface HostSearch {
  stream(query: SearchQuery, root: string): Stream<SearchMatch>;
  /** Files under `root` that git or ripgrep would not ignore, relative to `root`. */
  listFiles(root: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// lsp and acp
// ---------------------------------------------------------------------------

/**
 * A byte pipe to a process on the host. Writes and output are raw bytes, with
 * whatever framing the process speaks. Writes after the process ends or the
 * pipe closes are dropped.
 */
export interface Duplex {
  write(chunk: Uint8Array | string): void;
  readonly output: Stream<Uint8Array>;
  /** Closes the pipe. The process may outlive it when other clients share it. */
  close(): void;
}

export interface HostLsp {
  /**
   * Opens a stdio connection to the language server for `lang` in the
   * workspace, starting it in `root` if it isn't running. Every connection to
   * one workspace and language shares the server and receives all its output.
   * `output` ends when the server exits or the connection closes. Rejects when
   * `lang` has no server or the server cannot start.
   */
  connect(spec: { workspaceId: string; lang: string; root: string }): Promise<Duplex>;
  /**
   * Signals the workspace's language servers to stop. Resolves without waiting
   * for them to exit. Each connection's output ends once its server has.
   */
  killWorkspace(workspaceId: string): Promise<void>;
  /** Stops every language server on the host. */
  killAll(): Promise<void>;
}

/** What it takes to start an agent's ACP adapter. */
export interface AcpLaunch {
  command: string;
  args: string[];
  /** Merged over the host's environment at spawn. */
  env: Record<string, string>;
}

/** The parts of a settings agent definition the launcher reads. */
export interface AcpAgentDefinition {
  type: string;
  label?: string;
  /** User-configured binary path. */
  command?: string;
}

export interface AgentExit {
  code: number | null;
  signal: string | null;
}

/** A running agent process, seen from the hub. */
export interface AgentStdio {
  pid: number | undefined;
  stdin: { write(chunk: Uint8Array | string): void; end(): void };
  stdout: Stream<Uint8Array>;
  stderr: Stream<Uint8Array>;
  /** Resolves once, when the process ends. */
  exit: Promise<AgentExit>;
  kill(signal?: NodeJS.Signals): void;
}

export interface HostAcp {
  /** The launch for an agent, or a message saying why it can't start (for example, not installed). */
  resolveLaunch(def: AcpAgentDefinition): Promise<AcpLaunch | string>;
  /** Starts the adapter in `cwd`. Rejects when the process cannot start. */
  spawn(launch: AcpLaunch, cwd: string): Promise<AgentStdio>;
}

// ---------------------------------------------------------------------------
// scripts
// ---------------------------------------------------------------------------

export type ScriptLabel = "setup" | "teardown";

/** A `.band/config.json` script prepared to run in a workspace terminal. */
export interface ScriptPlan {
  /** Shell line for `SpawnOptions.command` of a terminal in the workspace. */
  command: string;
  /** Resolves with the script's exit code. Never rejects. */
  exited: Promise<number>;
  /** Stops watching and removes the script's temp dir. Idempotent. */
  dispose(): void;
}

/** Where a workspace's `.band/config.json` lives. */
export interface ScriptWorkspace {
  projectPath: string;
  worktreePath: string;
}

export interface HostScripts {
  /**
   * The workspace's `setup` or `teardown` command as written in
   * `.band/config.json`, or `null` when it declares none.
   */
  command(workspace: ScriptWorkspace & { label: ScriptLabel }): Promise<string | null>;
  /**
   * Runs `script` in `cwd` without a terminal (the Windows path, through
   * `cmd.exe`). Resolves with its exit code, or `null` when `timeoutMs` passes.
   */
  runHidden(script: string, cwd: string, timeoutMs?: number): Promise<number | null>;
  /**
   * Reads the workspace's `.band/config.json` (worktree first, then the
   * project checkout) and prepares its `setup` or `teardown` script. Resolves
   * `null` when the config has no such script.
   */
  prepare(workspace: {
    projectPath: string;
    worktreePath: string;
    label: ScriptLabel;
  }): Promise<ScriptPlan | null>;
  /** Copies the project's `copyFiles` and `.worktreeinclude` files into the worktree. Returns the relative paths copied. */
  copyFiles(projectPath: string, worktreePath: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// agent environment
// ---------------------------------------------------------------------------

export interface AgentDescriptor {
  agentType: string;
  /** The definition's configured binary, if any. */
  command?: string;
}

export interface ClaudeDefaults {
  model: string | undefined;
  effort: string | undefined;
}

/** Flags read off a running Claude Code CLI's command line. */
export interface ClaudeCliArgs {
  /** `--settings` values, in order. */
  settings: string[];
  model?: string;
  effort?: string;
}

export interface InstallSkillsResult {
  /** Canonical SKILL.md paths that did not exist before the run. */
  written: string[];
  /** Canonical SKILL.md paths whose content differed and was overwritten. */
  updated: string[];
  /** Canonical SKILL.md paths whose content already matched. */
  unchanged: string[];
  /** Symlink paths created, one per agent and skill. */
  linked: string[];
  /** Symlink paths that already pointed at the shared directory. */
  alreadyLinked: string[];
  /** Per-agent paths the install left alone because something was in the way, as "path: reason". */
  conflicts: string[];
  /** Canonical SKILL.md paths skipped because the install could not run. */
  skipped: string[];
  /** Why the install could not run, when it could not. */
  warnings: string[];
}

export interface HooksStatus {
  /** Band's hook is present for every hook event. */
  installed: boolean;
  /** The settings also hold hooks that are not Band's. */
  other_hooks_exist: boolean;
}

export interface HostAgentEnv {
  /**
   * The model and effort Claude Code would use in `cwd` according to its
   * config files and environment. Without `cwd`, project files are skipped.
   * `cli` adds the flags of a running CLI.
   */
  claudeDefaults(cwd?: string, cli?: ClaudeCliArgs): Promise<ClaudeDefaults>;
  /**
   * The model and effort of the session's last main-thread assistant record,
   * when it was written at or after `since` (epoch ms). Empty values when the
   * transcript is missing or older.
   */
  reportedClaudeDefaults(opts: {
    cwd: string;
    sessionId: string;
    since?: number;
  }): Promise<ClaudeDefaults>;
  /**
   * The flags of the Claude Code CLI running `sessionId` under the adapter
   * process `adapterPid`, or null when there is no such process.
   */
  claudeCliArgs(adapterPid: number, sessionId: string): Promise<ClaudeCliArgs | null>;
  /** The newest Claude Code session id recorded for `cwd`, or null. */
  latestClaudeSession(cwd: string): Promise<string | null>;
  /** The usage reader for an agent, or `undefined` when it keeps no on-disk usage data. */
  usageReader(agent: AgentDescriptor): Promise<UsageReader | undefined>;
  /**
   * Installs Band's skills into the host's shared skills directory and links
   * each coding agent found on the host to it. `home` replaces the host's home
   * directory (tests only). A host that cannot run the install returns every
   * skill as `skipped` and says why in `warnings`.
   */
  installSkills(options?: { home?: string }): Promise<InstallSkillsResult>;
  /** Whether Band's hooks are in the host's Claude Code settings. */
  hooksStatus(): Promise<HooksStatus>;
  /** Installs Band's agent hooks into the host's Claude Code settings. Rejects when the host has no `band` CLI. */
  installHooks(): Promise<void>;
}

// ---------------------------------------------------------------------------
// relay
// ---------------------------------------------------------------------------

/** What a process started on the host may call on the hub. */
export interface RelayScope {
  workspaceId: string;
  /** The chat the process belongs to, when it is an agent behind a chat. */
  chatId?: string;
}

/** A credential for one process, with the environment that hands it over. */
export interface RelayGrant {
  /** `BAND_SERVER_URL` (the relay's address on the host) and `BAND_TOKEN`. */
  env: Record<string, string>;
  /** Ends the credential. Never rejects. */
  revoke(): Promise<void>;
}

export interface HostRelay {
  /**
   * Issues a token for one process and returns the environment to start it
   * with. Calls made with the token reach the hub through the host's relay,
   * limited to the host's own workspaces. Rejects when the host is offline.
   */
  issue(scope: RelayScope): Promise<RelayGrant>;
}
