import type {
  BranchReview,
  BranchStatus,
  BranchStatusRequest,
  RepoInfo,
} from "@band-app/plugin-api";
import { statePriority } from "@band-app/plugin-api";

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

export interface GraphQLRepoResponse {
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

/** The alias of the branch at `index` in a query, so results map back to the branch. */
export function branchAlias(index: number): string {
  return `ws_${index}`;
}

/**
 * Build a single GraphQL query that fetches the review and CI check suites
 * for several branches of one repo in one request.
 */
export function buildBranchStatusQuery(repoInfo: RepoInfo, branches: string[]): string {
  const owner = escapeGraphQL(repoInfo.owner);
  const repo = escapeGraphQL(repoInfo.repo);
  const fragments = branches.map((name, index) => {
    const branch = escapeGraphQL(name);

    return `${branchAlias(index)}: repository(owner: "${owner}", name: "${repo}") {
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
): BranchReview | null {
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

/**
 * Parse the batched response into a status per requested branch, keyed by branch name.
 *
 * - Keeps the latest check suite per workflow
 * - Aggregates with the priority failure > running > pending > cancelled > success
 */
export function parseBranchStatusResponse(
  data: Record<string, GraphQLRepoResponse | null>,
  branches: BranchStatusRequest[],
): Record<string, BranchStatus> {
  const results: Record<string, BranchStatus> = {};

  for (const [index, { branch, isDefaultBranch }] of branches.entries()) {
    const repo = data[branchAlias(index)];
    if (!repo) {
      results[branch] = { state: "none", url: null, review: null };
      continue;
    }

    const review = pickPullRequest(
      repo.pullRequests?.nodes ?? [],
      repo.owner?.login,
      isDefaultBranch,
    );
    if (review?.state === "merged") {
      results[branch] = { state: "merged", url: review.url, review };
      continue;
    }
    const reviewUrl = review?.state === "open" ? review.url : null;

    const checkSuiteNodes = repo.ref?.target?.checkSuites?.nodes ?? [];

    // Only GitHub Actions workflow runs count (the same as `gh run list`).
    const workflowRuns = checkSuiteNodes.filter(
      (cs): cs is CheckSuiteNode & { workflowRun: NonNullable<CheckSuiteNode["workflowRun"]> } =>
        cs.workflowRun != null,
    );

    if (workflowRuns.length === 0) {
      results[branch] = { state: "none", url: reviewUrl, review };
      continue;
    }

    const latestByWorkflow = new Map<
      string,
      { status: string; conclusion: string | null; url: string; updatedAt: string }
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

    // GraphQL returns UPPER_CASE values (IN_PROGRESS, QUEUED, FAILURE, ...).
    let aggregatedState: BranchStatus["state"] = "success";
    let aggregatedUrl: string | null = null;

    for (const run of latestByWorkflow.values()) {
      let runState: BranchStatus["state"];
      if (run.status === "IN_PROGRESS" || run.status === "QUEUED") {
        runState = run.status === "QUEUED" ? "pending" : "running";
      } else if (run.conclusion === "FAILURE") {
        runState = "failure";
      } else if (run.conclusion === "CANCELLED") {
        runState = "cancelled";
      } else {
        runState = "success";
      }

      if (statePriority(runState) >= statePriority(aggregatedState)) {
        aggregatedState = runState;
        aggregatedUrl = run.url;
      }
    }

    results[branch] = { state: aggregatedState, url: reviewUrl ?? aggregatedUrl, review };
  }

  return results;
}
