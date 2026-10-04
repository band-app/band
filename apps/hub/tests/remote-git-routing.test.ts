// A hub service must run git for a workspace on that workspace's host, and
// must not look at the workspace's checkout on the hub's own disk. This file
// seeds one workspace on a non-default branch with a modified file and an
// untracked file, then reads it through the changes, diff, graph, branch
// status and sync paths.
//
// In `BAND_TEST_HOST=remote-loopback` the workspace sits on a real
// `band-worker` and the hub process is guarded against touching the worktree
// path (`helpers/worker-fs-guard.mjs`), as it would be on a worker's own
// disk. The same assertions run against the local host.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toWorkspaceId } from "@band-app/shared/workspace-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { StatusStream } from "./helpers/status-stream";
import { waitFor } from "./helpers/wait-for";

const TOKEN = "remote-git-routing-token";
const PROJECT = "routed";
const WORKSPACE = "test";
const WORKSPACE_ID = toWorkspaceId(PROJECT, WORKSPACE);
const LIVE_BRANCH = "feature/live";

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

interface ChangeEntry {
  path: string;
  additions?: number;
}

interface Changes {
  headBranch: string;
  unstaged: ChangeEntry[];
  untracked: ChangeEntry[];
  branch: ChangeEntry[];
}

describe("git for a workspace runs on the workspace's host", () => {
  let tmpHome: string;
  let worktree: string;
  let server: ServerHandle;

  async function query<T>(procedure: string, input: unknown): Promise<T> {
    const res = await trpcQuery(server.url, procedure, input, TOKEN);
    expect(res.status, `${procedure} status`).toBe(200);
    return trpcData<T>(res);
  }

  beforeAll(async () => {
    tmpHome = createTmpHome("band-remote-git-routing-");
    const repo = join(tmpHome, PROJECT);
    worktree = join(tmpHome, "worktrees", WORKSPACE);
    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# routed\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "init"]);
    mkdirSync(join(tmpHome, "worktrees"));
    git(repo, ["worktree", "add", "-q", "-b", LIVE_BRANCH, worktree]);
    writeFileSync(join(worktree, "branch-only.txt"), "committed on the branch\n");
    git(worktree, ["add", "."]);
    git(worktree, ["commit", "-q", "-m", "branch commit"]);
    writeFileSync(join(worktree, "README.md"), "# routed\nedited\n");
    writeFileSync(join(worktree, "new.txt"), "one\ntwo\n");

    // The row still names `test` as the branch, as it does after the user
    // switched branches in a terminal: only git knows the live branch.
    seedState(tmpHome, {
      projects: [
        {
          name: PROJECT,
          path: repo,
          defaultBranch: "main",
          worktrees: [
            { branch: "main", path: repo },
            { name: WORKSPACE, branch: WORKSPACE, path: worktree },
          ],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ tmpHome });
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("getChanges reports the live branch and the edited and untracked files", async () => {
    const changes = await query<Changes>("workspace.getChanges", { workspaceId: WORKSPACE_ID });
    expect(changes.headBranch).toBe(LIVE_BRANCH);
    expect(changes.unstaged.map((e) => e.path)).toEqual(["README.md"]);
    expect(changes.untracked).toEqual([
      { path: "new.txt", status: "U", additions: 2, deletions: 0 },
    ]);
    expect(changes.branch.map((e) => e.path)).toEqual(["branch-only.txt"]);
  });

  it("getDiff shows the uncommitted edit and the untracked file", async () => {
    const { diff } = await query<{ diff: string }>("workspace.getDiff", {
      workspaceId: WORKSPACE_ID,
      diffMode: "uncommitted",
    });
    expect(diff).toContain("+edited");
    expect(diff).toContain("+two");
  });

  it("getFileDiff reads an untracked file from the worker", async () => {
    const { diff } = await query<{ diff: string }>("workspace.getFileDiff", {
      workspaceId: WORKSPACE_ID,
      filePath: "new.txt",
      section: "untracked",
    });
    expect(diff).toContain("+one");
  });

  it("the commit graph lists the branch's commit", async () => {
    const history = await query<{ commits: Array<{ subject: string }> }>(
      "workspace.getCommitHistory",
      { workspaceId: WORKSPACE_ID },
    );
    expect(history.commits.map((c) => c.subject)).toEqual(["branch commit", "init"]);
  });

  it("listBranches offers the other branch", async () => {
    const result = await query<{ branches: string[] }>("workspace.listBranches", {
      workspaceId: WORKSPACE_ID,
    });
    expect(result.branches).toContain("main");
  });

  it("stageFiles and discardChanges act on the worker's checkout", async () => {
    const staged = await trpcMutate(
      server.url,
      "workspace.stageFiles",
      { workspaceId: WORKSPACE_ID, paths: ["new.txt"] },
      TOKEN,
    );
    expect(staged.status).toBe(200);
    let changes = await query<Changes>("workspace.getChanges", { workspaceId: WORKSPACE_ID });
    expect(changes.untracked).toEqual([]);

    const discarded = await trpcMutate(
      server.url,
      "workspace.discardChanges",
      { workspaceId: WORKSPACE_ID, paths: ["new.txt"], section: "staged" },
      TOKEN,
    );
    expect(discarded.status).toBe(200);
    changes = await query<Changes>("workspace.getChanges", { workspaceId: WORKSPACE_ID });
    expect(changes.untracked).toEqual([]);
    expect(changes.unstaged.map((e) => e.path)).toEqual(["README.md"]);
  });

  it("branch status and sync follow the live checkout", async () => {
    const stream = await StatusStream.open(server.url, TOKEN);
    try {
      await waitFor(async () => stream.latest(WORKSPACE_ID)?.dirty === true, {
        timeoutMs: 15_000,
        label: "dirty branch status for the workspace",
      });
      // The poller's first tick syncs worktrees from git on the host.
      await waitFor(
        async () => {
          const { projects } = await query<{
            projects: Array<{ name: string; worktrees: Array<{ name: string; branch: string }> }>;
          }>("projects.list", undefined);
          const row = projects
            .find((p) => p.name === PROJECT)
            ?.worktrees.find((w) => w.name === WORKSPACE);
          return row?.branch === LIVE_BRANCH ? true : undefined;
        },
        { timeoutMs: 15_000, label: "sync picks up the live branch" },
      );
    } finally {
      stream.close();
    }
  });
});
