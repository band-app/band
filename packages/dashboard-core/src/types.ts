export type AgentStatusType = "working" | "needs_attention" | "waiting";

export interface AgentInfo {
  name: string;
  status: AgentStatusType;
  lastActivity: string;
}

export interface WorkspaceStatus {
  workspaceId: string;
  project: string;
  branch: string;
  worktreePath: string;
  ide: string;
  agent?: AgentInfo;
}

export interface ProjectInfo {
  name: string;
  path: string;
  defaultBranch: string;
  worktrees: WorktreeInfo[];
  label?: string;
}

export interface WorktreeInfo {
  branch: string;
  path: string;
  head?: string;
  hasSetup?: boolean;
  hasTeardown?: boolean;
}

export type GitSyncState = "synced" | "ahead" | "behind" | "diverged";

export interface GitStatus {
  dirty: boolean;
  conflict: boolean;
  ahead: number;
  behind: number;
  sync_state: GitSyncState;
}

export type CIState =
  | "none"
  | "pending"
  | "running"
  | "success"
  | "failure"
  | "cancelled"
  | "merged";

export interface CIStatus {
  state: CIState;
  url?: string;
}

export interface WorkspaceBranchStatus {
  git: GitStatus;
  ci: CIStatus;
}

export type SetupState = "running" | "completed" | "failed";

export interface SetupStatus {
  state: SetupState;
  error?: string;
}

export type AppType = "vscode" | "zed" | "iterm" | "chrome";

export interface VsCodeAppConfig {
  type: "vscode";
  size?: number;
  terminals?: {
    name: string;
    command: string;
    split?: "horizontal" | "vertical";
    agentType?: "claude-code";
  }[];
}

export interface ZedAppConfig {
  type: "zed";
  size?: number;
}

export interface ITermAppConfig {
  type: "iterm";
  size?: number;
  commands?: {
    name?: string;
    command: string;
    split?: "horizontal" | "vertical";
  }[];
}

export interface ChromeAppConfig {
  type: "chrome";
  size?: number;
  url?: string;
}

export type AppConfig = VsCodeAppConfig | ZedAppConfig | ITermAppConfig | ChromeAppConfig;

export interface BandConfig {
  apps?: AppConfig[];
}

export type CodingAgentType = "claude-code";

export interface CodingAgentConfig {
  type: CodingAgentType;
  command?: string;
}

export interface NotificationSettings {
  soundOnNeedsAttention?: boolean;
  sound?: string;
}

export interface LabelDefinition {
  id: string;
  name: string;
  color: string;
}

export interface Settings {
  worktreesDir: string | null;
  defaults?: BandConfig;
  codingAgent?: CodingAgentConfig;
  webServerPort?: number;
  notifications?: NotificationSettings;
  labels?: LabelDefinition[];
  tokenSecret?: string;
  autoStartTunnel?: boolean;
}

export interface HooksStatus {
  installed: boolean;
  other_hooks_exist: boolean;
}

export type CliStatus =
  | "Installed"
  | "NotInstalled"
  | "ConflictingBinary"
  | "DirNotFound"
  | "NotWritable";

export interface DeleteDialogInfo {
  projectName: string;
  branch: string;
  isUnmerged: boolean;
  isDirty: boolean;
  hasUnpushedCommits: boolean;
}

export type FileStatus = "A" | "M" | "D" | "R" | "U";

export interface WorkspaceDiff {
  diff: string;
  stats: { filesChanged: number; insertions: number; deletions: number };
  baseBranch: string;
  headBranch: string;
  fileStatuses: Record<string, FileStatus>;
}

export interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
}

export interface FileListResult {
  entries: FileEntry[];
  path: string;
}

export interface FileContentResult {
  content?: string;
  binary?: boolean;
  tooLarge?: boolean;
  size: number;
  language?: string;
}

export interface ContentSearchMatch {
  file: string;
  line: number;
  content: string;
}
