import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRepoInfo, listWorktrees } from "../src/server/infra/git/git-client.ts";

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

  it("returns a SHA-based label for detached HEAD without rebase state", async () => {
    // Regression for the "blank workspace label" bug. A detached worktree
    // that isn't mid-rebase used to flow through with `branch: ""`, which
    // (a) rendered as a blank label next to the branch icon + "M" dirty
    // badge in `WorkspaceCard.tsx`, and (b) collided every detached
    // worktree in the same project onto the same `toWorkspaceId(...)`
    // output, breaking selection / pinning / the `data-testid` hook.
    //
    // `listWorktrees` now falls back to `detached-<short-sha>`, which is
    // non-empty, unique per HEAD, and `[a-z0-9-]`-only so it survives
    // every place `workspaceId` is used as a filesystem path component or
    // URL segment.
    const { repoPath, tmp } = createRepo();

    // Add a second commit so the detached HEAD has a distinct SHA from
    // any branch tip, which is the realistic shape of the failure mode
    // (`git checkout <some-old-sha>` inside a worktree).
    writeFileSync(join(repoPath, "file.txt"), "hello-v2");
    git(repoPath, ["add", "file.txt"]);
    git(repoPath, ["commit", "-m", "second"]);
    const detachedSha = git(repoPath, ["rev-parse", "HEAD~1"]).trim();

    const wtPath = join(tmp, "wt-plain-detached");
    git(repoPath, ["worktree", "add", "--detach", wtPath, detachedSha]);
    cleanups.push(() => git(repoPath, ["worktree", "remove", "--force", wtPath]));

    const worktrees = await listWorktrees(repoPath);

    const detached = worktrees.find((wt) => wt.path === wtPath);
    expect(detached).toBeDefined();
    expect(detached!.branch).toBe(`detached-${detachedSha.slice(0, 7)}`);
    // Spell the invariants out so a future refactor that re-introduces
    // empty branches or unsafe characters fails loudly here rather than
    // silently regressing the WorkspaceCard / toWorkspaceId chain.
    expect(detached!.branch).not.toBe("");
    expect(detached!.branch).toMatch(/^[a-z0-9-]+$/);
    expect(detached!.head).toBe(detachedSha);
  });

  it("gives two detached worktrees at different commits distinct branch labels", async () => {
    // The user-reported failure was ~9 detached worktrees in one project
    // all sharing the empty-string branch. Asserting uniqueness here pins
    // down the property that fixed it: two detached worktrees at
    // different SHAs map to different `branch` values, so
    // `toWorkspaceId(projectName, branch)` no longer collides.
    const { repoPath, tmp } = createRepo();

    const firstSha = git(repoPath, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repoPath, "file.txt"), "hello-v2");
    git(repoPath, ["add", "file.txt"]);
    git(repoPath, ["commit", "-m", "second"]);
    const secondSha = git(repoPath, ["rev-parse", "HEAD"]).trim();

    const wt1 = join(tmp, "wt-detached-a");
    const wt2 = join(tmp, "wt-detached-b");
    git(repoPath, ["worktree", "add", "--detach", wt1, firstSha]);
    cleanups.push(() => git(repoPath, ["worktree", "remove", "--force", wt1]));
    git(repoPath, ["worktree", "add", "--detach", wt2, secondSha]);
    cleanups.push(() => git(repoPath, ["worktree", "remove", "--force", wt2]));

    const worktrees = await listWorktrees(repoPath);
    const a = worktrees.find((wt) => wt.path === wt1);
    const b = worktrees.find((wt) => wt.path === wt2);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.branch).not.toBe(b!.branch);
    expect(a!.branch).toBe(`detached-${firstSha.slice(0, 7)}`);
    expect(b!.branch).toBe(`detached-${secondSha.slice(0, 7)}`);
  });
});

// `getRepoInfo` is best-effort metadata — issue #458. The two failure
// branches below ("not a git checkout" and "no origin remote") are
// expected steady states for some project directories, not error paths.
// These tests pin down that the function returns `null` cleanly for both,
// so the `hasOrigin` flag that `syncWorktrees` derives from it has a
// stable contract. The success branches exercise the three remote-URL
// formats `parseGitRemoteUrl` accepts (SCP-style SSH, `ssh://` scheme,
// HTTPS) — the `ssh://` case was added in response to PR #502 review.
describe("getRepoInfo", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    tmpDirs.length = 0;
  });

  it("returns null for a non-git directory", async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-no-git-")));
    tmpDirs.push(tmp);
    const info = await getRepoInfo(tmp);
    expect(info).toBeNull();
  });

  it("returns null when the repo has no `origin` remote", async () => {
    const { repoPath, tmp } = createRepo();
    tmpDirs.push(tmp);
    const info = await getRepoInfo(repoPath);
    expect(info).toBeNull();
  });

  it("parses an SCP-style SSH origin remote", async () => {
    const { repoPath, tmp } = createRepo();
    tmpDirs.push(tmp);
    git(repoPath, ["remote", "add", "origin", "git@github.com:band-app/band.git"]);
    const info = await getRepoInfo(repoPath);
    expect(info).toEqual({ host: "github.com", owner: "band-app", repo: "band" });
  });

  it("parses an `ssh://` scheme origin remote with user@", async () => {
    // `ssh://git@github.com/owner/repo.git` is what `gh repo clone`
    // emits for repos without SCP-style aliasing. Before #502 review
    // this fell into the `parseGitRemoteUrl` null branch and silently
    // set `hasOrigin = false`, permanently suppressing CI for the repo.
    const { repoPath, tmp } = createRepo();
    tmpDirs.push(tmp);
    git(repoPath, ["remote", "add", "origin", "ssh://git@github.com/band-app/band.git"]);
    const info = await getRepoInfo(repoPath);
    expect(info).toEqual({ host: "github.com", owner: "band-app", repo: "band" });
  });

  it("parses an `ssh://` scheme origin remote without user@", async () => {
    // The `[\w.-]+@` user-info component is optional in RFC 3986 — and
    // `ssh://github.com/owner/repo.git` is a valid clone URL that some
    // CI configs and `gh` paths emit. Originally the regex required
    // user@; the make-it-optional fix landed via #502 review.
    const { repoPath, tmp } = createRepo();
    tmpDirs.push(tmp);
    git(repoPath, ["remote", "add", "origin", "ssh://github.com/band-app/band.git"]);
    const info = await getRepoInfo(repoPath);
    expect(info).toEqual({ host: "github.com", owner: "band-app", repo: "band" });
  });

  it("strips the explicit port from an `ssh://` scheme origin", async () => {
    // Self-hosted Git servers commonly bind SSH on a non-22 port and
    // emit URLs like `ssh://git@gitea.example.com:2222/owner/repo.git`.
    // The host group must not capture the `:2222` — `gh --hostname` and
    // `parseBatchedCIResponse` both key on bare host. Bug surfaced via
    // #502 review.
    const { repoPath, tmp } = createRepo();
    tmpDirs.push(tmp);
    git(repoPath, ["remote", "add", "origin", "ssh://git@github.com:22/band-app/band.git"]);
    const info = await getRepoInfo(repoPath);
    expect(info).toEqual({ host: "github.com", owner: "band-app", repo: "band" });
  });

  it("parses an HTTPS origin remote", async () => {
    const { repoPath, tmp } = createRepo();
    tmpDirs.push(tmp);
    git(repoPath, ["remote", "add", "origin", "https://github.com/band-app/band.git"]);
    const info = await getRepoInfo(repoPath);
    expect(info).toEqual({ host: "github.com", owner: "band-app", repo: "band" });
  });
});
