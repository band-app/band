// Factories for the `repository` objects the branch-status poller's batched
// CI query returns (`apps/web/src/server/services/_utils/github-graphql.ts`),
// served by `ghStub.setBranchStatusQuery`. Defaults are obviously fake.

import { FAKE_REPO } from "./github-review-data";

export function prUrl(number: number): string {
  return `https://github.com/${FAKE_REPO.owner}/${FAKE_REPO.name}/pull/${number}`;
}

interface PullRequestInput {
  number: number;
  title?: string;
  state?: "OPEN" | "MERGED" | "CLOSED";
  isDraft?: boolean;
}

export function prNode(input: PullRequestInput) {
  return {
    number: input.number,
    title: input.title ?? `Pull request ${input.number}`,
    state: input.state ?? "OPEN",
    url: prUrl(input.number),
    isDraft: input.isDraft ?? false,
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
    pullRequests: { nodes: input.pullRequests ?? [] },
    ref: { target: { checkSuites: { nodes: input.suites ?? [] } } },
  };
}
