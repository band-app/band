/**
 * Deleting the open worktree focuses the worktree it was started from, in any repo, and falls back
 * to the repo's default-branch worktree when it has no parent or the parent is gone. Deleting a
 * worktree that is not open leaves the open one alone.
 *
 * Real production server, real git repos, seeded origin links. No tRPC mocking.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gitInHome } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-delete-focus-parent-token";

test.use({ viewport: { width: 1280, height: 900 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const makeRepo = (name: string) => {
    const path = join(tmpHome, name);
    mkdirSync(path, { recursive: true });
    gitInHome(path, ["init", "-b", "main"], tmpHome);
    writeFileSync(join(path, "README.md"), `# ${name}\n`);
    gitInHome(path, ["add", "."], tmpHome);
    gitInHome(path, ["commit", "-m", "initial"], tmpHome);
    return path;
  };
  const extra = (repoPath: string, branch: string) => {
    const path = join(tmpHome, `${branch}-checkout`);
    gitInHome(repoPath, ["worktree", "add", "-b", branch, path], tmpHome);
    return path;
  };
  const alpha = makeRepo("alpha");
  const beta = makeRepo("beta");
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  seedState(tmpHome, {
    repos: [
      {
        name: "alpha",
        path: alpha,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: alpha },
          { branch: "parent", path: extra(alpha, "parent") },
          { branch: "s1", path: extra(alpha, "s1"), origin: "alpha-parent" },
          { branch: "s2", path: extra(alpha, "s2") },
          { branch: "s3", path: extra(alpha, "s3"), origin: "alpha-vanished" },
          { branch: "s4", path: extra(alpha, "s4"), origin: "beta-q" },
          { branch: "s5", path: extra(alpha, "s5") },
          { branch: "other", path: extra(alpha, "other") },
        ],
      },
      {
        name: "beta",
        path: beta,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: beta },
          { branch: "q", path: extra(beta, "q") },
        ],
      },
    ],
  });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => {
  resetClientState(tmpHome);
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

async function openAndDelete(
  page: import("@playwright/test").Page,
  worktreeId: string,
): Promise<WorktreePage> {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(worktreeId);
  await worktreePage.waitForReady();
  await worktreePage.deleteWorktreeFromSidebar(worktreeId);
  await expect(worktreePage.worktreeCard(worktreeId)).toHaveCount(0);
  return worktreePage;
}

test("S1: deleting a worktree opens its parent in the same repo", async ({ page }) => {
  const wp = await openAndDelete(page, "alpha-s1");
  await expect(wp.activeWorktreeCard("alpha-parent")).toBeVisible();
});

test("S2: with no parent, the default-branch worktree opens", async ({ page }) => {
  const wp = await openAndDelete(page, "alpha-s2");
  await expect(wp.activeWorktreeCard("alpha-main")).toBeVisible();
});

test("S3: with a parent that no longer exists, the default-branch worktree opens", async ({
  page,
}) => {
  const wp = await openAndDelete(page, "alpha-s3");
  await expect(wp.activeWorktreeCard("alpha-main")).toBeVisible();
});

test("S4: a parent in another repo opens", async ({ page }) => {
  const wp = await openAndDelete(page, "alpha-s4");
  await expect(wp.activeWorktreeCard("beta-q")).toBeVisible();
});

test("S5: deleting a worktree that is not open keeps the open one", async ({ page }) => {
  const wp = new WorktreePage(page, server.url, TOKEN);
  await wp.goto("alpha-other");
  await wp.waitForReady();
  await wp.deleteWorktreeFromSidebar("alpha-s5");
  await expect(wp.worktreeCard("alpha-s5")).toHaveCount(0);
  await expect(wp.activeWorktreeCard("alpha-other")).toBeVisible();
});
