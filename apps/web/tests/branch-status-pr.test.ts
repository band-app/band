/**
 * The pull request each workspace's branch-status event carries (`ci.pr`),
 * which the sidebar's PR badge renders. The branch-status poller reads it
 * from the same batched `gh api graphql` query as the CI state.
 *
 * Real server, a real git repo with a github.com `origin` and one worktree
 * per case, and a fake `gh` (`fixtures/gh-stub-bin.mjs` + the Express stub in
 * `fixtures/gh-stub.ts`) selected through `BAND_GH_BIN`. The events are read
 * from a real `status.stream` subscription, which is also what keeps the
 * poller running.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { toWorkspaceId } from "@/dashboard";
import { branchRepository, prNode, prUrl, workflowSuite } from "./fixtures/branch-status-data";
import { type GhStub, ghStub } from "./fixtures/gh-stub";
import { FAKE_REPO } from "./fixtures/github-review-data";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer } from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "branch-status-pr-test-token";
const PROJECT = "widgets";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });
}

interface CIEvent {
  state: string;
  url?: string | null;
  pr?: {
    number: number;
    title: string;
    url: string;
    state: string;
    isDraft: boolean;
  } | null;
}

/**
 * A `status.stream` subscriber, as the dashboard keeps open. Collects the
 * `ci` of every `branch-status` event, newest last, by workspace.
 */
async function openStatusStream(serverUrl: string) {
  const ws = new WebSocket(`${serverUrl.replace(/^http/, "ws")}/trpc`, {
    headers: { Cookie: `band_token=${TOKEN}` },
  });
  const ci = new Map<string, CIEvent[]>();
  ws.on("message", (raw: Buffer) => {
    const data = (
      JSON.parse(raw.toString()) as {
        result?: { data?: { kind?: string; workspaceId?: string; ci?: CIEvent } };
      }
    ).result?.data;
    if (data?.kind !== "branch-status" || !data.workspaceId || !data.ci) return;
    ci.set(data.workspaceId, [...(ci.get(data.workspaceId) ?? []), data.ci]);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("error", reject);
    ws.once("open", () => {
      ws.send(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "subscription",
          params: { path: "status.stream", input: undefined },
        }),
      );
      resolve();
    });
  });
  return {
    /** The newest `ci` for `workspaceId`, once one has a `pr` field. */
    async latestCI(workspaceId: string): Promise<CIEvent> {
      await waitFor(() => ci.get(workspaceId)?.some((e) => e.pr !== undefined) ?? false, {
        timeoutMs: 20_000,
      });
      return ci.get(workspaceId)?.at(-1) as CIEvent;
    },
    close: () => ws.close(),
  };
}

// One worktree per case, keyed by its branch.
const CASES = {
  failing: "feat/failing",
  draft: "feat/draft",
  passing: "feat/passing",
  noChecks: "feat/no-checks",
  merged: "feat/merged",
  closed: "feat/closed",
  reopened: "feat/reopened",
  noPr: "feat/no-pr",
} as const;

const REPOSITORIES: Record<string, ReturnType<typeof branchRepository>> = {
  [CASES.failing]: branchRepository({
    pullRequests: [prNode({ number: 705, title: "fix(web): stop terminal input stalls" })],
    suites: [
      workflowSuite({ workflow: "CI", conclusion: "FAILURE" }),
      workflowSuite({ workflow: "Review", conclusion: "SUCCESS" }),
    ],
  }),
  [CASES.draft]: branchRepository({
    pullRequests: [prNode({ number: 706, title: "wip: the badge", isDraft: true })],
    suites: [workflowSuite({ workflow: "CI", status: "IN_PROGRESS" })],
  }),
  [CASES.passing]: branchRepository({
    pullRequests: [prNode({ number: 707 })],
    suites: [workflowSuite({ workflow: "CI", conclusion: "SUCCESS" })],
  }),
  [CASES.noChecks]: branchRepository({ pullRequests: [prNode({ number: 708 })] }),
  [CASES.merged]: branchRepository({
    pullRequests: [prNode({ number: 700, state: "MERGED", title: "feat: shipped" })],
    suites: [workflowSuite({ workflow: "CI", conclusion: "FAILURE" })],
  }),
  [CASES.closed]: branchRepository({
    pullRequests: [prNode({ number: 690, state: "CLOSED", title: "abandoned" })],
  }),
  // The query orders by last update, so the closed PR comes first; the open
  // one still wins.
  [CASES.reopened]: branchRepository({
    pullRequests: [prNode({ number: 680, state: "CLOSED" }), prNode({ number: 681 })],
    suites: [workflowSuite({ workflow: "CI", conclusion: "SUCCESS" })],
  }),
  [CASES.noPr]: branchRepository({
    suites: [workflowSuite({ workflow: "CI", conclusion: "SUCCESS" })],
  }),
  // A merged PR whose head is `main` came from a merge into another branch.
  main: branchRepository({
    pullRequests: [prNode({ number: 1, state: "MERGED" })],
    suites: [workflowSuite({ workflow: "CI", conclusion: "SUCCESS" })],
  }),
};

describe("branch-status events carry the branch's pull request", () => {
  let tmpHome: string;
  let server: ServerHandle;
  let stub: GhStub;
  let stream: Awaited<ReturnType<typeof openStatusStream>>;

  const wsId = (branch: string) => toWorkspaceId(PROJECT, branch);

  beforeAll(async () => {
    tmpHome = createTmpHome("band-branch-status-pr-");
    const repo = join(tmpHome, PROJECT);
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "hello\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
    git(repo, [
      "remote",
      "add",
      "origin",
      `git@github.com:${FAKE_REPO.owner}/${FAKE_REPO.name}.git`,
    ]);
    const worktrees = Object.values(CASES).map((branch) => {
      const path = join(tmpHome, `wt-${branch.replaceAll("/", "-")}`);
      git(repo, ["worktree", "add", "-b", branch, path]);
      return { name: branch, branch, path };
    });

    seedState(tmpHome, {
      projects: [
        {
          name: PROJECT,
          path: repo,
          defaultBranch: "main",
          worktrees: [{ name: "main", branch: "main", path: repo }, ...worktrees],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });

    stub = await ghStub.start();
    stub.setBranchStatusQuery(FAKE_REPO, (branch) => REPOSITORIES[branch]);
    server = await startServer({ tmpHome, env: stub.env });
    stream = await openStatusStream(server.url);
  }, 60_000);

  afterAll(async () => {
    stream?.close();
    await server?.close();
    await stub?.stop();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("an open PR with a failing check: its number, title and URL, CI failure", async () => {
    expect(await stream.latestCI(wsId(CASES.failing))).toEqual({
      state: "failure",
      url: prUrl(705),
      pr: {
        number: 705,
        title: "fix(web): stop terminal input stalls",
        url: prUrl(705),
        state: "open",
        isDraft: false,
      },
    });
  });

  it("a draft PR with a running check", async () => {
    const ci = await stream.latestCI(wsId(CASES.draft));
    expect(ci.state).toBe("running");
    expect(ci.pr).toMatchObject({ number: 706, state: "open", isDraft: true });
  });

  it("an open PR with passing checks, and one with no checks", async () => {
    const passing = await stream.latestCI(wsId(CASES.passing));
    expect(passing.state).toBe("success");
    expect(passing.pr).toMatchObject({ number: 707, state: "open" });

    const noChecks = await stream.latestCI(wsId(CASES.noChecks));
    expect(noChecks.state).toBe("none");
    expect(noChecks.pr).toMatchObject({ number: 708, state: "open" });
  });

  it("a merged PR is reported as merged, whatever its checks said", async () => {
    const ci = await stream.latestCI(wsId(CASES.merged));
    expect(ci.state).toBe("merged");
    expect(ci.pr).toMatchObject({ number: 700, title: "feat: shipped", state: "merged" });
  });

  it("a closed PR is reported as closed", async () => {
    const ci = await stream.latestCI(wsId(CASES.closed));
    expect(ci.pr).toMatchObject({ number: 690, title: "abandoned", state: "closed" });
  });

  it("an open PR wins over a more recently updated closed one", async () => {
    const ci = await stream.latestCI(wsId(CASES.reopened));
    expect(ci.state).toBe("success");
    expect(ci.pr).toMatchObject({ number: 681, state: "open" });
  });

  it("a branch without a PR, and the default branch's merged PR, report no PR", async () => {
    const noPr = await stream.latestCI(wsId(CASES.noPr));
    expect(noPr.state).toBe("success");
    expect(noPr.pr).toBeNull();

    const main = await stream.latestCI(wsId("main"));
    expect(main.state).toBe("success");
    expect(main.pr).toBeNull();
  });

  it("asks GitHub once for every workspace, in the first poll", async () => {
    await stream.latestCI(wsId(CASES.failing));
    const batched = stub.requests.filter((r) => r.fields.query?.includes("ws_0: repository("));
    expect(batched).toHaveLength(1);
    for (const branch of [...Object.values(CASES), "main"]) {
      expect(batched[0].fields.query).toContain(`pullRequests(headRefName: "${branch}"`);
    }
  });

  it("a new subscriber gets the stored PR in its on-connect snapshot", async () => {
    await stream.latestCI(wsId(CASES.failing));
    const second = await openStatusStream(server.url);
    try {
      const ci = await second.latestCI(wsId(CASES.failing));
      expect(ci.pr).toMatchObject({ number: 705, state: "open" });
    } finally {
      second.close();
    }
  });
});
