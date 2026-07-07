// Regression test for the "locked worktrees resurrect forever" bug.
//
// Band's worktrees are locked by external tooling (e.g. `supacode`),
// which shows up as a `locked "{...,\"owner\":\"supacode\",...}"` line in
// `git worktree list --porcelain` — most likely to stop `git gc` /
// auto-prune from reclaiming a worktree while an agent is mid-flight.
// The lock is NOT applied by Band itself: `workspace-service.ts`'s
// `create` runs a plain `git worktree add` with no `--lock` flag.
//
// A locked worktree defeats BOTH branches of the old removal path in
// `WorkspaceService.remove`'s background cleanup:
//
//   1. `git worktree remove --force <path>` is REFUSED for a locked
//      worktree ("cannot remove a locked working tree") — a single
//      `--force` does not override a lock.
//   2. The catch-block fallback `rm -rf` + `git worktree prune` leaves
//      the admin record in `.git/worktrees/<id>/` behind, because
//      `git worktree prune` SKIPS locked entries.
//
// Net effect: the removed path survives in `git worktree list`, and
// `syncWorktrees` (`reconcileOneProject`) overwrites the persisted DB
// list with git's view on the next tick — re-adding the just-deleted
// workspace so it reappears in the UI forever.
//
// The fix unlocks the worktree (`git worktree unlock`) before removal
// and again before the prune fallback. This test boots the real
// server, creates a real LOCKED worktree, drives the real
// `workspaces.remove` mutation, and asserts:
//
//   1. `git worktree list --porcelain` no longer lists the removed
//      path once the background cleanup finishes.
//   2. The persisted `worktrees` row is gone.
//   3. A subsequent reconcile does NOT re-add it — exercised by booting
//      a FRESH server against the same home, whose boot-time
//      `syncWorktrees` (awaited before it listens) runs the real
//      reconcile against the cleaned git state, all over the real
//      process boundary.
//
// Integration-only — no mocks, no in-process calls to the system under
// test. Mirrors `workspace-remove-detached.test.ts`.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listWorktreeBranches } from "./helpers/db-read";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer, trpcMutate } from "./helpers/server";

const DEFAULT_TOKEN = "workspace-remove-locked-token";

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

// Absolute paths git currently tracks as worktrees, parsed from the
// porcelain `worktree <path>` lines. This is the invariant the fix is
// about: the removed path must NOT be here afterwards, even when the
// worktree was locked.
function listGitWorktreePaths(repoPath: string): string[] {
  const out = git(repoPath, ["worktree", "list", "--porcelain"]);
  return out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
}

describe("workspaces.remove on a locked worktree", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoPath: string;
  let featurePath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-locked-remove-");

    repoPath = join(tmpHome, "proj");
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, ["init", "-b", "main"]);
    writeFileSync(join(repoPath, "README.md"), "v1\n");
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-m", "v1"]);

    // Create a real worktree on a feature branch, then LOCK it with a
    // reason that mirrors the `owner` metadata external tooling writes.
    // The lock is what the old removal path could not clear.
    featurePath = join(tmpHome, "proj-feature");
    git(repoPath, ["worktree", "add", "-b", "feature", featurePath]);
    git(repoPath, ["worktree", "lock", "--reason", '{"owner":"supacode"}', featurePath]);

    seedState(tmpHome, {
      projects: [
        {
          name: "proj",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [
            { name: "main", branch: "main", path: repoPath },
            { name: "feature", branch: "feature", path: featurePath },
          ],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("rejects an unauthenticated remove and leaves the worktree registered", async () => {
    // The mutation is auth-gated; an unauthenticated call must not
    // remove anything. Raw fetch with no `band_token` cookie.
    const res = await fetch(`${server.url}/trpc/workspaces.remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "proj", name: "feature" }),
    });
    expect(res.status).toBe(401);

    // Positive anchor: the worktree is still registered, so the 401
    // short-circuited before any removal ran.
    expect(listWorktreeBranches(tmpHome, "proj").sort()).toEqual(["feature", "main"]);
    expect(listGitWorktreePaths(repoPath)).toContain(featurePath);
  });

  it("fully deregisters a locked worktree so a later sync can't resurrect it", async () => {
    // Sanity: the locked worktree exists in git and is registered.
    expect(listGitWorktreePaths(repoPath)).toContain(featurePath);
    expect(git(repoPath, ["worktree", "list", "--porcelain"])).toContain("locked");
    expect(listWorktreeBranches(tmpHome, "proj").sort()).toEqual(["feature", "main"]);

    const res = await trpcMutate(
      server.url,
      "workspaces.remove",
      { project: "proj", name: "feature" },
      DEFAULT_TOKEN,
    );
    const body = await res.text();
    expect(res.status, `unexpected status; body=${body}`).toBe(200);
    expect(JSON.parse(body)).toEqual({ result: { data: { ok: true } } });

    // The persisted row is dropped synchronously by the fast path.
    expect(listWorktreeBranches(tmpHome, "proj")).toEqual(["main"]);

    // The git deregistration is the crux — and it runs in a background
    // `setImmediate` task in the server process, so poll until the
    // locked path is gone from `git worktree list --porcelain`. Without
    // the unlock fix this never happens: the entry survives locked.
    await expect
      .poll(() => listGitWorktreePaths(repoPath), { timeout: 10_000, interval: 100 })
      .not.toContain(featurePath);

    // Prove the resurrection path is closed through the real boundary:
    // boot a FRESH server against the same home. Its boot-time
    // `runFirstTimeSetup` → `syncWorktrees` is awaited before the server
    // listens, so once `startServer` resolves the production reconcile
    // has already run against the cleaned git state. If the entry had
    // survived locked, reconcile would re-add `feature` here.
    await server.close();
    server = await startServer({ tmpHome });
    expect(listWorktreeBranches(tmpHome, "proj")).toEqual(["main"]);
  });
});
