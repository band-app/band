import type { PullRequestSummary } from "@band-app/host-local/git/git-client";

/** The CI icon and PR badge data stored in a worktree's `branch_statuses` row. */
export interface CIStatus {
  state: string;
  url?: string | null;
  pr?: PullRequestSummary | null;
}
