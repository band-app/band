import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRepoInfo, listWorktrees } from "../src/lib/git.ts";

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

function createRepo(): { repoPath: string; tmp: string } {
  // Resolve symlinks (macOS /var -> /private/var) to match git's output
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-git-test-")));
  const repoPath = join(tmp, "repo");
  mkdirSync(repoPath);
  git(repoPath, ["init", "-b", "main"]);
  writeFileSync(join(repoPath, "file.txt"), "hello");
  git(repoPath, ["add", "file.txt"]);
  git(repoPath, ["commit", "-m", "initial"]);
  return { repoPath, tmp };
}

describe("listWorktrees", () => {
  const cleanups: (() => void)[] = [];

  afterEach(() => {
    for (const fn of cleanups.reverse()) {
      try {
        fn();
      } catch {}
    }
    cleanups.length = 0;
  });

  it("returns the main worktree with its branch", async () => {
    const { repoPath } = createRepo();
    const worktrees = await listWorktrees(repoPath);

    expect(worktrees.length).toBe(1);
    expect(worktrees[0].branch).toBe("main");
    expect(worktrees[0].path).toBe(repoPath);
    expect(worktrees[0].head).toBeTruthy();
    expect(worktrees[0].isBare).toBe(false);
  });

  it("returns named branch worktrees", async () => {
    const { repoPath, tmp } = createRepo();
    const wtPath = join(tmp, "wt-feature");
    git(repoPath, ["worktree", "add", "-b", "feature", wtPath]);
    cleanups.push(() => git(repoPath, ["worktree", "remove", "--force", wtPath]));

    const worktrees = await listWorktrees(repoPath);

    expect(worktrees.length).toBe(2);
    const feature = worktrees.find((wt) => wt.branch === "feature");
    expect(feature).toBeDefined();
    expect(feature!.path).toBe(wtPath);
  });

  it("resolves branch for detached HEAD with rebase-merge state", async () => {
    const { repoPath, tmp } = createRepo();

    // Create a detached worktree (simulates what git reports during rebase)
    const wtPath = join(tmp, "wt-detached");
    git(repoPath, ["worktree", "add", "--detach", wtPath, "HEAD"]);
    cleanups.push(() => git(repoPath, ["worktree", "remove", "--force", wtPath]));

    // Find the worktree's gitdir from its .git file
    const gitFileContent = readFileSync(join(wtPath, ".git"), "utf-8");
    const gitdir = gitFileContent.replace(/^gitdir:\s*/, "").trim();

    // Simulate an interactive rebase by creating rebase-merge/head-name
    const rebaseMergeDir = join(gitdir, "rebase-merge");
    mkdirSync(rebaseMergeDir, { recursive: true });
    writeFileSync(join(rebaseMergeDir, "head-name"), "refs/heads/my-rebasing-branch\n");

    const worktrees = await listWorktrees(repoPath);

    const detached = worktrees.find((wt) => wt.path === wtPath);
    expect(detached).toBeDefined();
    expect(detached!.branch).toBe("my-rebasing-branch");
  });

  it("resolves branch for detached HEAD with rebase-apply state", async () => {
    const { repoPath, tmp } = createRepo();

    const wtPath = join(tmp, "wt-detached-apply");
    git(repoPath, ["worktree", "add", "--detach", wtPath, "HEAD"]);
    cleanups.push(() => git(repoPath, ["worktree", "remove", "--force", wtPath]));

    const gitFileContent = readFileSync(join(wtPath, ".git"), "utf-8");
    const gitdir = gitFileContent.replace(/^gitdir:\s*/, "").trim();

    // Simulate a regular rebase (rebase-apply)
    const rebaseApplyDir = join(gitdir, "rebase-apply");
    mkdirSync(rebaseApplyDir, { recursive: true });
    writeFileSync(join(rebaseApplyDir, "head-name"), "refs/heads/my-applied-branch\n");

    const worktrees = await listWorktrees(repoPath);

    const detached = worktrees.find((wt) => wt.path === wtPath);
    expect(detached).toBeDefined();
    expect(detached!.branch).toBe("my-applied-branch");
  });

  it("returns empty branch for detached HEAD without rebase state", async () => {
    const { repoPath, tmp } = createRepo();

    const wtPath = join(tmp, "wt-plain-detached");
    git(repoPath, ["worktree", "add", "--detach", wtPath, "HEAD"]);
    cleanups.push(() => git(repoPath, ["worktree", "remove", "--force", wtPath]));

    const worktrees = await listWorktrees(repoPath);

    const detached = worktrees.find((wt) => wt.path === wtPath);
    expect(detached).toBeDefined();
    expect(detached!.branch).toBe("");
  });
});

// `getRepoInfo` is best-effort metadata — issue #458. The two failure
// branches below ("not a git checkout" and "no origin remote") are
// expected steady states for some project directories, not error paths.
// These tests pin down that the function returns `null` cleanly for both,
// so the `hasOrigin` flag that `syncWorktrees` derives from it has a
// stable contract.
describe("getRepoInfo", () => {
  it("returns null for a non-git directory", async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-no-git-")));
    const info = await getRepoInfo(tmp);
    expect(info).toBeNull();
  });

  it("returns null when the repo has no `origin` remote", async () => {
    const { repoPath } = createRepo();
    const info = await getRepoInfo(repoPath);
    expect(info).toBeNull();
  });

  it("parses an SSH origin remote", async () => {
    const { repoPath } = createRepo();
    git(repoPath, ["remote", "add", "origin", "git@github.com:band-app/band.git"]);
    const info = await getRepoInfo(repoPath);
    expect(info).toEqual({ host: "github.com", owner: "band-app", repo: "band" });
  });

  it("parses an HTTPS origin remote", async () => {
    const { repoPath } = createRepo();
    git(repoPath, ["remote", "add", "origin", "https://github.com/band-app/band.git"]);
    const info = await getRepoInfo(repoPath);
    expect(info).toEqual({ host: "github.com", owner: "band-app", repo: "band" });
  });
});
