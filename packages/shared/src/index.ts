export type AgentStatusType =
  | "idle"
  | "working"
  | "needs_input"
  | "error"
  | "done";

export interface AgentInfo {
  name: string;
  status: AgentStatusType;
  lastActivity: string;
  summary?: string;
}

export interface WorkspaceStatus {
  workspaceId: string;
  project: string;
  branch: string;
  worktreePath: string;
  ide: string;
  pid?: number;
  agent?: AgentInfo;
}

export interface ProjectInfo {
  name: string;
  path: string;
  defaultBranch: string;
}

export interface WorktreeInfo {
  branch: string;
  path: string;
  project: string;
  head?: string;
  isBare?: boolean;
}

export interface DashboardState {
  projects: ProjectInfo[];
  workspaces: WorkspaceStatus[];
}

export const BAND_DIR = ".band";
export const STATUS_DIR = "status";
export const BAND_HOME = "~/.band";
export const STATUS_HOME = `${BAND_HOME}/${STATUS_DIR}`;
