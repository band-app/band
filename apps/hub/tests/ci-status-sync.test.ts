/**
 * One CI state for a worktree: what the Checks panel reads (`reviews.forWorktree`)
 * reaches the sidebar's `branch-status` event, and a poller tick that sees a
 * change is an event the panel can compare its own state with.
 *
 * Real server, a real git repo with a github.com `origin`, and a fake `gh`
 * (`fixtures/gh-stub.ts`) that answers both the poller's batched query and the
 * plugin's review query. The events come from a real `status.stream` subscription.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { branchRepository, prNode, workflowSuite } from "./fixtures/branch-status-data";
import { type GhStub, ghStub } from "./fixtures/gh-stub";
import {
  checkRunNode,
  FAKE_REPO,
  pullRequestNode,
  reviewQueryData,
} from "./fixtures/github-review-data";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer, trpcQuery } from "./helpers/server";
import { testWorktreeId } from "./helpers/test-host";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "ci-status-sync-token";
const REPO = "widgets";
const BRANCH = "feat/sync";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });
}

interface CIEvent {
  state: string;
  pr?: { number: number } | null;
}

/** A `status.stream` subscriber that records the `ci` of each `branch-status` event. */
async function openStatusStream(serverUrl: string) {
  const ws = new WebSocket(`${serverUrl.replace(/^http/, "ws")}/trpc`, {
    headers: { Cookie: `band_token=${TOKEN}` },
  });
  const events: { worktreeId: string; ci: CIEvent; at: number }[] = [];
  ws.on("message", (raw: Buffer) => {
    const data = (
      JSON.parse(raw.toString()) as {
        result?: { data?: { kind?: string; worktreeId?: string; ci?: CIEvent } };
      }
    ).result?.data;
    if (data?.kind !== "branch-status" || !data.worktreeId || !data.ci) return;
    events.push({ worktreeId: data.worktreeId, ci: data.ci, at: Date.now() });
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
    events,
    latest: (worktreeId: string) => events.filter((e) => e.worktreeId === worktreeId).at(-1),
    close: () => ws.close(),
  };
}

describe("a worktree's CI state is the same in the sidebar and the Checks panel", () => {
  let tmpHome: string;
  let server: ServerHandle;
  let stub: GhStub;
  let stream: Awaited<ReturnType<typeof openStatusStream>>;
  // What GitHub currently says, for both queries.
  let github: "pending" | "failure" = "pending";
  let reviewQueries = 0;

  const worktreeId = testWorktreeId(REPO, BRANCH);
  const batchedQueries = () =>
    stub.requests.filter((r) => r.fields.query?.includes("ws_0: repository(")).length;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-ci-status-sync-");
    const repo = join(tmpHome, REPO);
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
    const path = join(tmpHome, "wt-sync");
    git(repo, ["worktree", "add", "-b", BRANCH, path]);
    seedState(tmpHome, {
      repos: [
        {
          name: REPO,
          path: repo,
          defaultBranch: "main",
          worktrees: [
            { name: "main", branch: "main", path: repo },
            { name: BRANCH, branch: BRANCH, path },
          ],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });

    stub = await ghStub.start();
    stub.setBranchStatusQuery(FAKE_REPO, (branch) =>
      branch === BRANCH
        ? branchRepository({
            pullRequests: [prNode({ number: 710 })],
            suites: [
              github === "failure"
                ? workflowSuite({ workflow: "CI", conclusion: "FAILURE" })
                : workflowSuite({ workflow: "CI", status: "IN_PROGRESS" }),
            ],
          })
        : branchRepository({}),
    );
    stub.setReviewQuery(
      FAKE_REPO,
      BRANCH,
      () =>
        reviewQueryData({
          pullRequests: [
            pullRequestNode({
              number: 710,
              contexts: [
                github === "failure"
                  ? checkRunNode({
                      id: 1,
                      name: "Lint, Test & Build",
                      workflow: "CI",
                      runId: 9000,
                      conclusion: "FAILURE",
                    })
                  : checkRunNode({
                      id: 1,
                      name: "Lint, Test & Build",
                      workflow: "CI",
                      runId: 9000,
                      status: "IN_PROGRESS",
                      conclusion: null,
                      completedAt: null,
                    }),
              ],
            }),
          ],
        }),
      { onRequest: () => reviewQueries++ },
    );
    server = await startServer({ tmpHome, env: stub.env });
    stream = await openStatusStream(server.url);
  }, 60_000);

  afterAll(async () => {
    stream?.close();
    await server?.close();
    await stub?.stop();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("a Checks panel load that finds a new state reaches the sidebar without a tick", async () => {
    await waitFor(() => stream.latest(worktreeId)?.ci.state === "running", { timeoutMs: 20_000 });
    await waitFor(() => batchedQueries() >= 1);
    const batchedBefore = batchedQueries();
    github = "failure";

    const asked = Date.now();
    const res = await trpcQuery(server.url, "reviews.forWorktree", { worktreeId }, TOKEN);
    expect(res.status).toBe(200);

    await waitFor(() => stream.latest(worktreeId)?.ci.state === "failure", { timeoutMs: 2_000 });
    expect(stream.latest(worktreeId)?.at).toBeGreaterThanOrEqual(asked);
    expect(stream.latest(worktreeId)?.ci.pr?.number).toBe(710);
    // The load made one review query, and the sidebar's update made none of its own.
    expect(reviewQueries).toBe(1);
    expect(batchedQueries()).toBe(batchedBefore);
  });

  it("a load that finds the state the sidebar already has sends no event", async () => {
    const before = stream.events.length;
    await trpcQuery(server.url, "reviews.forWorktree", { worktreeId }, TOKEN);
    await new Promise((r) => setTimeout(r, 500));
    expect(stream.events.length).toBe(before);
  });
});
