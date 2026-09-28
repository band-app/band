/**
 * Utility-level white-box tests for `syncWorktrees` — drives the
 * function against a real git repo + a real SQLite DB in a per-case
 * tmpdir (via `BAND_HOME`). Matches the precedent set by
 * `git.test.ts` and `fuzzy-score.test.ts`: these exercise non-
 * networked infra/service helpers whose contract is too fine-grained
 * for the integration suite (no tRPC surface, no HTTP boundary).
 *
 * The repo's general doctrine is black-box integration tests via the
 * real server — see CLAUDE.md and the `write-integration-test` skill.
 * That doctrine continues to apply to any test that touches a tRPC
 * procedure or driver-level UI.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "../src/server/infra/db/connection";
import { loadState, saveState } from "../src/server/services/state";
import { syncWorktrees } from "../src/server/services/sync-service";

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

function createRepo(tmp: string, name = "repo"): string {
  const repoPath = join(tmp, name);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", "main"]);
  writeFileSync(join(repoPath, "file.txt"), "hello");
  git(repoPath, ["add", "file.txt"]);
  git(repoPath, ["commit", "-m", "initial"]);
  return repoPath;
}

describe("syncWorktrees", () => {
  let tmp: string;
  let originalBandHome: string | undefined;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-sync-test-")));
    originalBandHome = process.env.BAND_HOME;
    process.env.BAND_HOME = join(tmp, ".band");
  });

  afterEach(() => {
    closeDb();
    if (originalBandHome !== undefined) {
      process.env.BAND_HOME = originalBandHome;
    } else {
      delete process.env.BAND_HOME;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("adds worktree created outside Band", async () => {
    const repoPath = createRepo(tmp);
    const wtPath = join(tmp, "wt-feature");
    git(repoPath, ["worktree", "add", "-b", "feature", wtPath]);

    saveState({
      projects: [
        {
          name: "test-project",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [],
        },
      ],
    });

    await syncWorktrees();

    const state = loadState();
    expect(state.projects[0].worktrees.length).toBe(2);

    const mainWt = state.projects[0].worktrees.find((wt) => wt.branch === "main");
    expect(mainWt).toBeDefined();
    expect(mainWt!.path).toBe(repoPath);

    const featureWt = state.projects[0].worktrees.find((wt) => wt.branch === "feature");
    expect(featureWt).toBeDefined();
    expect(featureWt!.path).toBe(wtPath);
  });

  it("removes stale worktree from state", async () => {
    const repoPath = createRepo(tmp);

    saveState({
      projects: [
        {
          name: "test-project",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [
            { name: "main", branch: "main", path: repoPath },
            { name: "gone", branch: "gone", path: join(tmp, "nonexistent-wt") },
          ],
        },
      ],
    });

    await syncWorktrees();

    const state = loadState();
    expect(state.projects[0].worktrees.length).toBe(1);
    expect(state.projects[0].worktrees[0].branch).toBe("main");
    expect(state.projects[0].worktrees[0].path).toBe(repoPath);
  });

  it("does not write state when already in sync", async () => {
    const repoPath = createRepo(tmp);
    const head = git(repoPath, ["rev-parse", "HEAD"]).trim();

    // Seed `hasOrigin: false` to match reality — `createRepo` doesn't add
    // an origin remote, so `syncWorktrees` would otherwise rewrite the
    // default `true` to `false` and the "no write" assertion below would
    // fail. See `ProjectState.hasOrigin` and issue #458.
    saveState({
      projects: [
        {
          name: "test-project",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ name: "main", branch: "main", path: repoPath, head }],
          hasOrigin: false,
        },
      ],
    });

    const stateBefore = loadState();

    await syncWorktrees();

    const stateAfter = loadState();
    // Data should be identical — syncWorktrees should not have written
    expect(stateAfter).toEqual(stateBefore);
  });

  // `hasOrigin` is the persisted "should we even probe CI for this
  // project" flag introduced for issue #458. It must flip between true
  // and false based on whether the on-disk repo has an `origin` remote,
  // so the branch-status poller can skip the CI query without a
  // per-tick `git remote get-url origin` retry / cache.
  it("sets hasOrigin=true when the repo has an origin remote", async () => {
    const repoPath = createRepo(tmp);
    // A fake remote URL is fine — `getRepoInfo` only cares that the
    // ref exists and parses, not that the URL is reachable.
    git(repoPath, ["remote", "add", "origin", "git@github.com:band-app/band.git"]);

    saveState({
      projects: [
        {
          name: "with-origin",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ name: "main", branch: "main", path: repoPath }],
          hasOrigin: false, // seeded false so we can prove the sync flips it
        },
      ],
    });

    await syncWorktrees();

    expect(loadState().projects[0].hasOrigin).toBe(true);
  });

  it("sets hasOrigin=false when the repo has no origin remote", async () => {
    const repoPath = createRepo(tmp);
    // No `git remote add` here — the seeded `hasOrigin: true` (the
    // schema default for fresh projects, see `projects.add`) should be
    // overwritten by the sync.

    saveState({
      projects: [
        {
          name: "no-origin",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ name: "main", branch: "main", path: repoPath }],
          hasOrigin: true,
        },
      ],
    });

    await syncWorktrees();

    expect(loadState().projects[0].hasOrigin).toBe(false);
  });

  it("skips projects where git fails", async () => {
    const repoPath = createRepo(tmp);
    const wtPath = join(tmp, "wt-feature");
    git(repoPath, ["worktree", "add", "-b", "feature", wtPath]);

    saveState({
      projects: [
        {
          name: "broken-project",
          path: join(tmp, "does-not-exist"),
          defaultBranch: "main",
          worktrees: [{ name: "stale", branch: "stale", path: join(tmp, "does-not-exist", "wt") }],
        },
        {
          name: "good-project",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [],
        },
      ],
    });

    await syncWorktrees();

    const state = loadState();

    // Broken project keeps its stale worktrees (skipped)
    expect(state.projects[0].worktrees.length).toBe(1);
    expect(state.projects[0].worktrees[0].branch).toBe("stale");

    // Good project gets synced
    expect(state.projects[1].worktrees.length).toBe(2);
    expect(state.projects[1].worktrees.find((wt) => wt.branch === "feature")).toBeDefined();
  });

  // Regression: the `pinned` flag is dashboard-state, not git-state — it
  // must survive every sync cycle even though `git worktree list` knows
  // nothing about it. Without the preservation logic in `sync-service.ts`
  // the merge would overwrite a pinned worktree with a fresh-from-git
  // entry whose pinned flag defaults to `undefined`/`false`.
  it("preserves the pinned flag on a synced worktree", async () => {
    const repoPath = createRepo(tmp);
    const head = git(repoPath, ["rev-parse", "HEAD"]).trim();

    saveState({
      projects: [
        {
          name: "pin-test",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ name: "main", branch: "main", path: repoPath, head, pinned: true }],
          hasOrigin: false,
        },
      ],
    });

    await syncWorktrees();

    const state = loadState();
    expect(state.projects[0].worktrees.length).toBe(1);
    expect(state.projects[0].worktrees[0].pinned).toBe(true);
  });

  // Regression (workspace `name` field): the immutable `name` identity must
  // survive a git branch switch inside the worktree — that is the whole
  // point of decoupling identity from `branch`. Sync reconciles the live
  // `branch` to match git but leaves `name` (and thus the workspace id)
  // untouched, so panels/chats/labels keyed by the id are not orphaned when
  // the user switches branches. `pinned` rides along on the same path-keyed
  // merge.
  it("preserves name (and pinned) but updates branch when the git branch is switched", async () => {
    const repoPath = createRepo(tmp);
    const wtPath = join(tmp, "wt-feature");
    git(repoPath, ["worktree", "add", "-b", "feature", wtPath]);

    saveState({
      projects: [
        {
          name: "switch-test",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [
            { name: "main", branch: "main", path: repoPath },
            { name: "feature", branch: "feature", path: wtPath, pinned: true },
          ],
          hasOrigin: false,
        },
      ],
    });

    // Switch the branch checked out in the feature worktree. The path is
    // stable; only the branch changes.
    git(wtPath, ["switch", "-c", "feature-renamed"]);

    await syncWorktrees();

    const wt = loadState().projects[0].worktrees.find((w) => w.path === wtPath);
    expect(wt).toBeDefined();
    // Identity frozen at creation…
    expect(wt!.name).toBe("feature");
    // …while the live branch tracks git.
    expect(wt!.branch).toBe("feature-renamed");
    // Dashboard-only metadata survives the path-keyed merge too.
    expect(wt!.pinned).toBe(true);
  });
});
