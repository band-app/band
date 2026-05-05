/**
 * Integration test for git branch detection.
 *
 * Uses a real `git init` in a temp directory and asserts the function
 * returns the actual branch name. No mocks.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { getCurrentBranch } from "../src/main/services/git.ts";

function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, {
    cwd,
    stdio: "ignore",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
  }
}

describe("git", () => {
  test("returns the current branch name in a real repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "band-desktop-git-"));
    try {
      git(dir, ["init", "-b", "main", "--quiet"]);
      git(dir, ["config", "user.email", "test@example.com"]);
      git(dir, ["config", "user.name", "Test"]);
      git(dir, ["commit", "--allow-empty", "-m", "init", "--quiet"]);
      git(dir, ["checkout", "-b", "feature/widgets", "--quiet"]);

      assert.equal(getCurrentBranch(dir), "feature/widgets");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns null outside a git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "band-desktop-non-git-"));
    try {
      assert.equal(getCurrentBranch(dir), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
