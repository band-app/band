import type {
  CIStatus,
  CliStatus,
  ContentSearchMatch,
  DiffMode,
  FileContentResult,
  FileDiffResult,
  FileListResult,
  FormatFileResult,
  GitStatus,
  HooksStatus,
  ListWorkspaceBranchesResult,
  ProjectInfo,
  Settings,
  WorkspaceDiff,
  WorkspaceStatus,
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
  // Projects
  listProjects(): Promise<ProjectInfo[]>;
  addProject(path: string, label?: string): Promise<void>;
  removeProject(name: string): Promise<void>;
  reorderProjects(names: string[]): Promise<void>;
  updateProjectLabel(name: string, label: string | null): Promise<void>;
  checkPath(path: string): Promise<{ isGitRepo: boolean }>;
  gitInit(path: string): Promise<void>;
  /**
   * Promote a "plain" project to "git": runs `git init` in the project
   * folder and flips the project's kind. Server-side rejects if the
   * project is already a git project. After promotion, all branch/PR/CI
   * features become available for the existing implicit workspace.
   */
  promoteProjectToGit?(name: string): Promise<void>;

  // Workspaces. `name` is the immutable workspace identity (the initial
  // branch), not the live git branch — see `WorktreeInfo.name`. `create`
  // still takes `branch` because it names a *new* branch (which seeds `name`).
  createWorkspace(project: string, branch: string, base?: string, prompt?: string): Promise<void>;
  removeWorkspace(project: string, name: string): Promise<void>;
  setWorkspacePinned(project: string, name: string, pinned: boolean): Promise<void>;
  runScript(path: string, scriptType: string): Promise<void>;
  gitPull(project: string, name: string): Promise<void>;
  gitPush(project: string, name: string): Promise<void>;

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
  refreshModels?(agentId?: string): Promise<{
    results: {
      agentId: string;
      models: { id: string; name: string; description?: string; contextWindow?: number }[];
      updatedAt: number;
      error?: string;
    }[];
  }>;

  // Event subscriptions (return unsubscribe fn)
  subscribeAgentStatus(
    onSnapshot: (statuses: WorkspaceStatus[]) => void,
    onUpdate: (status: WorkspaceStatus) => void,
    onRemove: (workspaceId: string) => void,
  ): Unsubscribe;

  subscribeBranchStatus(
    onGit: (workspaceId: string, git: GitStatus) => void,
    onCI: (workspaceId: string, ci: CIStatus) => void,
  ): Unsubscribe;

  /** Subscribe to raw status stream events (shared SSE connection). */
  subscribeStatusEvents(handler: (event: Record<string, unknown>) => void): Unsubscribe;

  /**
   * Tell the server which workspace the user is currently looking at. The
   * value is process-local on the server (resets on restart) and is read by
   * the `band open` CLI command so users can fire a file at "wherever I'm
   * focused right now" without naming the workspace explicitly.
   *
   * Pass `null` when no workspace is active (e.g. the user is on the
   * index route). Implementations may debounce or short-circuit when the
   * value hasn't changed.
   */
  setActiveWorkspace(workspaceId: string | null): Promise<void>;

  /**
   * Subscribe to external file-system changes inside a workspace. The
   * server emits one event per affected parent directory (workspace-
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
  subscribeFileChanges?(workspaceId: string, handler: (path: string) => void): Unsubscribe;

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
  clearNeedsAttention?(workspaceId: string): Promise<void>;

  // Code browsing (optional)
  getWorkspaceDiff?(
    workspaceId: string,
    contextLines?: number,
    diffMode?: DiffMode,
    compareBranch?: string,
  ): Promise<WorkspaceDiff>;
  getFileDiff?(
    workspaceId: string,
    filePath: string,
    mergeBase: string,
    contextLines?: number,
  ): Promise<FileDiffResult>;
  /** Local and remote branches matching `query`, best matches first, at most
   *  `limit` of them. `truncated` is set when more matched. */
  listWorkspaceBranches?(
    workspaceId: string,
    options?: { query?: string; limit?: number },
  ): Promise<ListWorkspaceBranchesResult>;
  listWorkspaceFiles?(workspaceId: string, path: string): Promise<FileListResult>;
  getWorkspaceFile?(workspaceId: string, path: string): Promise<FileContentResult>;
  saveWorkspaceFile?(workspaceId: string, path: string, content: string): Promise<void>;

  /**
   * Read a file by absolute filesystem path — used by the editor's
   * "Open File…" action for files that sit outside any registered
   * workspace root. The server-side procedure bypasses the workspace
   * containment check; authentication still flows through the same
   * band_token cookie used by every other tRPC call.
   */
  readExternalFile?(absolutePath: string): Promise<FileContentResult>;

  /**
   * Resolve an absolute (or workspace-relative) path against a workspace:
   * does it exist, is it a regular file, and does it live inside the
   * worktree (→ `workspaceRelativePath`) or outside it (→ `external`)? Used
   * by Quick Open to decide whether a pasted / terminal-link path opens as a
   * normal workspace file or an external tab.
   *
   * Resolves even when the path doesn't exist on disk (reports
   * `{ exists: false }`); may REJECT when `workspaceId` is unknown.
   */
  resolveWorkspacePath?(
    workspaceId: string,
    path: string,
  ): Promise<{
    exists: boolean;
    isFile: boolean;
    external: boolean;
    workspaceRelativePath: string | null;
  }>;

  /** Write a file by absolute filesystem path. Mirror of `saveWorkspaceFile`
   *  for external files. */
  saveExternalFile?(absolutePath: string, content: string): Promise<void>;

  /**
   * Format `content` using Prettier as if it were the file at `filePath`
   * inside `workspaceId`. Pure function — the server doesn't read or write
   * the file. Returns `{ skipped: true, reason }` when Prettier has no
   * parser for the file's extension (or it's covered by `.prettierignore`).
   * The caller is responsible for applying the returned `formatted` string
   * back to its editor and for persisting the result via
   * `saveWorkspaceFile` when the user explicitly saves.
   */
  formatWorkspaceFile?(
    workspaceId: string,
    filePath: string,
    content: string,
  ): Promise<FormatFileResult>;

  /**
   * Create a new file at the given workspace-relative path. The file's
   * parent directory must already exist. Throws if the path already
   * exists. `content` defaults to an empty string.
   */
  createWorkspaceFile?(workspaceId: string, path: string, content?: string): Promise<void>;

  /**
   * Create a new directory at the given workspace-relative path. The
   * directory's parent must already exist. Throws if the path already
   * exists.
   */
  createWorkspaceDirectory?(workspaceId: string, path: string): Promise<void>;

  /**
   * Delete a file or directory at the given workspace-relative path.
   * Directories are removed recursively. Throws if the path doesn't
   * exist or refers to a protected location (e.g. `.git`).
   */
  deleteWorkspacePath?(workspaceId: string, path: string): Promise<{ kind: "file" | "directory" }>;

  /**
   * Rename or move a file/directory inside the workspace. `fromPath`
   * and `toPath` are both workspace-relative. The destination must not
   * already exist and its parent directory must exist.
   */
  renameWorkspacePath?(
    workspaceId: string,
    fromPath: string,
    toPath: string,
  ): Promise<{ kind: "file" | "directory" }>;

  /**
   * Recursively copy a file/directory inside the workspace. `fromPath`
   * and `toPath` are both workspace-relative. The destination must not
   * already exist and its parent directory must. Directories may not be
   * copied into themselves.
   */
  copyWorkspacePath?(
    workspaceId: string,
    fromPath: string,
    toPath: string,
  ): Promise<{ kind: "file" | "directory" }>;

  /** Revert a single file to its original state, discarding all changes. */
  revertFile?(
    workspaceId: string,
    filePath: string,
    diffMode: DiffMode,
    compareBranch?: string,
  ): Promise<void>;

  /** Get a URL for raw file content (images, PDFs, etc.) */
  getWorkspaceFileUrl?(workspaceId: string, path: string): string;

  // Search (optional)
  searchWorkspaceFiles?(
    workspaceId: string,
    query: string,
    limit?: number,
  ): Promise<{ files: string[] }>;
  searchWorkspaceContent?(
    workspaceId: string,
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
   * the starting directory (e.g. the active workspace root).
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
   * True when the window can show the desktop through the project-list
   * sidebar: the Electron desktop shell on macOS, whose window has a
   * vibrancy layer. Gates the "Translucent sidebar" setting.
   */
  translucentSidebar?: boolean;
  getWorkspaceHref?(workspaceId: string): string | undefined;
  /** Optional navigate function for client-side routing (avoids full page reload). */
  navigate?(href: string): void;
}
