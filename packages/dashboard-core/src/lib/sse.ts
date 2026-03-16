import type { CIStatus, GitStatus, TaskRunnerState, WorkspaceStatus } from "../types";

export type SSEEvent = {
  kind:
    | "update"
    | "remove"
    | "snapshot"
    | "branch-status"
    | "tunnel-url"
    | "tunnel-error"
    | "setup-status"
    | "task-status";
  status?: WorkspaceStatus;
  statuses?: WorkspaceStatus[];
  workspaceId?: string;
  git?: GitStatus;
  ci?: CIStatus;
  url?: string;
  error?: string;
  setupState?: "running" | "completed" | "failed";
  setupError?: string;
  taskState?: TaskRunnerState;
};
