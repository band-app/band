import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
} from "./helpers/server";
import { StatusStream } from "./helpers/status-stream";
import { waitFor } from "./helpers/wait-for";

// `statuses.refreshBranchStatus` re-reads one worktree's git status on
// demand (the dashboard calls it when the user selects a worktree) and
// pushes it on the status stream, without waiting for the next poll tick.

const TOKEN = "branch-status-refresh-token";
const REPO = "refreshproj";
const WORKTREE_ID = toWorktreeId(REPO, "main", "local");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: gitEnv, stdio: "ignore" });
}

describe("statuses.refreshBranchStatus", () => {
  let tmpHome: string;
  let repo: string;
  let server: ServerHandle;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-branch-status-refresh-");
    repo = join(tmpHome, REPO);
    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# refresh\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "init"]);
    seedState(tmpHome, {
      repos: [
        {
          name: REPO,
          path: repo,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repo }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ tmpHome });
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("refuses a request without the token", async () => {
    const res = await fetch(`${server.url}/trpc/statuses.refreshBranchStatus`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktreeId: WORKTREE_ID }),
    });
    expect(res.status).toBe(401);
  });

  it("reports refreshed: false for an unknown worktree", async () => {
    const res = await trpcMutate(
      server.url,
      "statuses.refreshBranchStatus",
      { worktreeId: "no-such-worktree" },
      TOKEN,
    );
    expect(res.status).toBe(200);
    expect(await trpcData(res)).toEqual({ refreshed: false });
  });

  it("pushes the worktree's current git status without waiting for a tick", async () => {
    const stream = await StatusStream.open(server.url, TOKEN);
    try {
      // The subscription starts the poller; its first tick sees a clean tree.
      await waitFor(async () => stream.latest(WORKTREE_ID), { label: "first poll tick" });
      expect(stream.latest(WORKTREE_ID)?.dirty).toBe(false);
      // The next tick is now 60 s away, so only the refresh can report the edit.
      const activity = await trpcMutate(
        server.url,
        "services.setActivity",
        { activity: "background" },
        TOKEN,
      );
      expect(activity.status).toBe(200);
      writeFileSync(join(repo, "README.md"), "# edited\n");

      const res = await trpcMutate(
        server.url,
        "statuses.refreshBranchStatus",
        { worktreeId: WORKTREE_ID },
        TOKEN,
      );
      expect(res.status).toBe(200);
      expect(await trpcData(res)).toEqual({ refreshed: true });
      await waitFor(async () => stream.latest(WORKTREE_ID)?.dirty === true, {
        timeoutMs: 5_000,
        label: "refreshed status on the stream",
      });
      expect(stream.latest(WORKTREE_ID)).toEqual({
        dirty: true,
        conflict: false,
        ahead: 0,
        behind: 0,
        sync_state: "untracked",
      });
    } finally {
      stream.close();
    }
  });
});
