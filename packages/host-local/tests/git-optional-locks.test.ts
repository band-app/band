import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execGit } from "../src/git/git-client.ts";

// Band polls `git status` in the background. A plain `git status` takes `index.lock` while it
// refreshes the index, so a commit or reset the user runs at the same moment fails with
// "Unable to create index.lock". `execGit` must run reads without the optional lock.
test("execGit status never holds index.lock, so a concurrent write does not fail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "band-optional-locks-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
        stdio: "ignore",
      });
    git("init", "-b", "main");
    mkdirSync(join(dir, "files"));
    const names: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const name = join("files", `f${i}.txt`);
      writeFileSync(join(dir, name), `${i}\n`);
      names.push(name);
    }
    git("add", ".");
    git("commit", "-m", "init");

    const lock = join(dir, ".git", "index.lock");
    for (let round = 0; round < 5; round++) {
      // New mtimes make the stored stat data stale, so a status has an index refresh to write.
      const future = new Date(Date.now() + (round + 1) * 60_000);
      for (const name of names) utimesSync(join(dir, name), future, future);
      let sawLock = false;
      let done = false;
      const status = execGit(["status", "--porcelain"], dir).finally(() => {
        done = true;
      });
      while (!done) {
        if (existsSync(lock)) sawLock = true;
        await new Promise((resolve) => setImmediate(resolve));
      }
      await status;
      assert.equal(sawLock, false, `git status held index.lock in round ${round}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
