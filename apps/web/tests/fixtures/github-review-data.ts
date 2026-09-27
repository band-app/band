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
        : { workflowRun: { workflow: { name: input.workflow ?? "Example workflow" } } },
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
