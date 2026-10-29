import type {
  CheckRun,
  CheckState,
  ChecksReport,
  ChecksState,
  MergeState,
  ReviewComment,
  ReviewConversationItem,
  ReviewDecision,
  ReviewDiscussion,
  Reviewer,
  ReviewerState,
  ReviewInfo,
  ReviewState,
  ReviewThread,
} from "@band-app/plugin-api";
import { reviewActions } from "./actions";

// What one query fetches of the discussion. Past a cap the newest messages
// win for comments and reviews, and the first ones for threads; the
// discussion carries `truncated` so the panel can say so.
export const MAX_COMMENTS = 50;
export const MAX_REVIEWS = 50;
export const MAX_THREADS = 50;
export const MAX_THREAD_COMMENTS = 20;
export const MAX_REVIEW_REQUESTS = 30;

const ACTOR = "login avatarUrl";

const CHECK_RUN_FIELDS = `
  databaseId
  name
  status
  conclusion
  detailsUrl
  url
  startedAt
  completedAt
  title
  checkSuite { workflowRun { databaseId workflow { name } } }`;

/**
 * One query for everything the review panel shows: the branch's newest pull
 * request with the checks on its head commit, and the GitHub Actions jobs on
 * the branch head for when there is no pull request. Variables: `owner`,
 * `name`, `branch` and `ref` (`refs/heads/<branch>`).
 */
export const REVIEW_QUERY = `query($owner: String!, $name: String!, $branch: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, first: 5, states: [OPEN, MERGED, CLOSED], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        state
        isDraft
        isCrossRepository
        updatedAt
        mergeStateStatus
        reviewDecision
        reviewRequests(first: ${MAX_REVIEW_REQUESTS}) {
          nodes {
            asCodeOwner
            requestedReviewer {
              __typename
              ... on User { ${ACTOR} }
              ... on Bot { ${ACTOR} }
              ... on Mannequin { ${ACTOR} }
              ... on Team { slug }
            }
          }
        }
        reviews(last: ${MAX_REVIEWS}) {
          totalCount
          nodes { id state body submittedAt url author { ${ACTOR} } }
        }
        comments(last: ${MAX_COMMENTS}) {
          totalCount
          nodes { id body createdAt url author { ${ACTOR} } }
        }
        reviewThreads(first: ${MAX_THREADS}) {
          totalCount
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            originalLine
            comments(first: ${MAX_THREAD_COMMENTS}) {
              totalCount
              nodes { id body createdAt url author { ${ACTOR} } }
            }
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              oid
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {${CHECK_RUN_FIELDS}
                    }
                    ... on StatusContext { id context state targetUrl description createdAt }
                  }
                }
              }
            }
          }
        }
      }
    }
    ref(qualifiedName: $ref) {
      target {
        ... on Commit {
          oid
          checkSuites(first: 50) {
            nodes {
              workflowRun { workflow { name } }
              checkRuns(first: 50, filterBy: {checkType: LATEST}) {
                nodes {${CHECK_RUN_FIELDS}
                }
              }
            }
          }
        }
      }
    }
  }
}`;

interface CheckRunNode {
  __typename?: "CheckRun";
  databaseId: number | null;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  title: string | null;
  checkSuite: {
    workflowRun: { databaseId: number | null; workflow: { name: string } } | null;
  } | null;
}

interface StatusContextNode {
  __typename: "StatusContext";
  id: string;
  context: string;
  state: string;
  targetUrl: string | null;
  description: string | null;
  createdAt: string | null;
}

interface ActorNode {
  login: string;
  avatarUrl: string | null;
}

interface CommentNode {
  id: string;
  body: string;
  createdAt: string;
  url: string | null;
  author: ActorNode | null;
}

interface ReviewNode {
  id: string;
  state: string;
  body: string;
  submittedAt: string | null;
  url: string | null;
  author: ActorNode | null;
}

interface ReviewRequestNode {
  asCodeOwner: boolean;
  requestedReviewer:
    | ({ __typename: "User" | "Bot" | "Mannequin" } & ActorNode)
    | { __typename: "Team"; slug: string }
    | null;
}

interface PullRequestNode {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  isCrossRepository: boolean;
  updatedAt: string;
  mergeStateStatus: string | null;
  reviewDecision: string | null;
  reviewRequests?: { nodes: ReviewRequestNode[] };
  reviews?: { totalCount: number; nodes: ReviewNode[] };
  comments?: { totalCount: number; nodes: CommentNode[] };
  reviewThreads?: {
    totalCount: number;
    nodes: Array<{
      id: string;
      isResolved: boolean;
      isOutdated: boolean;
      path: string;
      line: number | null;
      originalLine: number | null;
      comments: { totalCount: number; nodes: CommentNode[] };
    }>;
  };
  commits: {
    nodes: Array<{
      commit: {
        oid: string;
        statusCheckRollup: {
          contexts: { nodes: Array<CheckRunNode | StatusContextNode | Record<string, never>> };
        } | null;
      };
    }>;
  };
}

export interface ReviewQueryResponse {
  repository: {
    pullRequests: { nodes: PullRequestNode[] };
    ref: {
      target: {
        oid?: string;
        checkSuites?: {
          nodes: Array<{
            workflowRun: { workflow: { name: string } } | null;
            checkRuns: { nodes: CheckRunNode[] };
          }>;
        };
      } | null;
    } | null;
  } | null;
}

/**
 * The newest pull request opened from `branch` in this repository, or null.
 * An open one wins over a newer merged or closed one. The default branch
 * never has one: a pull request with `main` as its head is someone merging
 * main into another branch, not a review of main.
 */
export function parseReview(
  data: ReviewQueryResponse,
  branch: string,
  defaultBranch: string,
): ReviewInfo | null {
  if (branch === defaultBranch) return null;
  const nodes = (data.repository?.pullRequests.nodes ?? []).filter((pr) => !pr.isCrossRepository);
  const pr = nodes.find((node) => node.state === "OPEN") ?? nodes[0];
  if (!pr) return null;

  const head = pr.commits.nodes[0]?.commit;
  const checks: CheckRun[] = [];
  for (const node of head?.statusCheckRollup?.contexts.nodes ?? []) {
    if (node.__typename === "StatusContext") {
      checks.push(fromStatusContext(node));
    } else if (node.__typename === "CheckRun") {
      checks.push(fromCheckRun(node as CheckRunNode, null));
    }
  }

  const review = {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: reviewState(pr),
    updatedAt: pr.updatedAt,
    reviewDecision: reviewDecision(pr.reviewDecision),
    mergeState: mergeState(pr.mergeStateStatus),
    checks: report(head?.oid ?? null, checks),
    reviewers: parseReviewers(pr),
    discussion: parseDiscussion(pr),
  };
  return { ...review, actions: reviewActions(review) };
}

const REVIEWER_STATES: Record<string, ReviewerState> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

const actorOf = (author: ActorNode | null): { login: string; avatarUrl: string | null } => ({
  login: author?.login ?? "ghost",
  avatarUrl: webUrl(author?.avatarUrl ?? null),
});

/**
 * Everyone asked to review plus everyone who reviewed. A reviewer's state is
 * their latest verdict (approved, changes requested or dismissed); a comment
 * review only counts when they gave no verdict, as GitHub's own list does.
 * Someone asked again after reviewing shows as pending. Built from the last
 * MAX_REVIEWS reviews.
 */
function parseReviewers(pr: PullRequestNode): Reviewer[] {
  const byLogin = new Map<string, Reviewer>();
  const order = [...(pr.reviews?.nodes ?? [])].sort((a, b) =>
    (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""),
  );
  for (const review of order) {
    const state = REVIEWER_STATES[review.state];
    if (!state || !review.author) continue; // PENDING drafts are the viewer's own
    const existing = byLogin.get(review.author.login);
    if (existing && state === "commented" && existing.state !== "commented") continue;
    byLogin.set(review.author.login, {
      ...actorOf(review.author),
      state,
      submittedAt: review.submittedAt,
    });
  }
  for (const request of pr.reviewRequests?.nodes ?? []) {
    const who = request.requestedReviewer;
    if (!who) continue;
    const actor =
      who.__typename === "Team"
        ? { login: who.slug, avatarUrl: null }
        : actorOf({ login: who.login, avatarUrl: who.avatarUrl });
    // A team slug can equal a user's login, so teams get their own key.
    const key = who.__typename === "Team" ? `team:${actor.login}` : actor.login;
    const previous = byLogin.get(key);
    byLogin.set(key, {
      ...actor,
      state: "pending",
      submittedAt: previous?.submittedAt ?? null,
      ...(request.asCodeOwner ? { required: true } : {}),
    });
  }
  return [...byLogin.values()];
}

function fromCommentNode(node: CommentNode): ReviewComment {
  return {
    id: node.id,
    author: actorOf(node.author),
    body: node.body,
    createdAt: node.createdAt,
    url: webUrl(node.url),
  };
}

/** Conversation comments, review summaries with a body, and inline threads. */
function parseDiscussion(pr: PullRequestNode): ReviewDiscussion {
  const items: ReviewConversationItem[] = [];
  for (const node of pr.comments?.nodes ?? []) {
    items.push({ ...fromCommentNode(node), kind: "comment" });
  }
  for (const review of pr.reviews?.nodes ?? []) {
    const state = REVIEWER_STATES[review.state];
    if (!state || !review.body.trim() || !review.submittedAt) continue;
    items.push({
      id: review.id,
      kind: "review",
      reviewState: state,
      author: actorOf(review.author),
      body: review.body,
      createdAt: review.submittedAt,
      url: webUrl(review.url),
    });
  }
  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const threads: ReviewThread[] = [];
  for (const node of pr.reviewThreads?.nodes ?? []) {
    const comments = node.comments.nodes.map(fromCommentNode);
    if (comments.length === 0) continue;
    threads.push({
      id: node.id,
      path: node.path,
      line: node.line ?? node.originalLine,
      isResolved: node.isResolved,
      isOutdated: node.isOutdated,
      comments,
      ...(node.comments.totalCount > comments.length ? { truncated: true } : {}),
    });
  }
  threads.sort((a, b) => a.comments[0].createdAt.localeCompare(b.comments[0].createdAt));

  const truncated =
    (pr.comments?.totalCount ?? 0) > (pr.comments?.nodes.length ?? 0) ||
    (pr.reviews?.totalCount ?? 0) > (pr.reviews?.nodes.length ?? 0) ||
    (pr.reviewThreads?.totalCount ?? 0) > (pr.reviewThreads?.nodes.length ?? 0);
  return { items, threads, ...(truncated ? { truncated: true } : {}) };
}

/**
 * The GitHub Actions jobs on the branch head. Check suites without a
 * workflow run (third-party apps) are left out; a job that ran more than
 * once keeps only its newest run.
 */
export function parseBranchChecks(data: ReviewQueryResponse): ChecksReport {
  const target = data.repository?.ref?.target;
  const latest = new Map<string, CheckRun>();
  for (const suite of target?.checkSuites?.nodes ?? []) {
    if (!suite.workflowRun) continue;
    const workflowName = suite.workflowRun.workflow.name;
    for (const node of suite.checkRuns.nodes) {
      const run = fromCheckRun(node, workflowName);
      const key = `${workflowName}\u0000${run.name}`;
      const existing = latest.get(key);
      if (!existing || (run.startedAt ?? "") > (existing.startedAt ?? "")) {
        latest.set(key, run);
      }
    }
  }
  return report(target?.oid ?? null, [...latest.values()]);
}

function fromCheckRun(node: CheckRunNode, workflowName: string | null): CheckRun {
  const runId = node.checkSuite?.workflowRun?.databaseId;
  return {
    id: node.databaseId != null ? `check-run-${node.databaseId}` : `check-run-${node.name}`,
    name: node.name,
    workflowName: workflowName ?? node.checkSuite?.workflowRun?.workflow.name ?? null,
    state: checkRunState(node.status, node.conclusion),
    url: webUrl(node.detailsUrl) ?? webUrl(node.url),
    startedAt: node.startedAt,
    completedAt: node.completedAt,
    description: node.title || null,
    // Only a job of a workflow run can be run again; its check run id is the job id.
    ...(runId != null && node.databaseId != null
      ? { rerun: { runId: String(runId), jobId: String(node.databaseId) } }
      : {}),
  };
}

function fromStatusContext(node: StatusContextNode): CheckRun {
  return {
    id: `status-${node.id}`,
    name: node.context,
    workflowName: null,
    state: statusContextState(node.state),
    url: webUrl(node.targetUrl),
    startedAt: node.createdAt,
    completedAt: null,
    description: node.description || null,
  };
}

/**
 * `url` when it is http(s), else null. Whoever reports a check picks its
 * URL (any GitHub App, or CI with commit-status access), and the panel opens
 * it with the system's URL handler, so `file:` or app schemes must not pass.
 */
function webUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function checkRunState(status: string, conclusion: string | null): CheckState {
  if (status === "IN_PROGRESS") return "running";
  if (status !== "COMPLETED") return "pending";
  switch (conclusion) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "TIMED_OUT":
    case "STARTUP_FAILURE":
    case "ACTION_REQUIRED":
      return "failure";
    case "CANCELLED":
      return "cancelled";
    case "SKIPPED":
    case "STALE":
      return "skipped";
    default:
      return "neutral";
  }
}

function statusContextState(state: string): CheckState {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    default:
      return "pending";
  }
}

// Failing checks first, then the ones still running, as GitHub lists them.
const LIST_ORDER: Record<CheckState, number> = {
  failure: 0,
  running: 1,
  pending: 2,
  cancelled: 3,
  success: 4,
  neutral: 5,
  skipped: 6,
};

// failure > running > pending > cancelled > success, as the worktree card's
// CI badge aggregates.
const AGGREGATE_PRIORITY: Partial<Record<CheckState, number>> = {
  failure: 4,
  running: 3,
  pending: 2,
  cancelled: 1,
};

function report(headSha: string | null, checks: CheckRun[]): ChecksReport {
  const sorted = [...checks].sort(
    (a, b) => LIST_ORDER[a.state] - LIST_ORDER[b.state] || a.name.localeCompare(b.name),
  );
  let state: ChecksState = sorted.length === 0 ? "none" : "success";
  let priority = 0;
  for (const check of sorted) {
    const p = AGGREGATE_PRIORITY[check.state] ?? 0;
    if (p > priority) {
      priority = p;
      state = check.state as ChecksState;
    }
  }
  return { state, headSha, checks: sorted };
}

function reviewState(pr: PullRequestNode): ReviewState {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  return pr.isDraft ? "draft" : "open";
}

function reviewDecision(value: string | null): ReviewDecision | null {
  switch (value) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "REVIEW_REQUIRED":
      return "review_required";
    default:
      return null;
  }
}

const MERGE_STATES: Record<string, MergeState> = {
  CLEAN: "clean",
  UNSTABLE: "unstable",
  HAS_HOOKS: "has_hooks",
  BLOCKED: "blocked",
  BEHIND: "behind",
  DIRTY: "dirty",
  DRAFT: "draft",
};

function mergeState(value: string | null): MergeState {
  return (value && MERGE_STATES[value]) || "unknown";
}
