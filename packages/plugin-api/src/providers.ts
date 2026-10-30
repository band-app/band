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

/** The event keys a GitHub subscription matches on. The hub and the GitHub plugin both build them here. */
export const githubPrKey = (repo: string, number: number | string) => `github:pr:${repo}#${number}`;
export const githubCiKey = (repo: string, branch: string) => `github:ci:${repo}@${branch}`;
/** What every PR key of `repo` starts with. */
export const githubPrKeyPrefix = (repo: string) => githubPrKey(repo, "");
/** What every CI key of `repo` starts with. */
export const githubCiKeyPrefix = (repo: string) => githubCiKey(repo, "");

/** Which of several check states wins when they are folded into one; a higher number wins. */
export function statePriority(state: string): number {
  switch (state) {
    case "failure":
      return 4;
    case "running":
      return 3;
    case "pending":
      return 2;
    case "cancelled":
      return 1;
    case "success":
      return 0;
    default:
      return -1;
  }
}

export interface ChecksReport {
  state: ChecksState;
  /** The commit the checks ran on. */
  headSha: string | null;
  checks: CheckRun[];
  /**
   * What a person can do to these checks, e.g. re-run a job. A review's `actions` repeat them;
   * a branch with no review has only these.
   */
  actions?: ReviewAction[];
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

/** The review a branch's badge shows. A branch has at most one. */
export interface BranchReview {
  number: number;
  title: string;
  url: string;
  state: "open" | "merged" | "closed";
  isDraft: boolean;
}

/** What the worktree card shows for one branch: the CI icon and the review badge. */
export interface BranchStatus {
  /** `merged` when the branch's review merged; otherwise the overall state of its CI. */
  state: ChecksState | "merged";
  /** The page the CI icon opens: the open review, else the check that decides `state`. */
  url: string | null;
  review: BranchReview | null;
}

/** One branch of a repo whose status the core asks for. */
export interface BranchStatusRequest {
  branch: string;
  /** Whether the branch is the repo's default branch. Only an open review counts there. */
  isDefaultBranch: boolean;
}

/**
 * The sidebar's per-branch badge data, for many branches of one repo in one call.
 * The core polls it on its CI ticks and stores the answer.
 */
export interface BranchStatusProvider {
  id: string;
  matches(repo: RepoInfo): boolean;
  /**
   * Returns a status for each requested branch, keyed by branch name; a branch left out
   * counts as having no checks and no review. Rejects when the forge cannot be reached.
   */
  getBranchStatuses(
    repo: RepoInfo,
    branches: BranchStatusRequest[],
    ctx: Pick<ProviderContext, "cwd" | "gh">,
  ): Promise<Record<string, BranchStatus>>;
}

/** A normalized event a subscription source produces. The core adds `source` (the provider id). */
export interface SourceEvent {
  /** The forge's own id for the event, so a redelivery or a repeated poll is dropped. */
  id: string;
  kind: string;
  /** What the event is about, e.g. `github:pr:owner/repo#7`. Subscriptions match on it. */
  key: string;
  url: string;
  actor: string;
  summary: string;
  /** Epoch milliseconds. */
  at: number;
  /** The commit a push put on a branch. The core checks it against the commits Band pushed. */
  sha?: string;
  /** Set on a CI failure: true when Band pushed the commit, so the agent may fix it. */
  fix?: boolean;
}

/** What the core lends a subscription source for one call. */
export interface SubscriptionContext {
  /** Runs `gh ARGS` the way the core does for the hub (its login or vault credential). */
  gh(args: string[]): Promise<string>;
  /** `gh ARGS` with `input` on stdin, for a body that must stay out of argv. */
  ghWithInput(args: string[], input: string): Promise<string>;
  /** Whether Band pushed this commit. */
  isBandPushed(sha: string): boolean;
  /** `gh` calls the current poll may still make. Only meaningful while polling. */
  callsLeft(): number;
}

/** A webhook delivery as the core received it. */
export interface DeliveryInput {
  /** Header names lowercased, first value only. */
  headers: Record<string, string>;
  /** The raw body, base64 encoded, so a signature can be checked byte for byte. */
  bodyBase64: string;
}

export type DeliveryVerdict = { ok: false } | { ok: true; deliveryId: string | null };

/** What a verified delivery means for subscriptions. */
export type DeliveryParse =
  | { type: "events"; events: SourceEvent[] }
  /** A completed check: the core calls `aggregateChecks` once, shared per `flight`. */
  | { type: "check"; key: string; flight: string; trigger: unknown }
  | { type: "ignored" };

/** One subscription of a repo, as the core hands it to a provider for polling. */
export interface PollSubscription {
  id: string;
  key: string;
  createdAt: number;
  /** The cursor the provider returned last time, or null before the first poll. `pollUnits` always sees null; `poll` sees the stored value. */
  cursor: string | null;
}

/** Subscriptions polled together by one call. */
export interface PollUnit {
  /** Identifies the work across polls, for backoff and round robin. */
  id: string;
  subscriptions: PollSubscription[];
}

/** New events for one subscription, or for everyone on a key when `subscriptionId` is absent. */
export interface PollResult {
  subscriptionId?: string;
  events: SourceEvent[];
  cursor?: string;
}

/**
 * A forge as a source of subscription events: verifies and reads webhook deliveries, polls
 * when no webhook is registered, and registers the webhook. The core keeps the store, the
 * delivery to chats and the guards (wakeup limits, expiry, own pushes, allowed senders,
 * delivery-id dedup); it works on the normalized events only. The provider id is the
 * subscription `source`.
 */
export interface SubscriptionSourceProvider {
  id: string;
  /**
   * Whether the headers carry a signature at all. The core asks first, so a request with none
   * is refused before its body is copied and encoded.
   */
  hasSignature(headers: Record<string, string>): boolean;
  /**
   * Checks the delivery's signature against `secret` in constant time. The signature scheme
   * belongs to the forge, the secret's storage to the core. Nothing else is read before this.
   */
  verifyDelivery(input: DeliveryInput & { secret: string }): Promise<DeliveryVerdict>;
  /**
   * Reads a verified, first-seen delivery. The provider tells the core a review changed
   * (`api.reviews.changed`) from here, whether or not a subscription listens.
   */
  parseDelivery(input: DeliveryInput): Promise<DeliveryParse>;
  /** Fetches the checks of a `check` trigger. One verdict event, or null while any is pending. */
  aggregateChecks(trigger: unknown, ctx: SubscriptionContext): Promise<SourceEvent | null>;
  /** The webhook events and the URL are the provider's; the secret and public URL come from the core. */
  registerWebhook(
    input: { repo: string; url: string; secret: string },
    ctx: SubscriptionContext,
  ): Promise<{ status: "registered" | "failed"; error?: string }>;
  /** Who may wake a pull request subscription when the caller names nobody. */
  defaultSenders(repo: string, ctx: SubscriptionContext): Promise<string[]>;
  /** Splits the subscriptions of one repo into the units a poll reads together. */
  pollUnits(repo: string, subscriptions: PollSubscription[]): PollUnit[];
  /** Reads one unit from each subscription's cursor. Throws when the forge call fails. */
  poll(repo: string, unit: PollUnit, ctx: SubscriptionContext): Promise<PollResult[]>;
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
