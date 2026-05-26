// Regression test for the PR-review blocker on the detached-HEAD label
// fix. `listWorktrees` now returns `detached-<short-sha>` for a
// detached worktree, and the dashboard sends that back to the
// `workspaces.remove` mutation when the user clicks "Delete
// workspace". The mutation used to re-parse `git worktree list
// --porcelain` inline with no SHA fallback, so the lookup at
// `currentBranch === input.branch` never matched and the call ended
// in `throw new Error('Workspace "detached-abc1234" not found')` —
// breaking the delete action on every detached-HEAD card.
//
// The fix routes `workspaces.remove` through `listWorktrees` so the
// same SHA fallback applies on both ends. This test boots the real
// server, creates a real detached-HEAD worktree, sends the synthetic
// `detached-<sha>` label to the mutation, and asserts:
//
//   1. The mutation returns 200 (no "not found" throw).
//   2. The persisted `worktrees` row for that branch is gone after.
//
// Integration-only — no mocks, no internal-module imports for the
// system under test.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer } from "./helpers/server";

const DEFAULT_TOKEN = "workspace-remove-detached-token";

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

// Read directly from SQLite rather than going through `projects.list`
// over tRPC. The mutation's effect on the persisted state is the
// invariant we're pinning here, and reading via the same DB the server
// writes to keeps the assertion independent of an unrelated endpoint's
// behaviour. (Same pattern as `task-cleanup.test.ts`.)
function listWorktreeBranches(tmpHome: string, projectName: string): string[] {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"));
  try {
    const rows = sqlite
      .prepare("SELECT branch FROM worktrees WHERE project_name = ? ORDER BY branch")
      .all(projectName) as Array<{ branch: string }>;
    return rows.map((r) => r.branch);
  } finally {
    sqlite.close();
  }
}

describe("workspaces.remove on a detached-HEAD worktree", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let detachedBranch: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-detached-remove-");

    // Real repo with two commits so we can check out the older SHA in
    // the detached worktree. The shape (main + a detached HEAD parked
    // on an older commit) is exactly the user-reported failure mode.
    const repoPath = join(tmpHome, "proj");
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, ["init", "-b", "main"]);
    writeFileSync(join(repoPath, "README.md"), "v1\n");
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-m", "v1"]);
    const olderSha = git(repoPath, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repoPath, "README.md"), "v2\n");
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-m", "v2"]);

    const detachedPath = join(tmpHome, "proj-detached");
    git(repoPath, ["worktree", "add", "--detach", detachedPath, olderSha]);

    // Spell the synthetic label inline rather than importing
    // `detachedShaLabel` from `src/lib/git.ts`. This is a black-box
    // integration test — keeping the label format inline means that
    // if `detachedShaLabel` is ever changed (different prefix,
    // different sha length), the seed and the server's reconciled
    // view diverge and the assertions fail loudly, which is exactly
    // the signal we want. The format is also pinned by `git.test.ts`
    // unit tests, so two redundant checks guard against silent drift.
    detachedBranch = `detached-${olderSha.slice(0, 7)}`;

    seedState(tmpHome, {
      projects: [
        {
          name: "proj",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [
            { branch: "main", path: repoPath },
            { branch: detachedBranch, path: detachedPath },
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

  it("removes the detached worktree without throwing 'Workspace not found'", async () => {
    // Sanity: both worktrees survived the server boot and the
    // background reconcile pass — the latter writes `detached-<sha>`
    // via the same `listWorktrees` path, so it should agree with the
    // seed.
    expect(listWorktreeBranches(tmpHome, "proj").sort()).toEqual(["main", detachedBranch].sort());

    const res = await fetch(`${server.url}/trpc/workspaces.remove`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `band_token=${DEFAULT_TOKEN}`,
      },
      body: JSON.stringify({ project: "proj", branch: detachedBranch }),
    });
    const body = await res.text();

    // The pre-fix bug was a TRPCError with message ending in
    // `Workspace "detached-<sha>" not found`. Pin both the status and
    // the body so a future regression that returns 200 with an error
    // payload also fails the assertion.
    expect(res.status, `unexpected status; body=${body}`).toBe(200);
    expect(body).not.toContain("not found");

    // The persisted row for the detached branch must be gone; `main`
    // must still be there (the filter has to be branch-scoped).
    expect(listWorktreeBranches(tmpHome, "proj")).toEqual(["main"]);
  });
});
