// A hub service must run git for a worktree on that worktree's host, and
// must not look at the worktree's checkout on the hub's own disk. This file
// seeds one worktree on a non-default branch with a modified file and an
// untracked file, then reads it through the changes, diff, graph, branch
// status and sync paths.
//
// In `BAND_TEST_HOST=remote-loopback` the worktree sits on a real
// `band-worker` and the hub process is guarded against touching the worktree
// path (`helpers/worker-fs-guard.mjs`), as it would be on a worker's own
// disk. The same assertions run against the local host.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { toWorktreeId } from "@band-app/shared/worktree-id";
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
const REPO = "routed";
const WORKTREE = "test";
const WORKTREE_ID = toWorktreeId(REPO, WORKTREE, "local");
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
  staged: ChangeEntry[];
  unstaged: ChangeEntry[];
  untracked: ChangeEntry[];
  branch: ChangeEntry[];
}

/** Reads rows the hub persisted, through a read-only connection to its database. */
function readDb<T>(home: string, sql: string, ...params: string[]): T[] {
  const db = new DatabaseSync(join(home, ".band", "band.db"), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

describe("git for a worktree runs on the worktree's host", () => {
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
    const repo = join(tmpHome, REPO);
    worktree = join(tmpHome, "worktrees", WORKTREE);
    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "README.md"), "# routed\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "init"]);
    mkdirSync(join(tmpHome, "worktrees"));
    // A local bare origin, so the push test has somewhere to push to.
    const origin = join(tmpHome, "origin.git");
    git(tmpHome, ["init", "-q", "--bare", origin]);
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["worktree", "add", "-q", "-b", LIVE_BRANCH, worktree]);
    writeFileSync(join(worktree, "branch-only.txt"), "committed on the branch\n");
    git(worktree, ["add", "."]);
    git(worktree, ["commit", "-q", "-m", "branch commit"]);
    writeFileSync(join(worktree, "README.md"), "# routed\nedited\n");
    writeFileSync(join(worktree, "new.txt"), "one\ntwo\n");

    // The row still names `test` as the branch, as it does after the user
    // switched branches in a terminal: only git knows the live branch.
    seedState(tmpHome, {
      repos: [
        {
          name: REPO,
          path: repo,
          defaultBranch: "main",
          worktrees: [
            { branch: "main", path: repo },
            { name: WORKTREE, branch: WORKTREE, path: worktree },
          ],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ tmpHome });
  }, 60_000);

  afterAll(async () => {
    try {
      await server?.close();
    } finally {
      rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("rejects a request without a token", async () => {
    const input = encodeURIComponent(JSON.stringify({ worktreeId: WORKTREE_ID }));
    const res = await fetch(`${server.url}/trpc/worktree.getChanges?input=${input}`);
    expect(res.status).toBe(401);
  });

  it("getChanges reports the live branch and the edited and untracked files", async () => {
    const changes = await query<Changes>("worktree.getChanges", { worktreeId: WORKTREE_ID });
    expect(changes.headBranch).toBe(LIVE_BRANCH);
    expect(changes.unstaged.map((e) => e.path)).toEqual(["README.md"]);
    expect(changes.untracked).toEqual([
      { path: "new.txt", status: "U", additions: 2, deletions: 0 },
    ]);
    expect(changes.branch.map((e) => e.path)).toEqual(["branch-only.txt"]);
  });

  it("getDiff shows the uncommitted edit and the untracked file", async () => {
    const { diff } = await query<{ diff: string }>("worktree.getDiff", {
      worktreeId: WORKTREE_ID,
      diffMode: "uncommitted",
    });
    expect(diff).toContain("+edited");
    expect(diff).toContain("+two");
  });

  it("getFileDiff reads an untracked file from the worker", async () => {
    const { diff } = await query<{ diff: string }>("worktree.getFileDiff", {
      worktreeId: WORKTREE_ID,
      filePath: "new.txt",
      section: "untracked",
    });
    expect(diff).toContain("+one");
  });

  it("the commit graph lists the branch's commit", async () => {
    const history = await query<{ commits: Array<{ subject: string }> }>(
      "worktree.getCommitHistory",
      { worktreeId: WORKTREE_ID },
    );
    expect(history.commits.map((c) => c.subject)).toEqual(["branch commit", "init"]);
  });

  it("listBranches offers the other branch", async () => {
    const result = await query<{ branches: string[] }>("worktree.listBranches", {
      worktreeId: WORKTREE_ID,
    });
    // The checked-out branch is not offered.
    expect(result.branches).toEqual(["main"]);
  });

  // These steps change the checkout in order: later tests run after new.txt is gone.
  it("stageFiles and discardChanges act on the worker's checkout", async () => {
    const staged = await trpcMutate(
      server.url,
      "worktree.stageFiles",
      { worktreeId: WORKTREE_ID, paths: ["new.txt"] },
      TOKEN,
    );
    expect(staged.status).toBe(200);
    let changes = await query<Changes>("worktree.getChanges", { worktreeId: WORKTREE_ID });
    expect(changes.staged.map((e) => e.path)).toEqual(["new.txt"]);
    expect(changes.untracked).toEqual([]);

    const discarded = await trpcMutate(
      server.url,
      "worktree.discardChanges",
      { worktreeId: WORKTREE_ID, paths: ["new.txt"], section: "staged" },
      TOKEN,
    );
    expect(discarded.status).toBe(200);
    changes = await query<Changes>("worktree.getChanges", { worktreeId: WORKTREE_ID });
    expect(changes.staged).toEqual([]);
    expect(changes.untracked).toEqual([]);
    expect(changes.unstaged.map((e) => e.path)).toEqual(["README.md"]);
  });

  it("gitPush pushes from the worker's checkout and records its head", async () => {
    const res = await trpcMutate(
      server.url,
      "worktree.gitPush",
      { worktreeId: WORKTREE_ID },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, env: gitEnv })
      .toString()
      .trim();
    const rows = readDb<{ sha: string }>(
      tmpHome,
      "SELECT sha FROM pushed_shas WHERE worktree_id = ?",
      WORKTREE_ID,
    );
    expect(rows.map((r) => r.sha)).toEqual([head]);
  });

  it("branch status and sync follow the live checkout", async () => {
    const stream = await StatusStream.open(server.url, TOKEN);
    try {
      await waitFor(async () => stream.latest(WORKTREE_ID)?.dirty === true, {
        timeoutMs: 15_000,
        label: "dirty branch status for the worktree",
      });
      // The sync tick persists the branch git reports on the host. `repos.list`
      // refreshes remote rows without saving them, so read the stored row.
      await waitFor(
        async () => {
          const rows = readDb<{ branch: string }>(
            tmpHome,
            "SELECT branch FROM worktrees WHERE repo_name = ? AND name = ?",
            REPO,
            WORKTREE,
          );
          return rows[0]?.branch === LIVE_BRANCH ? true : undefined;
        },
        { timeoutMs: 15_000, label: "sync stores the live branch" },
      );
      // The hub's own git can see a worker's worktree on loopback. Sync must
      // not add it a second time as a local worktree.
      expect(
        readDb<{ name: string }>(tmpHome, "SELECT name FROM worktrees WHERE path = ?", worktree),
      ).toEqual([{ name: WORKTREE }]);
    } finally {
      stream.close();
    }
  });
});
