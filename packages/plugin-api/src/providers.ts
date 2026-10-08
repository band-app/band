/**
 * Provider interfaces. The core owns these concepts (a code review for a
 * branch, the checks on a ref) and renders their output; plugins implement
 * them for a forge. Everything that crosses this boundary is plain JSON, so
 * a plugin can later move out of process without changing the interfaces.
 */

/** Forge coordinates of a repo's `origin` remote. */
export interface RepoInfo {
  host: string;
  owner: string;
  repo: string;
}

/** Where a provider call runs: the worktree's worktree and its repo's default branch. */
export interface ProviderContext {
  cwd: string;
  defaultBranch: string;
  /**
   * Runs `gh ARGS` where the core decides (the worktree's host, then the hub)
   * and returns stdout. A provider that shells out to `gh` uses it when set.
   */
  gh?: (args: string[]) => Promise<string>;
}

/** The state of one check or CI job. */
export type CheckState =
  | "success"
  | "failure"
  | "running"
  | "pending"
  | "cancelled"
  | "skipped"
  | "neutral";

/** One check or CI job on a commit. */
export interface CheckRun {
  /** Stable within one report, for list keys. */
  id: string;
  name: string;
  /** The CI workflow that ran the job, when the check came from one. */
  workflowName: string | null;
  state: CheckState;
  /** The job's page on the forge. */
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** A one-line result, e.g. a check run's title or a commit status description. */
  description: string | null;
}

/** The overall state of a set of checks. `none` means there are no checks. */
export type ChecksState = "success" | "failure" | "running" | "pending" | "cancelled" | "none";

export interface ChecksReport {
  state: ChecksState;
  /** The commit the checks ran on. */
  headSha: string | null;
  checks: CheckRun[];
}

export type ReviewState = "open" | "draft" | "merged" | "closed";

/** Whether the review can merge now, and if not, why. */
export type MergeState =
  | "clean"
  | "unstable"
  | "has_hooks"
  | "blocked"
  | "behind"
  | "dirty"
  | "draft"
  | "unknown";

export type ReviewDecision = "approved" | "changes_requested" | "review_required";

export type MergeMethod = "merge" | "squash" | "rebase";

/** A code review (a pull request or merge request) for a branch. */
export interface ReviewInfo {
  number: number;
  url: string;
  title: string;
  state: ReviewState;
  updatedAt: string;
  reviewDecision: ReviewDecision | null;
  mergeState: MergeState;
  /** CI is a property of the review's head commit. */
  checks: ChecksReport;
}

export interface ReviewProvider {
  /** The id of the plugin that registered it, e.g. `github`. */
  id: string;
  /** Shown in the UI, e.g. `GitHub`. */
  name: string;
  matches(repo: RepoInfo): boolean;
  getReviewForBranch(
    repo: RepoInfo,
    branch: string,
    ctx: ProviderContext,
  ): Promise<ReviewInfo | null>;
  merge?(repo: RepoInfo, number: number, method: MergeMethod, ctx: ProviderContext): Promise<void>;
}

/** Checks for a ref that has no review, e.g. the default branch. */
export interface ChecksProvider {
  id: string;
  matches(repo: RepoInfo): boolean;
  getChecksForRef(repo: RepoInfo, ref: string, ctx: ProviderContext): Promise<ChecksReport>;
}

/**
 * What the core returns for a worktree's review panel: the review for the
 * worktree's branch, or when there is none, the checks on the branch.
 */
export type WorktreeReview =
  | {
      status: "ok";
      provider: { id: string; name: string };
      repo: RepoInfo;
      branch: string;
      review: ReviewInfo | null;
      /** The review's checks, or the branch's checks when there is no review. */
      checks: ChecksReport;
      fetchedAt: string;
    }
  | {
      status: "unavailable";
      reason: "plain-repo" | "detached-head" | "no-remote" | "no-provider";
      message: string;
    }
  | {
      status: "error";
      message: string;
    };
