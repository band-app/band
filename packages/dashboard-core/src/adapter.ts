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
  ProjectInfo,
  Settings,
  WorkspaceDiff,
  WorkspaceDiffSummary,
  WorkspaceStatus,
} from "./types";

export type Unsubscribe = () => void;

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

  // Workspaces
  createWorkspace(project: string, branch: string, base?: string, prompt?: string): Promise<void>;
  removeWorkspace(project: string, branch: string): Promise<void>;
  setWorkspacePinned(project: string, branch: string, pinned: boolean): Promise<void>;
  runScript(path: string, scriptType: string): Promise<void>;
  gitPull(project: string, branch: string): Promise<void>;
  gitPush(project: string, branch: string): Promise<void>;

  // Settings
  getSettings(): Promise<Settings>;
  updateSettings(settings: Settings): Promise<void>;

  // Models (for agent configuration)
  listModels?(
    agentId?: string,
  ): Promise<{ id: string; name: string; description?: string; contextWindow?: number }[]>;

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

  // Background app-update banner (desktop only — the web adapter omits these
  // and the hook short-circuits to "none" so the banner never appears in a
  // plain browser tab).
  getUpdateStatus?(): Promise<{ version: string } | null>;
  installUpdate?(): Promise<void>;
  subscribeUpdateStatus?(cb: (pending: { version: string } | null) => void): Unsubscribe;

  // Agent status (optional)
  clearNeedsAttention?(workspaceId: string): Promise<void>;

  // Code browsing (optional)
  getWorkspaceDiff?(
    workspaceId: string,
    contextLines?: number,
    diffMode?: DiffMode,
    compareBranch?: string,
  ): Promise<WorkspaceDiff>;
  getWorkspaceDiffSummary?(
    workspaceId: string,
    diffMode?: DiffMode,
    compareBranch?: string,
  ): Promise<WorkspaceDiffSummary>;
  getFileDiff?(
    workspaceId: string,
    filePath: string,
    mergeBase: string,
    contextLines?: number,
  ): Promise<FileDiffResult>;
  listWorkspaceBranches?(
    workspaceId: string,
  ): Promise<{ branches: string[]; defaultBranch: string; headBranch: string }>;
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

  /**
   * Run `git pull --rebase` inside the workspace's worktree. Throws on
   * failure (network errors, merge conflicts, etc).
   */
  gitPullWorkspace?(workspaceId: string): Promise<void>;

  /**
   * Run `git push` inside the workspace's worktree, automatically setting
   * upstream on first push. Throws on failure.
   */
  gitPushWorkspace?(workspaceId: string): Promise<void>;

  /**
   * Stage every change (tracked + untracked) and create a commit on the
   * workspace's current branch. Throws on failure (e.g. nothing to commit,
   * pre-commit hook rejection).
   */
  gitCommitWorkspace?(workspaceId: string, message: string, body?: string): Promise<void>;

  /**
   * Ask the user's default coding agent to summarise the workspace's pending
   * changes into a commit message. Returns the proposed subject/body plus
   * the human-readable agent label so the UI can attribute the suggestion.
   */
  generateCommitMessage?(
    workspaceId: string,
  ): Promise<{ message: string; body: string; agentLabel: string }>;

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
  openUrl?(url: string): Promise<void>;
  getWorkspaceHref?(workspaceId: string): string | undefined;
  /** Optional navigate function for client-side routing (avoids full page reload). */
  navigate?(href: string): void;
}
