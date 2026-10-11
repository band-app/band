import type { AgentMode } from "@band-app/shared/agent-sessions";
import type { GitOpResult } from "@band-app/shared/git-op-result";
import type {
  BrowserProfileInfo,
  CIStatus,
  CliStatus,
  ContentSearchMatch,
  DiffMode,
  FileContentResult,
  FileListResult,
  FormatFileResult,
  GitStatus,
  HooksStatus,
  ListWorktreeBranchesResult,
  RepoInfo,
  Settings,
  WorktreeDiff,
  WorktreeStatus,
} from "./types";

export type Unsubscribe = () => void;

/**
 * Auto-update status from the desktop main process. Structural copy of
 * `UpdateStatus` in `apps/desktop/src/shared/update-status.ts`; change both
 * together. `userInitiated` marks a check the user asked for: the toast
 * shows checking, up-to-date and check errors only for those.
 */
export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking"; userInitiated: boolean }
  | { state: "up-to-date"; currentVersion: string; userInitiated: boolean }
  | ({ state: "available" } & UpdateRelease)
  | ({ state: "downloading"; percent: number } & UpdateRelease)
  | ({ state: "downloaded" } & UpdateRelease)
  | { state: "error"; message: string; phase: "check" | "download"; userInitiated: boolean };

export interface UpdateRelease {
  version: string;
  currentVersion: string;
  releaseName: string | null;
  releaseNotes: string | null;
  releaseUrl: string;
}

export interface DashboardAdapter {
  // Repos
  listRepos(): Promise<RepoInfo[]>;
  removeRepo(name: string): Promise<void>;
  reorderRepos(names: string[]): Promise<void>;
  updateRepoLabel(name: string, label: string | null): Promise<void>;
  gitInit(path: string): Promise<void>;
  /**
   * Promote a "plain" repo to "git": runs `git init` in the repo
   * folder and flips the repo's kind. Server-side rejects if the
   * repo is already a git repo. After promotion, all branch/PR/CI
   * features become available for the existing implicit worktree.
   */
  promoteRepoToGit?(name: string): Promise<void>;

  // Worktrees. `name` is the immutable worktree identity (the initial
  // branch), not the live git branch — see `WorktreeInfo.name`. `create`
  // still takes `branch` because it names a *new* branch (which seeds `name`).
  // `agentMode` is how the prompt's agent is displayed (issue #682): this
  // device's mode, or the server default when omitted.
  createWorktree(
    repo: string,
    branch: string,
    base?: string,
    prompt?: string,
    agentMode?: AgentMode,
    host?: { hostId: string; hostRepoPath?: string },
  ): Promise<{ hostId?: string }>;
  removeWorktree(repo: string, name: string, hostId?: string): Promise<void>;
  setWorktreePinned(repo: string, name: string, pinned: boolean, hostId?: string): Promise<void>;
  runScript(path: string, scriptType: string): Promise<void>;
  gitPull(repo: string, name: string, hostId?: string): Promise<GitOpResult>;
  gitPush(repo: string, name: string, hostId?: string): Promise<GitOpResult>;

  // Browser profiles (optional). Profiles hold the browser pane's cookies;
  // each repo remembers which one its new tabs open with.
  listBrowserProfiles?(): Promise<BrowserProfileInfo[]>;
  /** Delete a profile. The desktop adapter also wipes its cookies from disk. */
  removeBrowserProfile?(profileId: string): Promise<void>;
  /** `repoName → profileId` for every repo with a non-Default profile. */
  listRepoBrowserProfiles?(): Promise<Record<string, string>>;
  /** `profileId: null` resets the repo to the Default profile. */
  setRepoBrowserProfile?(repoName: string, profileId: string | null): Promise<void>;

  // Settings
  getSettings(): Promise<Settings>;
  updateSettings(settings: Settings): Promise<void>;

  // Models (for agent configuration)
  listModels?(agentId?: string): Promise<{
    models: { id: string; name: string; description?: string; contextWindow?: number }[];
    defaultModel?: string;
    updatedAt?: number;
  }>;

  /**
   * Combined picker payload — every configured agent's cached models in a
   * single round-trip. Callers that need the whole picker shape (the
   * Settings dialog's per-agent accordion, the chat pane's model
   * dropdown) should prefer this over fanning out `listModels` per agent:
   * one HTTP request + one settings.json read on the server instead of N.
   */
  listAllModels?(): Promise<{
    agents: {
      agentId: string;
      agentType: string;
      agentLabel: string;
      models: { id: string; name: string; description?: string; contextWindow?: number }[];
      updatedAt?: number;
      defaultModel?: string;
    }[];
    defaultAgentId: string;
  }>;

  /**
   * Force the server to re-fetch the model list for one agent (or every
   * configured agent when `agentId` is omitted) from its SDK / CLI and
   * persist the result into `~/.band/settings.json`. Powers the
   * Settings UI's "Refresh models" button. Returns the refreshed lists
   * per agent so the UI can update without a follow-up `listModels`
   * round-trip.
   */
  refreshModels?(
    agentId?: string,
    hostId?: string,
  ): Promise<{
    results: {
      agentId: string;
      models: { id: string; name: string; description?: string; contextWindow?: number }[];
      updatedAt: number;
      error?: string;
    }[];
  }>;

  // Event subscriptions (return unsubscribe fn)
  subscribeAgentStatus(
    onSnapshot: (statuses: WorktreeStatus[]) => void,
    onUpdate: (status: WorktreeStatus) => void,
    onRemove: (worktreeId: string) => void,
  ): Unsubscribe;

  subscribeBranchStatus(
    onGit: (worktreeId: string, git: GitStatus) => void,
    onCI: (worktreeId: string, ci: CIStatus) => void,
  ): Unsubscribe;

  /** Subscribe to raw status stream events (shared SSE connection). */
  subscribeStatusEvents(handler: (event: Record<string, unknown>) => void): Unsubscribe;

  /**
   * Tell the server which worktree the user is currently looking at. The
   * value is process-local on the server (resets on restart) and is read by
   * the `band open` CLI command so users can fire a file at "wherever I'm
   * focused right now" without naming the worktree explicitly.
   *
   * Pass `null` when no worktree is active (e.g. the user is on the
   * index route). Implementations may debounce or short-circuit when the
   * value hasn't changed.
   */
  setActiveWorktree(worktreeId: string | null): Promise<void>;

  /**
   * Subscribe to external file-system changes inside a worktree. The
   * server emits one event per affected parent directory (worktree-
   * relative path; "" for the root). The FileBrowser uses this to
   * invalidate / refetch directory listings when files are touched by the
   * agent, a terminal, the IDE, or drag-and-drop.
   *
   * Optional, matching the rest of the code-browsing methods on this
   * interface. Adapters that omit it silently disable FileBrowser
   * auto-refresh — the tree will only update on internal Band mutations
   * (create/delete/rename/paste), not on external file-system changes
   * (see issue #384).
   */
  subscribeFileChanges?(worktreeId: string, handler: (path: string) => void): Unsubscribe;

  // Hooks
  checkHooks(): Promise<HooksStatus>;
  installHooks(): Promise<void>;

  // CLI
  checkCli(): Promise<CliStatus>;
  installCli(opts?: { allowPrompt?: boolean }): Promise<void>;

  // App-update toast (desktop only). The web adapter omits these, so a plain
  // browser tab never shows the toast. The desktop main process runs the
  // checks; the action methods resolve when a step starts, and its progress
  // and result arrive through `subscribeUpdateStatus`.
  getUpdateStatus?(): Promise<UpdateStatus>;
  subscribeUpdateStatus?(cb: (status: UpdateStatus) => void): Unsubscribe;
  checkForUpdates?(): Promise<void>;
  downloadUpdate?(): Promise<void>;
  restartToUpdate?(): Promise<void>;
  dismissUpdate?(): Promise<void>;

  // Agent status (optional)
  clearNeedsAttention?(worktreeId: string): Promise<void>;
  /** Re-read the worktree's git status now; the result arrives on the status stream. */
  refreshBranchStatus?(worktreeId: string): Promise<void>;

  // Code browsing (optional)
  getWorktreeDiff?(
    worktreeId: string,
    contextLines?: number,
    diffMode?: DiffMode,
    compareBranch?: string,
  ): Promise<WorktreeDiff>;
  /** Local and remote branches matching `query`, best matches first, at most
   *  `limit` of them. `truncated` is set when more matched. */
  listWorktreeBranches?(
    worktreeId: string,
    options?: { query?: string; limit?: number },
  ): Promise<ListWorktreeBranchesResult>;
  listWorktreeFiles?(worktreeId: string, path: string): Promise<FileListResult>;
  getWorktreeFile?(worktreeId: string, path: string): Promise<FileContentResult>;
  saveWorktreeFile?(worktreeId: string, path: string, content: string): Promise<void>;

  /**
   * Read a file by absolute filesystem path — used by the editor's
   * "Open File…" action for files that sit outside any registered
   * worktree root. The server-side procedure bypasses the worktree
   * containment check; authentication still flows through the same
   * band_token cookie used by every other tRPC call.
   */
  readExternalFile?(absolutePath: string): Promise<FileContentResult>;

  /**
   * Resolve an absolute (or worktree-relative) path against a worktree:
   * does it exist, is it a regular file, and does it live inside the
   * worktree (→ `worktreeRelativePath`) or outside it (→ `external`)? Used
   * by Quick Open to decide whether a pasted / terminal-link path opens as a
   * normal worktree file or an external tab.
   *
   * Resolves even when the path doesn't exist on disk (reports
   * `{ exists: false }`); may REJECT when `worktreeId` is unknown.
   */
  resolveWorktreePath?(
    worktreeId: string,
    path: string,
  ): Promise<{
    exists: boolean;
    isFile: boolean;
    external: boolean;
    worktreeRelativePath: string | null;
  }>;

  /** Write a file by absolute filesystem path. Mirror of `saveWorktreeFile`
   *  for external files. */
  saveExternalFile?(absolutePath: string, content: string): Promise<void>;

  /**
   * Format `content` using Prettier as if it were the file at `filePath`
   * inside `worktreeId`. Pure function — the server doesn't read or write
   * the file. Returns `{ skipped: true, reason }` when Prettier has no
   * parser for the file's extension (or it's covered by `.prettierignore`).
   * The caller is responsible for applying the returned `formatted` string
   * back to its editor and for persisting the result via
   * `saveWorktreeFile` when the user explicitly saves.
   */
  formatWorktreeFile?(
    worktreeId: string,
    filePath: string,
    content: string,
  ): Promise<FormatFileResult>;

  /**
   * Create a new file at the given worktree-relative path. The file's
   * parent directory must already exist. Throws if the path already
   * exists. `content` defaults to an empty string.
   */
  createWorktreeFile?(worktreeId: string, path: string, content?: string): Promise<void>;

  /**
   * Create a new directory at the given worktree-relative path. The
   * directory's parent must already exist. Throws if the path already
   * exists.
   */
  createWorktreeDirectory?(worktreeId: string, path: string): Promise<void>;

  /**
   * Delete a file or directory at the given worktree-relative path.
   * Directories are removed recursively. Throws if the path doesn't
   * exist or refers to a protected location (e.g. `.git`).
   */
  deleteWorktreePath?(worktreeId: string, path: string): Promise<{ kind: "file" | "directory" }>;

  /**
   * Rename or move a file/directory inside the worktree. `fromPath`
   * and `toPath` are both worktree-relative. The destination must not
   * already exist and its parent directory must exist.
   */
  renameWorktreePath?(
    worktreeId: string,
    fromPath: string,
    toPath: string,
  ): Promise<{ kind: "file" | "directory" }>;

  /**
   * Recursively copy a file/directory inside the worktree. `fromPath`
   * and `toPath` are both worktree-relative. The destination must not
   * already exist and its parent directory must. Directories may not be
   * copied into themselves.
   */
  copyWorktreePath?(
    worktreeId: string,
    fromPath: string,
    toPath: string,
  ): Promise<{ kind: "file" | "directory" }>;

  /** Get a URL for raw file content (images, PDFs, etc.) */
  getWorktreeFileUrl?(worktreeId: string, path: string): string;

  // Search (optional)
  searchWorktreeFiles?(
    worktreeId: string,
    query: string,
    limit?: number,
  ): Promise<{ files: string[] }>;
  searchWorktreeContent?(
    worktreeId: string,
    query: string,
    options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean; limit?: number },
  ): Promise<{ results: ContentSearchMatch[] }>;
}

export interface PlatformCapabilities {
  copyPath?: boolean;
  revealInFinder?(path: string): Promise<void>;
  pickFolder?(): Promise<string | null>;
  /**
   * Open the OS file picker and resolve with the chosen absolute file path
   * (or `null` when the user cancels). Defined only when the renderer is
   * running inside the Electron desktop shell — plain browser tabs cannot
   * trigger native file dialogs without a user-initiated `<input type="file">`
   * click and have no way to obtain the file's absolute path anyway, so
   * callers must gate their UI on this capability being present.
   */
  pickFile?(): Promise<string | null>;
  /**
   * Open the OS "Save As" picker, persist `content` to the chosen path,
   * and resolve with the absolute path (or `null` when the user cancels).
   * Defined only when the renderer is running inside the Electron shell —
   * the web build cannot write to an arbitrary filesystem location.
   *
   * Backs the editor's "Save untitled tab" flow. `defaultName` seeds the
   * dialog's filename field (e.g. "Untitled-1.txt"); `defaultPath` seeds
   * the starting directory (e.g. the active worktree root).
   *
   * Bundling the dialog + write into a single capability keeps the
   * filesystem trust boundary inside the desktop shell — the renderer
   * never receives a writable file handle.
   */
  pickSaveFile?(args: {
    content: string;
    defaultName?: string;
    defaultPath?: string;
  }): Promise<string | null>;
  openUrl?(url: string): Promise<void>;
  /**
   * True when the window can show the desktop through the repo-list
   * sidebar: the Electron desktop shell on macOS, whose window has a
   * vibrancy layer. Gates the "Translucent sidebar" setting.
   */
  translucentSidebar?: boolean;
  getWorktreeHref?(worktreeId: string): string | undefined;
  /** Optional navigate function for client-side routing (avoids full page reload). */
  navigate?(href: string): void;
}
