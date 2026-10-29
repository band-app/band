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
  /**
   * Set when the forge can run this job again: the CI run it belongs to and
   * its own id. Absent for checks from external apps and commit statuses.
   */
  rerun?: { runId: string; jobId: string };
}

/** One re-run request: a single job of a run, or every failed job of it. */
export interface RerunTarget {
  runId: string;
  /** The job to run again. Required unless `failedOnly` is set. */
  jobId?: string;
  /** Run again every failed job of the run instead of one job. */
  failedOnly?: boolean;
}

/** The icons an action may name. A fixed set, so the core draws every icon itself. */
export type ReviewActionIcon = "merge" | "rerun" | "ready";

/** Argument values an action carries. Plain JSON only. */
export type ReviewActionArgs = Record<string, string | number | boolean>;

/**
 * Ids the core's own API knows (`reviews.merge`, `reviews.rerunChecks`). A provider that
 * supports these operations offers actions with these ids; others are free-form.
 */
export const REVIEW_ACTION_MERGE = "merge";
export const REVIEW_ACTION_RERUN_JOB = "rerun-job";
export const REVIEW_ACTION_RERUN_FAILED = "rerun-failed";
export const REVIEW_ACTION_READY = "ready";

/**
 * Something a person can do to a review, described as data. The core draws it and sends
 * `runAction` back to the provider. An action is identified by its `id` and `args`: several
 * actions may share an id when their args differ (one `merge` action per merge method).
 */
export interface ReviewAction {
  id: string;
  label: string;
  icon: ReviewActionIcon;
  /**
   * `header` shows in the panel's header. `check` belongs to one check row; its `args.checkId`
   * names the `CheckRun.id`. A `header` action with the `rerun` icon appears in the failing
   * checks banner instead.
   */
  placement: "header" | "check";
  /** Header actions with the same group show as one split button, the first being the default. */
  group?: string;
  args?: ReviewActionArgs;
  /** When set, the core asks for confirmation with this text before it runs the action. */
  confirm?: string;
  /** When set, the action is shown but cannot run, and this says why. */
  disabledReason?: string;
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

/** One reviewer's standing on a review. `pending` means requested, no review yet. */
export type ReviewerState =
  | "approved"
  | "changes_requested"
  | "commented"
  | "pending"
  | "dismissed";

/** A person (or team) who was asked to review or left a review. */
export interface Reviewer {
  login: string;
  avatarUrl: string | null;
  /** Their latest state: a later review replaces an earlier one. */
  state: ReviewerState;
  submittedAt: string | null;
  /** Whether the forge requires this reviewer (code owners), when it says. */
  required?: boolean;
}

/** The author of a comment. */
export interface CommentAuthor {
  login: string;
  avatarUrl: string | null;
}

/** One message: a conversation comment, a review summary or a reply in a thread. */
export interface ReviewComment {
  id: string;
  author: CommentAuthor;
  /** Markdown, from an untrusted author. */
  body: string;
  createdAt: string;
  /** The message on the forge. */
  url: string | null;
}

/** A top-level comment on the review or a review's summary. */
export interface ReviewConversationItem extends ReviewComment {
  kind: "comment" | "review";
  /** For `review`: the verdict that came with the summary. */
  reviewState?: ReviewerState;
}

/** An inline discussion on a line of a file. */
export interface ReviewThread {
  id: string;
  path: string;
  /** The line in the head commit, or the last known one when outdated. */
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  comments: ReviewComment[];
  /** True when the forge holds more messages than `comments` carries. */
  truncated?: boolean;
}

/** Everything people said on a review, read-only. */
export interface ReviewDiscussion {
  /** Conversation comments and review summaries, oldest first. */
  items: ReviewConversationItem[];
  /** Inline threads, ordered by their first message, oldest first. */
  threads: ReviewThread[];
  /** True when the forge holds more than was fetched. */
  truncated?: boolean;
}

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
  /** Absent when the provider does not report reviewers. */
  reviewers?: Reviewer[];
  /** Absent when the provider does not report comments. */
  discussion?: ReviewDiscussion;
  /** What the person may do to this review now. */
  actions: ReviewAction[];
}

export interface ReviewProvider {
  /** The id of the plugin that registered it, e.g. `github`. */
  id: string;
  /** Shown in the UI, e.g. `GitHub`. */
  name: string;
  /** Used in the Fix prompt: how an agent can read a failing job's log, e.g. a `gh run view` command. */
  fixHint: string;
  matches(repo: RepoInfo): boolean;
  getReviewForBranch(
    repo: RepoInfo,
    branch: string,
    ctx: ProviderContext,
  ): Promise<ReviewInfo | null>;
  /**
   * Run one of the `actions` the review offered. Rejects with the forge's message when it
   * refuses or when the id or args are unknown.
   */
  runAction(
    repo: RepoInfo,
    number: number,
    actionId: string,
    args: ReviewActionArgs,
    ctx: ProviderContext,
  ): Promise<void>;
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
      provider: { id: string; name: string; fixHint: string };
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
