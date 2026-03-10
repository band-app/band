import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncWorktrees } from "../src/lib/sync-state";
import type { AppState } from "../src/lib/state";

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

function writeState(bandHome: string, state: AppState): void {
  mkdirSync(bandHome, { recursive: true });
  writeFileSync(join(bandHome, "state.json"), JSON.stringify(state, null, 2));
}

function readState(bandHome: string): AppState {
  return JSON.parse(readFileSync(join(bandHome, "state.json"), "utf-8"));
}

describe("syncWorktrees", () => {
  let tmp: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-sync-test-")));
    originalHome = process.env.HOME;
    process.env.HOME = tmp;
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("adds worktree created outside Band", async () => {
    const repoPath = createRepo(tmp);
    const wtPath = join(tmp, "wt-feature");
    git(repoPath, ["worktree", "add", "-b", "feature", wtPath]);

    const bandHome = join(tmp, ".band");
    writeState(bandHome, {
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

    const state = readState(bandHome);
    expect(state.projects[0].worktrees.length).toBe(2);

    const mainWt = state.projects[0].worktrees.find(
      (wt) => wt.branch === "main",
    );
    expect(mainWt).toBeDefined();
    expect(mainWt!.path).toBe(repoPath);

    const featureWt = state.projects[0].worktrees.find(
      (wt) => wt.branch === "feature",
    );
    expect(featureWt).toBeDefined();
    expect(featureWt!.path).toBe(wtPath);
  });

  it("removes stale worktree from state", async () => {
    const repoPath = createRepo(tmp);

    const bandHome = join(tmp, ".band");
    writeState(bandHome, {
      projects: [
        {
          name: "test-project",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [
            { branch: "main", path: repoPath },
            { branch: "gone", path: join(tmp, "nonexistent-wt") },
          ],
        },
      ],
    });

    await syncWorktrees();

    const state = readState(bandHome);
    expect(state.projects[0].worktrees.length).toBe(1);
    expect(state.projects[0].worktrees[0].branch).toBe("main");
    expect(state.projects[0].worktrees[0].path).toBe(repoPath);
  });

  it("does not write state when already in sync", async () => {
    const repoPath = createRepo(tmp);
    const head = git(repoPath, ["rev-parse", "HEAD"]).trim();

    const bandHome = join(tmp, ".band");
    writeState(bandHome, {
      projects: [
        {
          name: "test-project",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoPath, head }],
        },
      ],
    });

    const stateFilePath = join(bandHome, "state.json");
    const mtimeBefore = statSync(stateFilePath).mtimeMs;

    // Small delay to ensure mtime would differ if file were rewritten
    await new Promise((r) => setTimeout(r, 50));

    await syncWorktrees();

    const mtimeAfter = statSync(stateFilePath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("skips projects where git fails", async () => {
    const repoPath = createRepo(tmp);
    const wtPath = join(tmp, "wt-feature");
    git(repoPath, ["worktree", "add", "-b", "feature", wtPath]);

    const bandHome = join(tmp, ".band");
    writeState(bandHome, {
      projects: [
        {
          name: "broken-project",
          path: join(tmp, "does-not-exist"),
          defaultBranch: "main",
          worktrees: [
            { branch: "stale", path: join(tmp, "does-not-exist", "wt") },
          ],
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

    const state = readState(bandHome);

    // Broken project keeps its stale worktrees (skipped)
    expect(state.projects[0].worktrees.length).toBe(1);
    expect(state.projects[0].worktrees[0].branch).toBe("stale");

    // Good project gets synced
    expect(state.projects[1].worktrees.length).toBe(2);
    expect(
      state.projects[1].worktrees.find((wt) => wt.branch === "feature"),
    ).toBeDefined();
  });
});
