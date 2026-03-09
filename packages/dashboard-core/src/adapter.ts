import type {
  CIStatus,
  CliStatus,
  FileContentResult,
  FileListResult,
  GitStatus,
  HooksStatus,
  ProjectInfo,
  Settings,
  WorkspaceDiff,
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

  // Workspaces
  createWorkspace(project: string, branch: string, base?: string, prompt?: string): Promise<void>;
  removeWorkspace(project: string, branch: string): Promise<void>;
  openWorkspace(workspaceId: string): Promise<void>;
  runScript(path: string, scriptType: string): Promise<void>;

  // Settings
  getSettings(): Promise<Settings>;
  updateSettings(settings: Settings): Promise<void>;

  // Event subscriptions (return unsubscribe fn)
  subscribeAgentStatus(
    onUpdate: (status: WorkspaceStatus) => void,
    onRemove: (workspaceId: string) => void,
  ): Unsubscribe;

  subscribeActiveWorkspace(onChange: (workspaceId: string | null) => void): Unsubscribe;

  subscribeBranchStatus(
    onGit: (workspaceId: string, git: GitStatus) => void,
    onCI: (workspaceId: string, ci: CIStatus) => void,
  ): Unsubscribe;

  // Hooks
  checkHooks(): Promise<HooksStatus>;
  installHooks(): Promise<void>;

  // CLI
  checkCli(): Promise<CliStatus>;
  installCli(): Promise<void>;

  // Code browsing (optional)
  getWorkspaceDiff?(workspaceId: string): Promise<WorkspaceDiff>;
  listWorkspaceFiles?(workspaceId: string, path: string): Promise<FileListResult>;
  getWorkspaceFile?(workspaceId: string, path: string): Promise<FileContentResult>;
}

export interface PlatformCapabilities {
  copyPath?: boolean;
  revealInFinder?(path: string): Promise<void>;
  pickFolder?(): Promise<string | null>;
  openUrl?(url: string): Promise<void>;
  getWorkspaceHref?(workspaceId: string): string | undefined;
}
