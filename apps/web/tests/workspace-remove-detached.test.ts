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
// Integration-only — no mocks, no internal imports. Same shape as
// `task-cleanup.test.ts`, just without the SQLite task-table writes.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detachedShaLabel } from "../src/lib/git";
import { seedSettings, seedState } from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

// TODO: extract `createTmpHome`, `getRandomPort`, and `startServer`
// into `apps/web/tests/helpers/server.ts`. The same shape is now
// duplicated across `trpc.test.ts`, `task-cleanup.test.ts`,
// `trpc-batch-url.test.ts`, and this file, and the copies have
// already started drifting (e.g. the `close()` SIGKILL fallback
// added here is missing in `trpc.test.ts`). A future PR should
// consolidate them — kept inline here to keep the regression fix
// focused on the bug.

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_TOKEN = "workspace-remove-detached-token";

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-detached-remove-")));
  mkdirSync(join(tmp, ".band"), { recursive: true });
  return tmp;
}

function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function startServer(tmpHome: string): Promise<ServerHandle> {
  const port = await getRandomPort();
  return new Promise((resolve, reject) => {
    const child = spawn(SERVER_RUNTIME, [SERVER_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: tmpHome,
        PORT: String(port),
        NODE_ENV: "production",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let settled = false;
    child.stderr!.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.stdout!.on("data", (c: Buffer) => {
      if (c.toString().includes("listening") && !settled) {
        settled = true;
        resolve({
          url: `http://127.0.0.1:${port}`,
          home: tmpHome,
          close: () =>
            new Promise<void>((r) => {
              const fallback = setTimeout(() => child.kill("SIGKILL"), 5_000);
              child.on("exit", () => {
                clearTimeout(fallback);
                r();
              });
              child.kill("SIGTERM");
            }),
        });
      }
    });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`server exited with code ${code}\nstderr: ${stderr}`));
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`server did not start within 15 s\nstderr: ${stderr}`));
      }
    }, 15_000);
  });
}

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
    tmpHome = createTmpHome();

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

    // Build the synthetic label via `detachedShaLabel` rather than
    // re-spelling the format inline. That way a change to the label
    // shape (length, prefix, …) flows into the test automatically and
    // the regression keeps exercising the real code path.
    detachedBranch = detachedShaLabel(olderSha);

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

    server = await startServer(tmpHome);
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
