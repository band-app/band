import type { PullRequestSummary, RepoInfo } from "@band-app/host-local/git/git-client";

export interface CIStatus {
  state: string;
  url?: string | null;
  pr?: PullRequestSummary | null;
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

interface PullRequestNode {
  number: number;
  title: string;
  state: string;
  url: string;
  isDraft: boolean;
  /** Null when the fork the PR came from has been deleted. */
  headRepositoryOwner: { login: string } | null;
}

interface GraphQLRepoResponse {
  owner?: { login: string };
  pullRequests: {
    nodes: PullRequestNode[];
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
 * Each worktree gets a unique alias (e.g. ws_0, ws_1) so results can be
 * mapped back to the originating worktree.
 */
export function buildBatchedCIQuery(inputs: BatchCIInput[]): string {
  const fragments = inputs.map((input) => {
    const owner = escapeGraphQL(input.repoInfo.owner);
    const repo = escapeGraphQL(input.repoInfo.repo);
    const branch = escapeGraphQL(input.branch);

    return `${input.alias}: repository(owner: "${owner}", name: "${repo}") {
    owner { login }
    pullRequests(headRefName: "${branch}", first: 5, states: [OPEN, MERGED, CLOSED], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number title state url isDraft headRepositoryOwner { login } }
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

/**
 * The branch's PR: open first, then merged, then closed, each the most
 * recently updated (the query orders by `UPDATED_AT`). `headRefName` also
 * matches PRs from forks with a branch of the same name, so only PRs whose
 * head is in the repository itself count, and only ones with a web URL (the
 * badge hands it to the system's URL handler). On the default branch only
 * an open PR counts: a merged or closed PR whose head is `main` came from a
 * merge of main into another branch.
 */
function pickPullRequest(
  allNodes: PullRequestNode[],
  repoOwner: string | undefined,
  isDefaultBranch: boolean,
): PullRequestSummary | null {
  const nodes = allNodes.filter(
    (n) =>
      repoOwner !== undefined &&
      n.headRepositoryOwner?.login.toLowerCase() === repoOwner.toLowerCase() &&
      isWebUrl(n.url),
  );
  const node =
    nodes.find((n) => n.state === "OPEN") ??
    (isDefaultBranch
      ? undefined
      : (nodes.find((n) => n.state === "MERGED") ?? nodes.find((n) => n.state === "CLOSED")));
  if (!node) return null;
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    state: node.state === "OPEN" ? "open" : node.state === "MERGED" ? "merged" : "closed",
    isDraft: node.isDraft,
  };
}

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
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
 * Applies the same aggregation logic as the original per-worktree code:
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
    const isDefaultBranch = defaultBranches?.get(alias) !== undefined;
    const pr = pickPullRequest(repo.pullRequests?.nodes ?? [], repo.owner?.login, isDefaultBranch);
    if (pr?.state === "merged") {
      results.set(alias, { state: "merged", url: pr.url, pr });
      continue;
    }
    const prUrl = pr?.state === "open" ? pr.url : null;

    // Check CI status from check suites
    const checkSuiteNodes = repo.ref?.target?.checkSuites?.nodes ?? [];

    // Filter to only GitHub Actions workflow runs (matches original gh run list behavior)
    const workflowRuns = checkSuiteNodes.filter(
      (cs): cs is CheckSuiteNode & { workflowRun: NonNullable<CheckSuiteNode["workflowRun"]> } =>
        cs.workflowRun != null,
    );

    if (workflowRuns.length === 0) {
      results.set(alias, { state: "none", url: prUrl, pr });
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
      pr,
    });
  }

  return results;
}
