/**
 * `review-changed` on the status stream. A signed GitHub delivery maps to the worktrees on its
 * repo and branch and nothing else, deliveries arriving together go out as one event, a delivery
 * with a bad signature signals nothing, and a successful review action signals its own worktree.
 */

import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type GhStub, ghStub } from "./fixtures/gh-stub";
import { FAKE_REPO, pullRequestNode, reviewQueryData } from "./fixtures/github-review-data";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer, trpcMutate } from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "review-signal-token";
const SECRET = "review-signal-secret";
const FULL = `${FAKE_REPO.owner}/${FAKE_REPO.name}`;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });

const WORKTREE_A = toWorktreeId("widgets", "feat/a", "local");
const WORKTREE_B = toWorktreeId("widgets", "feat/b", "local");
const OTHER_REPO_WORKTREE = toWorktreeId("gadgets", "feat/a", "local");

describe("review-changed status event", () => {
  let tmpHome: string;
  let server: ServerHandle;
  let stub: GhStub;
  let ws: WebSocket;
  const signals: string[][] = [];
  let seq = 0;

  const deliver = async (event: string, payload: unknown, signature?: string) => {
    const body = JSON.stringify(payload);
    return fetch(`${server.url}/api/hooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": `sig-${seq++}`,
        "x-hub-signature-256":
          signature ?? `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
      },
      body,
    });
  };

  const checkRun = (repo: string, branch: string) => ({
    action: "completed",
    repository: { full_name: repo },
    check_run: { head_branch: branch, head_sha: "a".repeat(40) },
    sender: { login: "ci" },
  });

  beforeAll(async () => {
    tmpHome = createTmpHome("review-signal-");
    const repoWith = (name: string, remote: string) => {
      const path = join(tmpHome, name);
      mkdirSync(path, { recursive: true });
      git(path, ["init", "-b", "main"]);
      writeFileSync(join(path, "README.md"), "x\n");
      git(path, ["add", "."]);
      git(path, ["commit", "-m", "init"]);
      git(path, ["remote", "add", "origin", remote]);
      return path;
    };
    const widgets = repoWith("widgets", `https://github.com/${FULL}.git`);
    const gadgets = repoWith("gadgets", "https://github.com/acme/gadgets.git");
    const wt = (repo: string, repoPath: string, branch: string) => {
      const path = join(tmpHome, `${repo}-${branch.replace("/", "-")}`);
      git(repoPath, ["worktree", "add", "-b", branch, path]);
      return { name: branch, branch, path };
    };
    seedState(tmpHome, {
      repos: [
        {
          name: "widgets",
          path: widgets,
          defaultBranch: "main",
          worktrees: [
            { name: "main", branch: "main", path: widgets },
            wt("widgets", widgets, "feat/a"),
            wt("widgets", widgets, "feat/b"),
          ],
        },
        {
          name: "gadgets",
          path: gadgets,
          defaultBranch: "main",
          worktrees: [
            { name: "main", branch: "main", path: gadgets },
            wt("gadgets", gadgets, "feat/a"),
          ],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });

    stub = await ghStub.start();
    stub.setReviewQuery(
      FAKE_REPO,
      "feat/a",
      reviewQueryData({ pullRequests: [pullRequestNode({ number: 5 })] }),
    );
    stub.setPrMerge(5, {});
    server = await startServer({
      tmpHome,
      env: { ...stub.env, BAND_GITHUB_WEBHOOK_SECRET: SECRET },
    });

    ws = new WebSocket(`${server.url.replace(/^http/, "ws")}/trpc`, {
      headers: { Cookie: `band_token=${TOKEN}` },
    });
    const ready = new Promise<void>((resolve) => {
      ws.on("message", (raw: Buffer) => {
        const data = (
          JSON.parse(raw.toString()) as {
            result?: { data?: { kind?: string; worktreeIds?: string[] } };
          }
        ).result?.data;
        if (data?.kind === "snapshot") resolve();
        if (data?.kind === "review-changed" && data.worktreeIds) signals.push(data.worktreeIds);
      });
    });
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "subscription",
          params: { path: "status.stream", input: undefined },
        }),
      ),
    );
    await ready;
  });

  afterAll(async () => {
    ws?.close();
    await server?.close();
    await stub?.stop();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("signals only the worktrees on the delivery's repo and branch (S4)", async () => {
    // Another repo's branch, another branch of this repo, and a bad signature: none signals A.
    await deliver("check_run", checkRun("acme/gadgets", "feat/zzz"));
    await deliver("check_run", checkRun(FULL, "feat/none"));
    const bad = await deliver("check_run", checkRun(FULL, "feat/a"), "sha256=00");
    expect(bad.status).toBe(401);
    // A delivery for feat/b flushes after the window; it carries B and never A. The hub reads
    // each repo's origin shortly after boot, so the first deliveries may find no match yet.
    await waitFor(
      async () => {
        await deliver("check_run", checkRun(FULL, "feat/b"));
        return signals.length > 0;
      },
      { timeoutMs: 15_000, intervalMs: 1_200 },
    );
    expect(signals.flat()).toEqual([WORKTREE_B]);
    expect(signals.flat()).not.toContain(OTHER_REPO_WORKTREE);
  });

  it("sends one event for deliveries that arrive together", async () => {
    signals.length = 0;
    await deliver("check_run", checkRun(FULL, "feat/a"));
    await deliver("check_run", checkRun(FULL, "feat/b"));
    await deliver("check_run", checkRun(FULL, "feat/a"));
    await waitFor(async () => signals.length > 0, { timeoutMs: 5_000 });
    expect(signals).toHaveLength(1);
    expect([...signals[0]].sort()).toEqual([WORKTREE_A, WORKTREE_B].sort());
  });

  it("signals every worktree of the repo for a comment, which names no branch", async () => {
    signals.length = 0;
    await deliver("issue_comment", {
      action: "created",
      repository: { full_name: FULL },
      issue: { number: 5, pull_request: {} },
      comment: { body: "hi", html_url: "https://example.test/c" },
      sender: { login: "mia" },
    });
    await waitFor(async () => signals.length > 0, { timeoutMs: 5_000 });
    expect(signals[0]).toEqual(expect.arrayContaining([WORKTREE_A, WORKTREE_B]));
    expect(signals[0]).not.toContain(OTHER_REPO_WORKTREE);
  });

  it("signals the worktree after a review action succeeds (S3)", async () => {
    signals.length = 0;
    await trpcMutate(
      server.url,
      "reviews.merge",
      { worktreeId: WORKTREE_A, method: "squash" },
      TOKEN,
    );
    await waitFor(async () => signals.length > 0, { timeoutMs: 5_000 });
    expect(signals[0]).toContain(WORKTREE_A);
  });
});
