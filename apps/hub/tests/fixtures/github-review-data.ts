// Factories for the GraphQL `data` the GitHub plugin's review query returns
// (`plugins/github/src/server/checks-query.ts`). Defaults are obviously fake;
// tests override the fields they assert on.

export const FAKE_REPO = { owner: "acme", name: "widgets" } as const;
const REPO_URL = `https://github.com/${FAKE_REPO.owner}/${FAKE_REPO.name}`;

/** The URL of a GitHub Actions job page, what a check links to. */
export function jobUrl(runId: number, jobId: number): string {
  return `${REPO_URL}/actions/runs/${runId}/job/${jobId}`;
}

interface CheckRunInput {
  id: number;
  name: string;
  workflow?: string | null;
  status?: "QUEUED" | "IN_PROGRESS" | "COMPLETED";
  conclusion?: string | null;
  runId?: number;
  /** Put the workflow run id on the check suite, so the plugin offers a re-run. */
  rerunnable?: boolean;
  startedAt?: string | null;
  completedAt?: string | null;
  title?: string | null;
}

export function checkRunNode(input: CheckRunInput) {
  const runId = input.runId ?? 9000;
  return {
    __typename: "CheckRun",
    databaseId: input.id,
    name: input.name,
    status: input.status ?? "COMPLETED",
    conclusion: input.conclusion === undefined ? "SUCCESS" : input.conclusion,
    detailsUrl: jobUrl(runId, input.id),
    url: `${REPO_URL}/runs/${input.id}`,
    startedAt: input.startedAt === undefined ? "2026-01-01T10:00:00Z" : input.startedAt,
    completedAt: input.completedAt === undefined ? "2026-01-01T10:02:14Z" : input.completedAt,
    title: input.title ?? null,
    checkSuite:
      input.workflow === null
        ? { workflowRun: null }
        : {
            workflowRun: {
              ...(input.rerunnable ? { databaseId: runId } : {}),
              workflow: { name: input.workflow ?? "Example workflow" },
            },
          },
  };
}

export function statusContextNode(input: {
  id: string;
  context: string;
  state: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING";
  targetUrl: string;
  description?: string;
}) {
  return {
    __typename: "StatusContext",
    id: input.id,
    context: input.context,
    state: input.state,
    targetUrl: input.targetUrl,
    description: input.description ?? null,
    createdAt: "2026-01-01T10:00:00Z",
  };
}

function actor(login: string, avatarUrl?: string) {
  return { login, avatarUrl: avatarUrl ?? `https://avatars.example.test/${login}.png` };
}

/** A user asked to review (`team` makes it a team request). */
export function reviewRequestNode(
  login: string,
  opts: { asCodeOwner?: boolean; avatarUrl?: string } = {},
) {
  return {
    asCodeOwner: opts.asCodeOwner ?? false,
    requestedReviewer: { __typename: "User", ...actor(login, opts.avatarUrl) },
  };
}

export function reviewNode(input: {
  id: string;
  login: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  body?: string;
  submittedAt?: string;
  avatarUrl?: string;
}) {
  return {
    id: input.id,
    state: input.state,
    body: input.body ?? "",
    submittedAt: input.submittedAt ?? "2026-01-02T08:00:00Z",
    url: `${REPO_URL}/pull/1#pullrequestreview-${input.id}`,
    author: actor(input.login, input.avatarUrl),
  };
}

export function commentNode(input: {
  id: string;
  login: string;
  body: string;
  createdAt?: string;
  avatarUrl?: string;
}) {
  return {
    id: input.id,
    body: input.body,
    createdAt: input.createdAt ?? "2026-01-02T08:30:00Z",
    url: `${REPO_URL}/pull/1#issuecomment-${input.id}`,
    author: actor(input.login, input.avatarUrl),
  };
}

export function reviewThreadNode(input: {
  id: string;
  path: string;
  line: number | null;
  isResolved?: boolean;
  isOutdated?: boolean;
  comments: ReturnType<typeof commentNode>[];
  totalComments?: number;
}) {
  return {
    id: input.id,
    isResolved: input.isResolved ?? false,
    isOutdated: input.isOutdated ?? false,
    path: input.path,
    line: input.line,
    originalLine: input.line,
    comments: {
      totalCount: input.totalComments ?? input.comments.length,
      nodes: input.comments,
    },
  };
}

interface PullRequestInput {
  number: number;
  title?: string;
  state?: "OPEN" | "MERGED" | "CLOSED";
  isDraft?: boolean;
  isCrossRepository?: boolean;
  updatedAt?: string;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  headOid?: string;
  contexts?: object[];
  reviewRequests?: object[];
  reviews?: object[];
  comments?: object[];
  reviewThreads?: object[];
}

export function pullRequestNode(input: PullRequestInput) {
  return {
    number: input.number,
    title: input.title ?? "Example pull request",
    url: `${REPO_URL}/pull/${input.number}`,
    state: input.state ?? "OPEN",
    isDraft: input.isDraft ?? false,
    isCrossRepository: input.isCrossRepository ?? false,
    updatedAt: input.updatedAt ?? "2026-01-02T09:30:00Z",
    mergeStateStatus: input.mergeStateStatus ?? "CLEAN",
    reviewDecision: input.reviewDecision === undefined ? null : input.reviewDecision,
    reviewRequests: { nodes: input.reviewRequests ?? [] },
    reviews: { totalCount: (input.reviews ?? []).length, nodes: input.reviews ?? [] },
    comments: { totalCount: (input.comments ?? []).length, nodes: input.comments ?? [] },
    reviewThreads: {
      totalCount: (input.reviewThreads ?? []).length,
      nodes: input.reviewThreads ?? [],
    },
    commits: {
      nodes: [
        {
          commit: {
            oid: input.headOid ?? "1111111111111111111111111111111111111111",
            statusCheckRollup: input.contexts ? { contexts: { nodes: input.contexts } } : null,
          },
        },
      ],
    },
  };
}

/** A check suite on the branch head; `workflow: null` is a third-party app's suite. */
export function checkSuiteNode(workflow: string | null, runs: ReturnType<typeof checkRunNode>[]) {
  return {
    workflowRun: workflow === null ? null : { workflow: { name: workflow } },
    checkRuns: { nodes: runs },
  };
}

/** The whole `data` object. `suites: null` means the branch is not on GitHub. */
export function reviewQueryData(input: {
  pullRequests?: ReturnType<typeof pullRequestNode>[];
  headOid?: string;
  suites?: ReturnType<typeof checkSuiteNode>[] | null;
}) {
  const suites = input.suites === undefined ? [] : input.suites;
  return {
    repository: {
      pullRequests: { nodes: input.pullRequests ?? [] },
      ref:
        suites === null
          ? null
          : {
              target: {
                oid: input.headOid ?? "2222222222222222222222222222222222222222",
                checkSuites: { nodes: suites },
              },
            },
    },
  };
}
