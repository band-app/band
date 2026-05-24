import type { RepoInfo } from "./git";

export interface CIStatus {
  state: string;
  url?: string | null;
}

export interface CIQueryInput {
  branch: string;
  repoInfo: RepoInfo;
}

interface CheckSuiteNode {
  status: string;
  conclusion: string | null;
  updatedAt: string;
  workflowRun: {
    workflow: { name: string };
    url: string;
  } | null;
}

export interface GraphQLRepoResponse {
  pullRequests: {
    nodes: Array<{ state: string; url: string }>;
  };
  ref: {
    target: {
      checkSuites: {
        nodes: CheckSuiteNode[];
      };
    };
  } | null;
}

/**
 * Build a GraphQL query that fetches PR status and CI check suites for a
 * single branch/repo.
 *
 * This intentionally does NOT use the aliased multi-`repository(...)` shape
 * (see git history for the previous `buildBatchedCIQuery`): older `gh`
 * builds validate the query against a baked-in schema before sending and
 * reject aliased top-level `repository` selections with
 * `Field 'repository' doesn't exist on type 'Query'`. Issuing one query per
 * workspace trades a bit of throughput for compatibility across `gh`
 * versions and enterprise endpoints. See issue #457.
 */
export function buildCIQuery(input: CIQueryInput): string {
  const owner = escapeGraphQL(input.repoInfo.owner);
  const repo = escapeGraphQL(input.repoInfo.repo);
  const branch = escapeGraphQL(input.branch);

  return `query {
  repository(owner: "${owner}", name: "${repo}") {
    pullRequests(headRefName: "${branch}", first: 1, states: [OPEN, MERGED], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { state url }
    }
    ref(qualifiedName: "refs/heads/${branch}") {
      target {
        ... on Commit {
          checkSuites(first: 20) {
            nodes {
              status
              conclusion
              updatedAt
              workflowRun {
                workflow { name }
                url
              }
            }
          }
        }
      }
    }
  }
}`;
}

function escapeGraphQL(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

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

/**
 * Parse a single-repository GraphQL response into a `CIStatus`.
 *
 * Aggregation rules (preserved from the previous batched implementation):
 * - Show "merged" only for feature branches, not the default branch
 *   (a merged PR on `main` just means someone merged main into another
 *   branch — that's not a useful status for the main branch).
 * - Dedup check suites by workflow name, keeping the latest run by
 *   `updatedAt`.
 * - Filter to only GitHub-Actions workflow runs (matches the original
 *   `gh run list` behaviour).
 * - Priority across remaining runs: failure > running > pending >
 *   cancelled > success.
 */
export function parseCIResponse(
  repo: GraphQLRepoResponse | null,
  isDefaultBranch: boolean,
): CIStatus {
  if (!repo) {
    return { state: "none" };
  }

  // Check PR status
  let prUrl: string | null = null;
  const prNodes = repo.pullRequests?.nodes ?? [];
  if (prNodes.length > 0) {
    const pr = prNodes[0];
    if (pr.state === "MERGED" && !isDefaultBranch) {
      return { state: "merged", url: pr.url };
    }
    if (pr.state !== "MERGED") {
      prUrl = pr.url;
    }
  }

  // Check CI status from check suites
  const checkSuiteNodes = repo.ref?.target?.checkSuites?.nodes ?? [];

  // Filter to only GitHub Actions workflow runs (matches original gh run list behavior)
  const workflowRuns = checkSuiteNodes.filter(
    (cs): cs is CheckSuiteNode & { workflowRun: NonNullable<CheckSuiteNode["workflowRun"]> } =>
      cs.workflowRun != null,
  );

  if (workflowRuns.length === 0) {
    return { state: "none", url: prUrl };
  }

  // Deduplicate: keep only the latest run per workflow
  const latestByWorkflow = new Map<
    string,
    {
      status: string;
      conclusion: string | null;
      url: string;
      updatedAt: string;
    }
  >();
  for (const cs of workflowRuns) {
    const workflowName = cs.workflowRun.workflow.name;
    const existing = latestByWorkflow.get(workflowName);
    if (!existing || cs.updatedAt > existing.updatedAt) {
      latestByWorkflow.set(workflowName, {
        status: cs.status,
        conclusion: cs.conclusion,
        url: cs.workflowRun.url,
        updatedAt: cs.updatedAt,
      });
    }
  }

  // Aggregate status with priority: failure > running > pending > cancelled > success
  // GraphQL returns UPPER_CASE values (IN_PROGRESS, QUEUED, FAILURE, etc.)
  let aggregatedState = "success";
  let aggregatedUrl: string | null = null;

  for (const run of latestByWorkflow.values()) {
    let runState: string;
    if (run.status === "IN_PROGRESS" || run.status === "QUEUED") {
      runState = run.status === "QUEUED" ? "pending" : "running";
    } else if (run.conclusion === "FAILURE") {
      runState = "failure";
    } else if (run.conclusion === "CANCELLED") {
      runState = "cancelled";
    } else {
      runState = "success";
    }

    const priority = statePriority(runState);
    if (priority >= statePriority(aggregatedState)) {
      aggregatedState = runState;
      aggregatedUrl = run.url;
    }
  }

  return {
    state: aggregatedState,
    url: prUrl ?? aggregatedUrl,
  };
}
