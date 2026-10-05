/**
 * The pull request each worktree's branch-status event carries (`ci.pr`),
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
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { branchRepository, prNode, prUrl, workflowSuite } from "./fixtures/branch-status-data";
import { type GhStub, ghStub } from "./fixtures/gh-stub";
import { FAKE_REPO } from "./fixtures/github-review-data";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer } from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "branch-status-pr-test-token";
const REPO = "widgets";

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
 * `ci` of every `branch-status` event, newest last, by worktree.
 */
async function openStatusStream(serverUrl: string) {
  const ws = new WebSocket(`${serverUrl.replace(/^http/, "ws")}/trpc`, {
    headers: { Cookie: `band_token=${TOKEN}` },
  });
  const ci = new Map<string, CIEvent[]>();
  ws.on("message", (raw: Buffer) => {
    const data = (
      JSON.parse(raw.toString()) as {
        result?: { data?: { kind?: string; worktreeId?: string; ci?: CIEvent } };
      }
    ).result?.data;
    if (data?.kind !== "branch-status" || !data.worktreeId || !data.ci) return;
    ci.set(data.worktreeId, [...(ci.get(data.worktreeId) ?? []), data.ci]);
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
    /** The first `ci` received for `worktreeId`. */
    async firstCI(worktreeId: string): Promise<CIEvent> {
      await waitFor(() => (ci.get(worktreeId)?.length ?? 0) > 0, { timeoutMs: 20_000 });
      return ci.get(worktreeId)?.[0] as CIEvent;
    },
    /** The newest `ci` for `worktreeId`, once one has a `pr` field. */
    async latestCI(worktreeId: string): Promise<CIEvent> {
      await waitFor(() => ci.get(worktreeId)?.some((e) => e.pr !== undefined) ?? false, {
        timeoutMs: 20_000,
      });
      return ci.get(worktreeId)?.at(-1) as CIEvent;
    },
    close: () => ws.close(),
  };
}

/**
 * A git repo with a github.com `origin` and one worktree per branch, seeded
 * as the repo `REPO` with `main` as its default branch.
 */
function seedRepo(tmpHome: string, branches: string[]): void {
  const repo = join(tmpHome, REPO);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  git(repo, ["remote", "add", "origin", `git@github.com:${FAKE_REPO.owner}/${FAKE_REPO.name}.git`]);
  const worktrees = branches.map((branch) => {
    const path = join(tmpHome, `wt-${branch.replaceAll("/", "-")}`);
    git(repo, ["worktree", "add", "-b", branch, path]);
    return { name: branch, branch, path };
  });
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repo,
        defaultBranch: "main",
        worktrees: [{ name: "main", branch: "main", path: repo }, ...worktrees],
      },
    ],
  });
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
  fork: "feat/fork",
  oddUrl: "feat/odd-url",
} as const;

const RUN_URL = workflowSuite({ workflow: "CI" }).workflowRun.url;

/** The `pr` an open, non-draft PR seeded with `prNode` is reported as. */
function openPr(number: number, title: string) {
  return { number, title, url: prUrl(number), state: "open", isDraft: false };
}

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
  [CASES.fork]: branchRepository({
    pullRequests: [prNode({ number: 650, headOwner: "someone-else" })],
    suites: [workflowSuite({ workflow: "CI", conclusion: "SUCCESS" })],
  }),
  [CASES.oddUrl]: branchRepository({
    pullRequests: [prNode({ number: 651, url: "file:///etc/passwd" })],
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

  const wsId = (branch: string) => toWorktreeId(REPO, branch);

  beforeAll(async () => {
    tmpHome = createTmpHome("band-branch-status-pr-");
    seedRepo(tmpHome, Object.values(CASES));
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
      pr: openPr(705, "fix(web): stop terminal input stalls"),
    });
  });

  it("a draft PR with a running check", async () => {
    expect(await stream.latestCI(wsId(CASES.draft))).toEqual({
      state: "running",
      url: prUrl(706),
      pr: { ...openPr(706, "wip: the badge"), isDraft: true },
    });
  });

  it("an open PR with passing checks, and one with no checks", async () => {
    expect(await stream.latestCI(wsId(CASES.passing))).toEqual({
      state: "success",
      url: prUrl(707),
      pr: openPr(707, "Pull request 707"),
    });
    expect(await stream.latestCI(wsId(CASES.noChecks))).toEqual({
      state: "none",
      url: prUrl(708),
      pr: openPr(708, "Pull request 708"),
    });
  });

  it("a merged PR is reported as merged, whatever its checks said", async () => {
    expect(await stream.latestCI(wsId(CASES.merged))).toEqual({
      state: "merged",
      url: prUrl(700),
      pr: { ...openPr(700, "feat: shipped"), state: "merged" },
    });
  });

  it("a closed PR is reported as closed; the CI state and link come from the branch", async () => {
    expect(await stream.latestCI(wsId(CASES.closed))).toEqual({
      state: "none",
      url: null,
      pr: { ...openPr(690, "abandoned"), state: "closed" },
    });
  });

  it("an open PR wins over a more recently updated closed one", async () => {
    expect(await stream.latestCI(wsId(CASES.reopened))).toEqual({
      state: "success",
      url: prUrl(681),
      pr: openPr(681, "Pull request 681"),
    });
  });

  it("a branch without a PR, and the default branch's merged PR, report no PR", async () => {
    expect(await stream.latestCI(wsId(CASES.noPr))).toEqual({
      state: "success",
      url: RUN_URL,
      pr: null,
    });
    expect(await stream.latestCI(wsId("main"))).toEqual({
      state: "success",
      url: RUN_URL,
      pr: null,
    });
  });

  it("a fork's PR with the same branch name, or one without a web URL, is not the branch's PR", async () => {
    expect(await stream.latestCI(wsId(CASES.fork))).toEqual({
      state: "success",
      url: RUN_URL,
      pr: null,
    });
    expect(await stream.latestCI(wsId(CASES.oddUrl))).toEqual({
      state: "none",
      url: null,
      pr: null,
    });
  });

  it("asks GitHub for every worktree in one query, in the first poll", async () => {
    await stream.latestCI(wsId(CASES.failing));
    const first = stub.requests.find((r) => r.fields.query?.includes("ws_0: repository("));
    for (const branch of [...Object.values(CASES), "main"]) {
      expect(first?.fields.query).toContain(`pullRequests(headRefName: "${branch}"`);
    }
  });

  it("a new subscriber gets the stored PR in its on-connect snapshot", async () => {
    await stream.latestCI(wsId(CASES.failing));
    const second = await openStatusStream(server.url);
    try {
      expect(await second.firstCI(wsId(CASES.failing))).toEqual({
        state: "failure",
        url: prUrl(705),
        pr: openPr(705, "fix(web): stop terminal input stalls"),
      });
    } finally {
      second.close();
    }
  });

  it("refuses a status stream without the session cookie", async () => {
    const ws = new WebSocket(`${server.url.replace(/^http/, "ws")}/trpc`);
    const outcome = await new Promise<string>((resolve) => {
      ws.once("open", () => resolve("open"));
      ws.once("error", () => resolve("refused"));
    });
    ws.close();
    expect(outcome).toBe("refused");
  });
});

describe("with the GitHub plugin disabled", () => {
  let tmpHome: string;
  let server: ServerHandle;
  let stub: GhStub;
  let stream: Awaited<ReturnType<typeof openStatusStream>>;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-branch-status-pr-disabled-");
    seedRepo(tmpHome, [CASES.failing]);
    seedSettings(tmpHome, { tokenSecret: TOKEN, plugins: { disabled: ["github"] } });

    stub = await ghStub.start();
    stub.setBranchStatusQuery(FAKE_REPO, (branch) => REPOSITORIES[branch]);
    // A worker probes `gh --version` itself when it starts, which this test counts as a call.
    server = await startServer({ tmpHome, env: stub.env, remoteHost: false });
    stream = await openStatusStream(server.url);
  }, 60_000);

  afterAll(async () => {
    stream?.close();
    await server?.close();
    await stub?.stop();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("the poller never runs gh, and the branch reports no PR and no CI state", async () => {
    expect(await stream.latestCI(toWorktreeId(REPO, CASES.failing))).toEqual({
      state: "none",
      url: null,
      pr: null,
    });
    expect(stub.requests).toEqual([]);
  });
});
