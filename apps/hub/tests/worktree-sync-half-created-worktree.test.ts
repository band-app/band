// A worktree sync must not save a worktree that `git worktree add` is still
// creating.
//
// `git worktree add` writes an all-zero `HEAD` into the new worktree before it
// points `HEAD` at the branch. A sync that listed worktrees in that window saw
// the new worktree detached, labelled it `detached-0000000`, and saved that as
// the row's immutable `name`. `worktrees.create` then found a row at its path
// and kept it, so the worktree it had just created was missing under its
// real id: its setup terminal failed with "Worktree not found" and
// `worktrees.remove` returned 500 (`worktree-setup-teardown.test.ts`, Release
// run 36410132680).
//
// The window lasts a few milliseconds, so the test freezes a worktree in it:
// a real `git worktree add`, then its `HEAD` and lock put back to what git
// writes before the branch is checked out. The branch-status poller syncs
// worktrees on its first tick, which a `status.stream` subscriber starts.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listWorktreeNames } from "./helpers/db-read";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcQuery,
} from "./helpers/server";
import { StatusStream } from "./helpers/status-stream";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "worktree-sync-half-created-token";
const REPO = "proj";

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

/** Start the poller and wait until its first tick, which syncs first, has polled `worktreeId`. */
async function syncThroughPoller(server: ServerHandle, worktreeId: string): Promise<void> {
  const stream = await StatusStream.open(server.url, TOKEN);
  try {
    await waitFor(async () => stream.latest(worktreeId), {
      timeoutMs: 20_000,
      label: `branch status of ${worktreeId}`,
    });
  } finally {
    stream.close();
  }
}

async function listedWorktreeNames(server: ServerHandle): Promise<string[]> {
  const { repos } = await trpcData<{
    repos: Array<{ name: string; worktrees: Array<{ name: string }> }>;
  }>(await trpcQuery(server.url, "repos.list", undefined, TOKEN));
  return (repos.find((p) => p.name === REPO)?.worktrees ?? []).map((wt) => wt.name).sort();
}

describe("worktree sync during git worktree add", () => {
  let tmpHome: string;
  let repoPath: string;
  let adminHead: string;
  let adminLock: string;
  let server: ServerHandle | undefined;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-sync-half-created-");
    repoPath = join(tmpHome, REPO);
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["commit", "--allow-empty", "-m", "init"]);

    const worktreePath = join(tmpHome, "half");
    git(repoPath, ["worktree", "add", "-b", "feat/half", worktreePath]);
    const adminDir = git(worktreePath, ["rev-parse", "--absolute-git-dir"]).trim();
    adminHead = join(adminDir, "HEAD");
    adminLock = join(adminDir, "locked");
    writeFileSync(adminHead, `${"0".repeat(40)}\n`);
    writeFileSync(adminLock, "initializing");

    seedState(tmpHome, {
      repos: [
        {
          name: REPO,
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ name: "main", branch: "main", path: repoPath }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ remoteHost: false, tmpHome });
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("refuses repos.list without the token", async () => {
    const res = await fetch(`${server?.url}/trpc/repos.list`);
    expect(res.status).toBe(401);
  });

  it("leaves the worktree out until git has checked out its branch", {
    timeout: 60_000,
  }, async () => {
    if (!server) throw new Error("server not started");
    await syncThroughPoller(server, toWorktreeId(REPO, "main", "local"));

    expect(listWorktreeNames(tmpHome, REPO)).toEqual(["main"]);
    expect(await listedWorktreeNames(server)).toEqual(["main"]);

    // What `git worktree add` does next: point HEAD at the branch, unlock.
    writeFileSync(adminHead, "ref: refs/heads/feat/half\n");
    rmSync(adminLock);
    // A restart runs the poller's first tick, and its sync, again.
    await server.close();
    server = await startServer({ remoteHost: false, tmpHome });
    await syncThroughPoller(server, toWorktreeId(REPO, "feat/half", "local"));

    expect(listWorktreeNames(tmpHome, REPO)).toEqual(["feat/half", "main"]);
    expect(await listedWorktreeNames(server)).toEqual(["feat/half", "main"]);
  });
});
