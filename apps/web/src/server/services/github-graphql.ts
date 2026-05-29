import type { RepoInfo } from "../infra/git/git-client";

export interface CIStatus {
  state: string;
  url?: string | null;
}

export interface BatchCIInput {
  alias: string;
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

interface GraphQLRepoResponse {
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
 * Build a single GraphQL query that fetches PR status and CI check suites
 * for multiple branches/repos in one request.
 *
 * Each workspace gets a unique alias (e.g. ws_0, ws_1) so results can be
 * mapped back to the originating workspace.
 */
export function buildBatchedCIQuery(inputs: BatchCIInput[]): string {
  const fragments = inputs.map((input) => {
    const owner = escapeGraphQL(input.repoInfo.owner);
    const repo = escapeGraphQL(input.repoInfo.repo);
    const branch = escapeGraphQL(input.branch);

    return `${input.alias}: repository(owner: "${owner}", name: "${repo}") {
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
  }`;
  });

  return `query { ${fragments.join("\n  ")} }`;
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
 * Parse the batched GraphQL response into a map of alias -> CIStatus.
 *
 * Applies the same aggregation logic as the original per-workspace code:
 * - Dedup check suites by workflow name (keep latest)
 * - Priority: failure > running > pending > cancelled > success
 */
export function parseBatchedCIResponse(
  data: Record<string, GraphQLRepoResponse | null>,
  aliases: string[],
  defaultBranches?: Map<string, string>,
): Map<string, CIStatus> {
  const results = new Map<string, CIStatus>();

  for (const alias of aliases) {
    const repo = data[alias];
    if (!repo) {
      results.set(alias, { state: "none" });
      continue;
    }

    // Check PR status
    let prUrl: string | null = null;
    const isDefaultBranch = defaultBranches?.get(alias) !== undefined;
    const prNodes = repo.pullRequests?.nodes ?? [];
    if (prNodes.length > 0) {
      const pr = prNodes[0];
      // Only show "merged" for feature branches, not the default branch.
      // A merged PR on main just means someone merged main into another branch.
      if (pr.state === "MERGED" && !isDefaultBranch) {
        results.set(alias, { state: "merged", url: pr.url });
        continue;
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
      results.set(alias, { state: "none", url: prUrl });
      continue;
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

    results.set(alias, {
      state: aggregatedState,
      url: prUrl ?? aggregatedUrl,
    });
  }

  return results;
}
