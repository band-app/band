/**
 * Selecting a workspace re-reads its git status at once, so its card's badge
 * doesn't wait for the next branch-status poll tick (`statuses.refreshBranchStatus`).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { gitInHome } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcMutate } from "./helpers/trpc";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-select-branch-refresh-token";
const PROJECT = "selectrefresh";
const MAIN = toWorkspaceId(PROJECT, "main");
const FEATURE = toWorkspaceId(PROJECT, "feature");

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome!: string;
let featurePath!: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  gitInHome(repoPath, ["init", "-q", "-b", "main"], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# select refresh\n");
  gitInHome(repoPath, ["add", "."], tmpHome);
  gitInHome(repoPath, ["commit", "-q", "-m", "init"], tmpHome);
  featurePath = join(tmpHome, `${PROJECT}-feature`);
  gitInHome(repoPath, ["worktree", "add", "-q", "-b", "feature", featurePath], tmpHome);
  // The main workspace starts dirty, so its badge proves the first poll landed.
  writeFileSync(join(repoPath, "README.md"), "# edited on main\n");
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repoPath,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: repoPath },
          { branch: "feature", path: featurePath },
        ],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

test("selecting a workspace refreshes its git status badge", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(MAIN);
  await workspacePage.waitForReady();
  await expect(workspacePage.gitDirtyMark(MAIN)).toBeVisible({ timeout: 15_000 });
  await expect(workspacePage.gitDirtyMark(FEATURE)).toHaveCount(0);

  // Push the next poll tick 60 s out, so only the selection can refresh it.
  await trpcMutate(server.url, TOKEN, "services.setActivity", { activity: "background" });
  writeFileSync(join(featurePath, "README.md"), "# edited on feature\n");

  await workspacePage.switchWorkspace(FEATURE);
  await expect(workspacePage.gitDirtyMark(FEATURE)).toBeVisible({ timeout: 5_000 });
});
