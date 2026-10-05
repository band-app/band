import type { CIStatus, GitStatus, WorktreeStatus } from "../types";

export type SSEEvent = {
  kind:
    | "update"
    | "remove"
    | "snapshot"
    | "branch-status"
    | "tunnel-url"
    | "tunnel-error"
    | "setup-status";
  status?: WorktreeStatus;
  statuses?: WorktreeStatus[];
  worktreeId?: string;
  git?: GitStatus;
  ci?: CIStatus;
  url?: string;
  error?: string;
  setupState?: "running" | "completed" | "failed";
  setupError?: string;
  script?: "setup" | "teardown";
  runningSetups?: string[];
};
