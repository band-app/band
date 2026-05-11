import type {
  CIStatus,
  CliStatus,
  ContentSearchMatch,
  DiffMode,
  FileContentResult,
  FileDiffResult,
  FileListResult,
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

  // Workspaces
  createWorkspace(project: string, branch: string, base?: string, prompt?: string): Promise<void>;
  removeWorkspace(project: string, branch: string): Promise<void>;
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

  // Hooks
  checkHooks(): Promise<HooksStatus>;
  installHooks(): Promise<void>;

  // CLI
  checkCli(): Promise<CliStatus>;
  installCli(opts?: { allowPrompt?: boolean }): Promise<void>;

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
  openUrl?(url: string): Promise<void>;
  getWorkspaceHref?(workspaceId: string): string | undefined;
  /** Optional navigate function for client-side routing (avoids full page reload). */
  navigate?(href: string): void;
}
