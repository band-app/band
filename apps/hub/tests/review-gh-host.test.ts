/**
 * Where the review and checks `gh` calls run (`reviews.forWorktree`).
 *
 * A real hub and a real `band-worker` each run their own fake `gh` (two Express stubs behind
 * `BAND_GH_BIN`), so a request shows which machine made the call. The hub's gh has no login
 * (its stub answers 401 and has no `auth status` route). The worktree lives on the worker.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { branchRepository, prNode } from "./fixtures/branch-status-data";
import { type GhStub, ghStub } from "./fixtures/gh-stub";
import { FAKE_REPO, pullRequestNode, reviewQueryData } from "./fixtures/github-review-data";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { settleWorktreesOnHost, startLoopbackWorker } from "./helpers/test-host";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "review-gh-host-token";
const VAULT_TOKEN = "ghp_reviewHostVaultToken0123456789";
const BRANCHES = ["feat/online", "feat/offline", "feat/nowhere"];

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });

const withPullRequest = (title: string) =>
  reviewQueryData({ pullRequests: [pullRequestNode({ number: 7, title })] });

describe("review gh runs on the worktree's host", () => {
  let tmpHome: string;
  let server: ServerHandle;
  let hubGh: GhStub;
  let workerGh: GhStub;
  let worker: Awaited<ReturnType<typeof startLoopbackWorker>>;
  const worktrees = new Map<string, string>();

  const review = async (branch: string) => {
    const res = await trpcQuery(
      server.url,
      "reviews.forWorktree",
      { worktreeId: toWorktreeId("widgets", branch) },
      TOKEN,
    );
    expect(res.status).toBe(200);
    return trpcData<{ status: string; message?: string; review?: { title: string } }>(res);
  };

  beforeAll(async () => {
    tmpHome = createTmpHome("band-review-gh-host-");
    const repo = join(tmpHome, "widgets");
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
    for (const branch of BRANCHES) {
      const path = join(tmpHome, `wt-${branch.replaceAll("/", "-")}`);
      git(repo, ["worktree", "add", "-b", branch, path]);
      worktrees.set(branch, path);
    }
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    seedState(tmpHome, {
      repos: [
        {
          name: "widgets",
          path: repo,
          defaultBranch: "main",
          worktrees: [
            { name: "main", branch: "main", path: repo },
            ...BRANCHES.map((b) => ({ name: b, branch: b, path: worktrees.get(b) as string })),
          ],
        },
      ],
    });

    hubGh = await ghStub.start();
    workerGh = await ghStub.start();
    server = await startServer({
      tmpHome,
      remoteHost: false,
      // `GH_TOKEN` empty: the hub's own gh has no login unless the vault supplies one.
      env: { ...hubGh.env, GH_TOKEN: "", GITHUB_TOKEN: "" },
    });
    worker = await startLoopbackWorker({ ...server, env: workerGh.env });
    await settleWorktreesOnHost(tmpHome, worker.hostId);
  }, 120_000);

  afterAll(async () => {
    await worker?.close();
    await server?.close();
    await hubGh?.stop();
    await workerGh?.stop();
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10 });
  });

  it("S1: shows the checks from the worker's gh when the hub's gh has no login", async () => {
    workerGh.setReviewQuery(FAKE_REPO, "feat/online", withPullRequest("From the worker"));
    hubGh.setReviewQueryError(FAKE_REPO, "feat/online", "HTTP 401: Bad credentials\n");

    const data = await review("feat/online");

    expect(data.status).toBe("ok");
    expect(data.review?.title).toBe("From the worker");
    const call = workerGh.requests.find((r) => r.positional[1] === "graphql");
    expect(call?.cwd).toBe(worktrees.get("feat/online"));
    expect(hubGh.requests.filter((r) => r.positional[1] === "graphql")).toEqual([]);
  });

  it("S4: the sidebar badge and the Checks panel read the same host's gh", async () => {
    const worktreeId = toWorktreeId("widgets", "feat/online");
    // The hub's gh would give another PR number, so a badge computed on the hub would disagree.
    workerGh.setBranchStatusQuery(FAKE_REPO, () =>
      branchRepository({ pullRequests: [prNode({ number: 7, title: "From the worker" })] }),
    );
    hubGh.setBranchStatusQuery(FAKE_REPO, () =>
      branchRepository({ pullRequests: [prNode({ number: 999, title: "From the hub" })] }),
    );
    workerGh.setReviewQuery(FAKE_REPO, "feat/online", withPullRequest("From the worker"));

    // The dashboard's status stream keeps the poller running and carries the badge's PR.
    const ws = new WebSocket(`${server.url.replace(/^http/, "ws")}/trpc`, {
      headers: { Cookie: `band_token=${TOKEN}` },
    });
    const badge: Array<number | undefined> = [];
    ws.on("message", (raw: Buffer) => {
      const data = (
        JSON.parse(raw.toString()) as {
          result?: {
            data?: { kind?: string; worktreeId?: string; ci?: { pr?: { number: number } | null } };
          };
        }
      ).result?.data;
      if (data?.kind === "branch-status" && data.worktreeId === worktreeId && data.ci?.pr) {
        badge.push(data.ci.pr.number);
      }
    });
    try {
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
      await waitFor(() => badge.length > 0, { timeoutMs: 30_000 });
    } finally {
      ws.close();
    }

    const data = await review("feat/online");
    expect(data.status).toBe("ok");
    expect(badge).toEqual(badge.map(() => 7));
    expect((data.review as { number?: number } | undefined)?.number).toBe(7);
    expect(hubGh.requests.filter((r) => r.args[1] === "graphql")).toEqual([]);
  });

  it("S3: names both machines and the fix when neither gh has a login", async () => {
    workerGh.setReviewQueryError(FAKE_REPO, "feat/nowhere", "HTTP 401: Bad credentials\n");
    hubGh.setReviewQueryError(FAKE_REPO, "feat/nowhere", "HTTP 401: Bad credentials\n");

    const data = await review("feat/nowhere");

    expect(data.status).toBe("error");
    expect(data.message).toContain(`Worker ${worker.hostId}`);
    expect(data.message).toContain("Hub: HTTP 401");
    expect(data.message).toContain(`gh auth login on ${worker.hostId}`);
    expect(data.message).toContain("band vault put --kind git --host github.com");
  });

  it("S2: falls back to the hub's gh with the vault token when the worker is offline", async () => {
    const put = await trpcMutate(
      server.url,
      "vault.put",
      {
        name: "github-com",
        kind: "git",
        host: "github.com",
        pathPattern: "**",
        value: VAULT_TOKEN,
      },
      TOKEN,
    );
    expect(put.status).toBe(200);
    hubGh.setReviewQuery(FAKE_REPO, "feat/offline", withPullRequest("From the hub"));
    await worker.close();

    const data = await review("feat/offline");

    expect(data.status).toBe("ok");
    expect(data.review?.title).toBe("From the hub");
    const call = hubGh.requests.find((r) => r.fields.branch === "feat/offline");
    expect(call?.ghToken).toBe(VAULT_TOKEN);
  });
});
