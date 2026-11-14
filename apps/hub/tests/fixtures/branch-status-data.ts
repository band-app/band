// Factories for the `repository` objects the branch-status poller's batched
// CI query returns (`plugins/github/src/server/branch-query.ts`),
// served by `ghStub.setBranchStatusQuery`. Defaults are obviously fake.

import { FAKE_REPO, type MergeQueueInput, mergeQueueFields } from "./github-review-data";

export function prUrl(number: number): string {
  return `https://github.com/${FAKE_REPO.owner}/${FAKE_REPO.name}/pull/${number}`;
}

interface PullRequestInput {
  number: number;
  title?: string;
  state?: "OPEN" | "MERGED" | "CLOSED";
  isDraft?: boolean;
  /** The owner of the head repository; a fork's owner makes it a fork PR. */
  headOwner?: string;
  /** The branch the PR merges into. */
  base?: string;
  url?: string;
  mergeQueue?: MergeQueueInput;
  autoMerge?: boolean;
}

export function prNode(input: PullRequestInput) {
  return {
    number: input.number,
    title: input.title ?? `Pull request ${input.number}`,
    state: input.state ?? "OPEN",
    url: input.url ?? prUrl(input.number),
    isDraft: input.isDraft ?? false,
    ...(input.base && { baseRefName: input.base }),
    headRepositoryOwner: { login: input.headOwner ?? FAKE_REPO.owner },
    ...mergeQueueFields(input),
  };
}

interface CheckSuiteInput {
  workflow: string;
  status?: "QUEUED" | "IN_PROGRESS" | "COMPLETED";
  conclusion?: "SUCCESS" | "FAILURE" | "CANCELLED" | null;
  runId?: number;
}

/** A check suite that belongs to a GitHub Actions workflow run. */
export function workflowSuite(input: CheckSuiteInput) {
  const status = input.status ?? "COMPLETED";
  return {
    status,
    conclusion: status === "COMPLETED" ? (input.conclusion ?? "SUCCESS") : null,
    updatedAt: "2026-09-28T10:00:00Z",
    workflowRun: {
      workflow: { name: input.workflow },
      url: `https://github.com/${FAKE_REPO.owner}/${FAKE_REPO.name}/actions/runs/${input.runId ?? 9000}`,
    },
  };
}

/** One alias's `repository` object: the branch's PRs and its head's check suites. */
export function branchRepository(input: {
  pullRequests?: ReturnType<typeof prNode>[];
  suites?: ReturnType<typeof workflowSuite>[];
}) {
  return {
    owner: { login: FAKE_REPO.owner },
    pullRequests: { nodes: input.pullRequests ?? [] },
    ref: { target: { checkSuites: { nodes: input.suites ?? [] } } },
  };
}
