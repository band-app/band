export type AgentStatusType = "working" | "needs_attention" | "waiting";

export interface AgentInfo {
  name: string;
  status: AgentStatusType;
  lastActivity: string;
  codingAgentId?: string;
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

export interface AppConfig {
  type: string;
  size?: number;
  split?: "horizontal" | "vertical";
  terminals?: {
    name: string;
    command: string;
    split?: "horizontal" | "vertical";
  }[];
  commands?: {
    name?: string;
    command: string;
    split?: "horizontal" | "vertical";
  }[];
  url?: string;
}

export interface BandConfig {
  apps?: AppConfig[];
}

// ---------------------------------------------------------------------------
// Workspace terminal configuration (recursive split-tree layout)
// ---------------------------------------------------------------------------

export interface TerminalPaneConfig {
  name?: string;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  focus?: boolean;
}

export type TerminalLayoutNode =
  | { pane: TerminalPaneConfig }
  | {
      direction: "horizontal" | "vertical";
      split?: number;
      children: [TerminalLayoutNode, TerminalLayoutNode];
    };

export interface WorkspaceTerminalConfig {
  layout: TerminalLayoutNode;
}

export type CodingAgentType = "claude-code" | "codex" | "gemini-cli" | "cursor-cli" | "opencode";

export interface CodingAgentConfig {
  type: CodingAgentType;
  command?: string;
}

export interface CodingAgentDefinition {
  id: string;
  type: CodingAgentType;
  label: string;
  command?: string;
  model?: string;
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

export type Theme = "system" | "light" | "dark";

export type AppMode = "side-panel" | "full-editor";

export interface Settings {
  worktreesDir: string | null;
  defaults?: BandConfig;
  codingAgents?: CodingAgentDefinition[];
  defaultCodingAgent?: string;
  webServerPort?: number;
  notifications?: NotificationSettings;
  labels?: LabelDefinition[];
  tokenSecret?: string;
  autoStartTunnel?: boolean;
  enableLSP?: boolean;
  theme?: Theme;
  appMode?: AppMode;
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

export type DiffMode = "uncommitted" | "branch";

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

export interface WorkspaceDiffSummary {
  stats: { filesChanged: number; insertions: number; deletions: number };
  baseBranch: string;
  headBranch: string;
  fileStatuses: Record<string, FileStatus>;
  mergeBase: string;
}

export interface FileDiffResult {
  diff: string;
}

export interface ContentSearchMatch {
  file: string;
  line: number;
  content: string;
}
