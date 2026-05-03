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
  listModels?(agentId?: string): Promise<{ id: string; name: string; description?: string }[]>;

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
  ): Promise<WorkspaceDiff>;
  getWorkspaceDiffSummary?(workspaceId: string, diffMode?: DiffMode): Promise<WorkspaceDiffSummary>;
  getFileDiff?(
    workspaceId: string,
    filePath: string,
    mergeBase: string,
    contextLines?: number,
  ): Promise<FileDiffResult>;
  listWorkspaceFiles?(workspaceId: string, path: string): Promise<FileListResult>;
  getWorkspaceFile?(workspaceId: string, path: string): Promise<FileContentResult>;
  saveWorkspaceFile?(workspaceId: string, path: string, content: string): Promise<void>;

  /** Revert a single file to its original state, discarding all changes. */
  revertFile?(workspaceId: string, filePath: string, diffMode: string): Promise<void>;

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
