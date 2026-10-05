import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer } from "./helpers/server";
import { StatusStream } from "./helpers/status-stream";
import { waitFor } from "./helpers/wait-for";

// The git half of each worktree's branch status, as the poller pushes it on
// the status stream: one `git status --porcelain=v2 --branch` per worktree.

const TOKEN = "branch-status-git-token";
const REPO = "gitproj";
const BRANCHES = ["main", "local", "dirty", "ahead", "behind", "diverged", "gone", "conflict"];

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

function commit(cwd: string, file: string, content: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-q", "-m", `${file}: ${content}`]);
}

describe("branch status git fields", () => {
  let tmpHome: string;
  let server: ServerHandle;
  const paths: Record<string, string> = {};

  beforeAll(async () => {
    tmpHome = createTmpHome("band-branch-status-git-");
    const origin = join(tmpHome, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: gitEnv });
    const repo = join(tmpHome, REPO);
    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["remote", "add", "origin", origin]);
    commit(repo, "README.md", "base\n");
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    paths.main = repo;

    const worktree = (branch: string) => {
      const path = join(tmpHome, `${REPO}-${branch}`);
      git(repo, ["worktree", "add", "-q", "-b", branch, path, "main"]);
      paths[branch] = path;
      return path;
    };

    // No upstream, clean.
    worktree("local");

    // No upstream, an edited file.
    writeFileSync(join(worktree("dirty"), "README.md"), "edited\n");

    // One commit past its upstream.
    const ahead = worktree("ahead");
    git(ahead, ["push", "-q", "-u", "origin", "ahead"]);
    commit(ahead, "a.txt", "1\n");

    // Its upstream has two commits it lacks.
    const behind = worktree("behind");
    commit(behind, "b.txt", "1\n");
    commit(behind, "b.txt", "2\n");
    git(behind, ["push", "-q", "-u", "origin", "behind"]);
    git(behind, ["reset", "-q", "--hard", "HEAD~2"]);

    // One commit each way.
    const diverged = worktree("diverged");
    commit(diverged, "d.txt", "theirs\n");
    git(diverged, ["push", "-q", "-u", "origin", "diverged"]);
    git(diverged, ["reset", "-q", "--hard", "HEAD~1"]);
    commit(diverged, "d.txt", "ours\n");

    // An upstream that is configured but was deleted from the remote.
    const gone = worktree("gone");
    git(gone, ["push", "-q", "-u", "origin", "gone"]);
    git(gone, ["push", "-q", "origin", "--delete", "gone"]);
    git(gone, ["fetch", "-q", "--prune"]);

    // A merge stopped on a conflict in README.md.
    const conflict = worktree("conflict");
    git(repo, ["branch", "conflict-other", "main"]);
    commit(conflict, "README.md", "ours\n");
    const other = join(tmpHome, `${REPO}-conflict-other`);
    git(repo, ["worktree", "add", "-q", other, "conflict-other"]);
    commit(other, "README.md", "theirs\n");
    try {
      git(conflict, ["merge", "-q", "conflict-other"]);
    } catch {
      // Expected: the merge stops on the conflict.
    }

    seedState(tmpHome, {
      repos: [
        {
          name: REPO,
          path: repo,
          defaultBranch: "main",
          worktrees: BRANCHES.map((branch) => ({ branch, path: paths[branch] })),
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

  it("refuses a status stream without the token", async () => {
    // The upgrade handler drops the socket without a response.
    const ws = new WebSocket(`${server.url.replace(/^http/, "ws")}/trpc`);
    const outcome = await new Promise<string>((resolve) => {
      ws.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
      ws.once("open", () => resolve("open"));
    });
    ws.terminate();
    expect(outcome).toBe("ECONNRESET");
  });

  it("reports dirty, conflict, ahead/behind and sync state for each worktree", async () => {
    const stream = await StatusStream.open(server.url, TOKEN);
    const status = (branch: string) => stream.latest(toWorktreeId(REPO, branch));
    try {
      // The first tick's worktree sync also finds the `conflict-other` helper
      // worktree, so wait for these worktrees by name, not by count.
      await waitFor(async () => BRANCHES.every((branch) => status(branch)) || undefined, {
        timeoutMs: 20_000,
        label: "a branch status for every worktree",
      });
      const clean = { dirty: false, conflict: false, ahead: 0, behind: 0 };
      expect(status("main")).toEqual({ ...clean, sync_state: "synced" });
      expect(status("local")).toEqual({ ...clean, sync_state: "untracked" });
      expect(status("dirty")).toEqual({ ...clean, dirty: true, sync_state: "untracked" });
      expect(status("ahead")).toEqual({ ...clean, ahead: 1, sync_state: "ahead" });
      expect(status("behind")).toEqual({ ...clean, behind: 2, sync_state: "behind" });
      expect(status("diverged")).toEqual({
        ...clean,
        ahead: 1,
        behind: 1,
        sync_state: "diverged",
      });
      expect(status("gone")).toEqual({ ...clean, sync_state: "untracked" });
      expect(status("conflict")).toEqual({
        ...clean,
        dirty: true,
        conflict: true,
        sync_state: "untracked",
      });
    } finally {
      stream.close();
    }
  });
});
