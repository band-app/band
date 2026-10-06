import type { UsageReader } from "@band-app/coding-agent";
import type { Environment, EnvironmentIssue } from "@band-app/environment";
import type { TerminalBackend } from "./pty";

/**
 * A machine that owns worktrees. Every git, file, process, PTY, search, LSP
 * and agent operation for a worktree goes through the worktree's host, so
 * the hub never touches a worker's disk directly.
 *
 * The hub resolves a host with `HostRegistry.hostFor(worktreeId)`. Today the
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
  /** Stdio MCP servers, which run on this host and speak JSON-RPC lines. */
  readonly mcp: HostMcp;
  /** A Chromium per worktree with its DevTools endpoint on loopback (plan step 7.3). */
  readonly browser: HostBrowser;
  /** Same interface the hub's terminal service already uses. */
  readonly pty: TerminalBackend;
  readonly scripts: HostScripts;
  /** Runs a binary on the host with `PATH` extended to the usual tool directories. */
  exec(bin: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  readonly agentEnv: HostAgentEnv;
  /** Working copies of the hub's context repos, under `<BAND_HOME>/context` on the host. */
  readonly context: HostContext;
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
  /** Directories worktrees may live under. Empty means unrestricted. */
  roots: string[];
  /** Tool versions found on the host (`node`, `git`). */
  versions: Record<string, string>;
  /**
   * Toolchain versions the host has on its PATH, as `x.y.z` (`node`, `python`,
   * `go`, `pnpm`, `uv`, `docker`, `git`). A tool that is not installed is left
   * out. A repo's `requires` in `.band/environment.json` is checked against it.
   */
  tools: Record<string, string>;
  capabilities: HostCapabilities;
  /**
   * Directories the host keeps for hub files that belong to worktrees
   * (chat uploads, files an agent shares). A remote host declares them, under
   * one of its roots. A local host leaves this out, and the hub uses its own
   * `BAND_HOME`.
   */
  dirs?: HostDirs;
}

export interface HostDirs {
  /** Chat uploads go in `<uploads>/<worktreeId>/`. */
  uploads: string;
  /** Files an agent shares go in `<shared>/<worktreeId>/`. */
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
  /** Path of the repo's main checkout. */
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
   * worktree, starting it in `root` if it isn't running. Every connection to
   * one worktree and language shares the server and receives all its output.
   * `output` ends when the server exits or the connection closes. Rejects when
   * `lang` has no server or the server cannot start.
   */
  connect(spec: { worktreeId: string; lang: string; root: string }): Promise<Duplex>;
  /**
   * Signals the worktree's language servers to stop. Resolves without waiting
   * for them to exit. Each connection's output ends once its server has.
   */
  killWorktree(worktreeId: string): Promise<void>;
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

/** What it takes to start a stdio MCP server (plan step 4.4). */
export interface McpStdioSpec {
  /** The hub's id for the server, for the worker's own bookkeeping. Not a path or a command. */
  serverId: string;
  command: string;
  args: string[];
  /** Merged over the host's environment. May hold secrets: held in memory, never logged or written. */
  env: Record<string, string>;
  /** Working directory. On a worker it must be inside the worker's roots. Defaults to the user's home. */
  cwd?: string;
}

/**
 * A running stdio MCP server. `stdout` ends when the process does or when the
 * link carrying it is lost. `kill` stops the process, and a process with no
 * traffic for the host's idle time is killed too.
 */
export interface McpStdio {
  pid: number | undefined;
  stdin: { write(chunk: Uint8Array | string): void; end(): void };
  stdout: Stream<Uint8Array>;
  kill(): void;
}

export interface HostMcp {
  /** Starts one server process. Rejects when it cannot start, or with `HostOfflineError` on a worker with no link. */
  openStdio(spec: McpStdioSpec): Promise<McpStdio>;
}

/** What it takes to start a worktree's Chromium. */
export interface BrowserOpenSpec {
  worktreeId: string;
  /** The user-data directory. The cookies and everything else of the worktree's profile live here. */
  profileDir?: string;
  /** Defaults to headless when the host has no display. */
  headless?: boolean;
}

export interface BrowserInfo {
  pid: number | undefined;
  /** The user-data directory in use on the host. */
  profileDir: string;
  headless: boolean;
  /** The DevTools port on the host's loopback. The hub never dials it, agents on the host may. */
  port: number;
}

/** A CDP connection to a worktree's browser. One message is one JSON text. */
export interface BrowserCdp {
  send(message: string): void;
  messages: Stream<string>;
  close(): void;
}

export interface HostBrowser {
  /** Starts the worktree's Chromium, or returns the one that runs. Rejects when no Chromium is installed. */
  open(spec: BrowserOpenSpec): Promise<BrowserInfo>;
  /** Opens a CDP connection to the browser-level endpoint of a running browser. Rejects when none runs. */
  connect(worktreeId: string): Promise<BrowserCdp>;
  /** Closes the browser cleanly so cookies are written, and kills it if it does not exit. A no-op when none runs. */
  close(worktreeId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// scripts
// ---------------------------------------------------------------------------

export type ScriptLabel = "setup" | "teardown";

/** A `.band/config.json` script prepared to run in a worktree terminal. */
export interface ScriptPlan {
  /** Shell line for `SpawnOptions.command` of a terminal in the worktree. */
  command: string;
  /** Resolves with the script's exit code. Never rejects. */
  exited: Promise<number>;
  /** Stops watching and removes the script's temp dir. Idempotent. */
  dispose(): void;
}

/** Where a worktree's `.band/config.json` lives. */
export interface ScriptWorktree {
  repoPath: string;
  worktreePath: string;
}

export interface HostScripts {
  /**
   * The worktree's `setup` or `teardown` command, or `null` when it declares
   * none. A valid `.band/environment.json` supplies it first (setup is its
   * `install` then `start`, teardown is its `teardown`). Otherwise it is read
   * from `.band/config.json`.
   */
  command(worktree: ScriptWorktree & { label: ScriptLabel }): Promise<string | null>;
  /**
   * Runs `script` in `cwd` without a terminal (the Windows path, through
   * `cmd.exe`). Resolves with its exit code, or `null` when `timeoutMs` passes.
   */
  runHidden(script: string, cwd: string, timeoutMs?: number): Promise<number | null>;
  /**
   * Reads the worktree's `.band/config.json` (worktree first, then the
   * repo checkout) and prepares its `setup` or `teardown` script. Resolves
   * `null` when the config has no such script.
   */
  prepare(worktree: {
    repoPath: string;
    worktreePath: string;
    label: ScriptLabel;
  }): Promise<ScriptPlan | null>;
  /** Copies the repo's `copyFiles` and `.worktreeinclude` files into the worktree. Returns the relative paths copied. */
  copyFiles(repoPath: string, worktreePath: string): Promise<string[]>;
  /**
   * Reads and validates the worktree's `.band/environment.json` (worktree
   * first, then the repo checkout). Never rejects: a missing file gives
   * `source: null`, and a bad one gives its `issues`.
   */
  environment(worktree: ScriptWorktree): Promise<EnvironmentReport>;
}

/** What a host found when it read a worktree's `.band/environment.json`. */
export interface EnvironmentReport {
  /** The file that was read, or `null` when the worktree has none. */
  source: string | null;
  /** The parsed file, or `null` when there is none or it has problems. */
  environment: Environment | null;
  issues: EnvironmentIssue[];
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
   * config files and environment. Without `cwd`, repo files are skipped.
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
  worktreeId: string;
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
   * limited to the host's own worktrees. Rejects when the host is offline.
   */
  issue(scope: RelayScope): Promise<RelayGrant>;
}

// ---------------------------------------------------------------------------
// Context sync
// ---------------------------------------------------------------------------

/** One context repo to sync. A project context lives at `projects/<name>`, the user context at `user`. */
export interface ContextSpec {
  name: string;
  kind: "user" | "project";
}

/**
 * What the hub knows about its vault secrets, enough to spot one in a file and
 * hard to recover for a long secret. A secret shorter than 12 characters is left out.
 */
export interface SecretFingerprint {
  length: number;
  /** The first 4 characters. */
  prefix: string;
  /** SHA-256 of the whole value, hex. */
  sha256: string;
}

export interface ContextPullRequest {
  contexts: ContextSpec[];
  /** How long one context may take. On a timeout the copy on disk stays as it was. */
  timeoutMs?: number;
}

export type ContextPullStatus =
  /** Cloned or moved forward. */
  | "updated"
  /** Already at the hub's head. */
  | "current"
  /** The hub did not answer in time or failed. A copy from an earlier pull is still there. */
  | "stale"
  /** The hub did not answer and no copy exists. */
  | "missing"
  /** The hub refused this host (labels, token). */
  | "denied";

export interface ContextPullResult {
  name: string;
  status: ContextPullStatus;
  /** Why a pull was stale, missing or denied. */
  error?: string;
}

export interface ContextPushRequest {
  contexts: ContextSpec[];
  /** The commit message of each pushed change. */
  message: string;
  /** Names conflict copies (`file.conflict-<host>-<ts>`). */
  hostLabel: string;
  secrets: SecretFingerprint[];
}

export interface ContextConflict {
  path: string;
  /** Where this host's version was kept. */
  keptAs: string;
}

export interface ContextFinding {
  path: string;
  /** The pattern that matched, such as `github-token`. Never the value. */
  rule: string;
  line: number;
}

export type ContextPushStatus =
  /** Changes committed and pushed. */
  | "pushed"
  /** Nothing to push. */
  | "clean"
  /** The hub refused the push or did not answer. The commit stays local and goes with the next push. */
  | "failed";

export interface ContextPushResult {
  name: string;
  status: ContextPushStatus;
  conflicts: ContextConflict[];
  /** Files the redaction scan held back. They are in `quarantine`, not pushed. */
  blocked: ContextFinding[];
  /** Directory on the host holding the files the scan held back. */
  quarantine?: string;
  error?: string;
}

export interface ContextPreambleRequest {
  /** The contexts to read, as `pull` takes them. A project context's `notes.md` is included. */
  contexts: ContextSpec[];
  /** Total lines the preamble may take. The host default is 200. */
  maxLines?: number;
}

export interface ContextPreamble {
  /** The text for the agent's instructions. Empty when the working copies hold nothing to say. */
  text: string;
  /**
   * `memory/` inside the first project context's working copy, created on the host. Claude
   * Code's auto memory goes there, so the next push carries it to the hub. Null without a
   * project context.
   */
  memoryDir: string | null;
}

export interface HostContext {
  /** Reads the always-loaded files and an index of the working copies, within a line budget. */
  preamble(request: ContextPreambleRequest): Promise<ContextPreamble>;
  /** Brings each context's working copy up to the hub's head. Never rejects for a hub failure. */
  pull(request: ContextPullRequest): Promise<ContextPullResult[]>;
  /** Commits what changed in each working copy, scans it, rebases on the hub's head and pushes. */
  push(request: ContextPushRequest): Promise<ContextPushResult[]>;
}
