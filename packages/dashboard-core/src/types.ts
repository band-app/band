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

export interface BandConfig {
  layout?: {
    orientation: "horizontal" | "vertical";
    groups: {
      size: number;
      browser?: { url: string; pinned?: boolean };
    }[];
  };
  terminals?: {
    name: string;
    command: string;
    split?: "horizontal" | "vertical";
    agentType?: "claude-code";
  }[];
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
  tunnelSubdomain?: string;
  autoStartTunnel?: boolean;
}

export interface HooksStatus {
  installed: boolean;
  other_hooks_exist: boolean;
}
