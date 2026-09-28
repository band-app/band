// A workspace created while a worktree sync is running must stay listed.
//
// `syncWorktrees` loads the whole projects state, awaits git calls per
// project, and saves the whole state back when anything changed. A
// `workspaces.create` that saved its new row in between used to be wiped by
// that save, so `band workspaces list` right after `band workspaces create`
// could miss the new workspace (CLI test `workspaces_list_shows_created_worktrees`,
// CI run 36390074407).
//
// The test parks the server's boot sync on a remote: the project's `origin`
// is a git remote stub that holds every request, and the sync's
// `git remote set-head --auto` waits on it after the sync has loaded state
// and listed worktrees. While it waits, the test creates a workspace. On
// release the remote reports `trunk` as its default branch, so the sync has a
// change to save.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type GitRemoteStub, startGitRemoteStub } from "./fixtures/git-remote-stub";
import { listWorktreeNames } from "./helpers/db-read";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";

const TOKEN = "workspace-create-during-sync-token";

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

function readDefaultBranch(tmpHome: string, projectName: string): string | undefined {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"));
  try {
    const row = sqlite
      .prepare("SELECT default_branch FROM projects WHERE name = ?")
      .get(projectName) as { default_branch: string } | undefined;
    return row?.default_branch;
  } finally {
    sqlite.close();
  }
}

describe("workspaces.create while a worktree sync is running", () => {
  let tmpHome: string;
  let remote: GitRemoteStub;
  let server: ServerHandle;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-create-during-sync-");

    const repoPath = join(tmpHome, "proj");
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["commit", "--allow-empty", "-m", "init"]);

    const barePath = join(tmpHome, "remote", "origin.git");
    mkdirSync(barePath, { recursive: true });
    git(barePath, ["init", "--bare", "-b", "trunk"]);
    git(repoPath, ["push", barePath, "main:trunk"]);
    git(barePath, ["update-server-info"]);

    remote = await startGitRemoteStub(barePath);
    git(repoPath, ["remote", "add", "origin", remote.url]);
    // `set-head --auto` only points origin/HEAD at a branch it has a ref for.
    git(repoPath, ["update-ref", "refs/remotes/origin/trunk", "HEAD"]);

    seedState(tmpHome, {
      projects: [
        {
          name: "proj",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ name: "main", branch: "main", path: repoPath }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    remote?.release();
    await server?.close();
    await remote?.stop();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("rejects an unauthenticated create", async () => {
    const res = await fetch(`${server.url}/trpc/workspaces.create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: "proj", branch: "feat/unauth" }),
    });
    expect(res.status).toBe(401);
    expect(listWorktreeNames(tmpHome, "proj")).toEqual(["main"]);
  });

  it("keeps the new workspace when the sync saves after it", async () => {
    // The boot sync has loaded state and listed worktrees, and now waits on
    // the remote.
    await remote.firstRequest;

    const res = await trpcMutate(
      server.url,
      "workspaces.create",
      { project: "proj", branch: "feat/b" },
      TOKEN,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(listWorktreeNames(tmpHome, "proj")).toEqual(["feat/b", "main"]);

    remote.release();
    // The sync saves once it has the remote's default branch.
    await expect
      .poll(() => readDefaultBranch(tmpHome, "proj"), { timeout: 10_000, interval: 50 })
      .toBe("trunk");

    expect(listWorktreeNames(tmpHome, "proj")).toEqual(["feat/b", "main"]);
    const listed = await trpcData<{
      projects: Array<{ name: string; worktrees: Array<{ name: string }> }>;
    }>(await trpcQuery(server.url, "projects.list", undefined, TOKEN));
    const proj = listed.projects.find((p) => p.name === "proj");
    expect(proj?.worktrees.map((wt) => wt.name).sort()).toEqual(["feat/b", "main"]);
  });
});
