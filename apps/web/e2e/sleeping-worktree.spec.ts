/**
 * A worktree whose ephemeral worker exited shows as sleeping in the repo
 * list, and as waking while a new worker starts (plan step 3.5). The hub marks
 * both states in `repos.list`; the rows are seeded because the worker's
 * exit and restart are covered by `apps/hub/tests/ephemeral-lifecycle.test.ts`.
 */

import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedSleepingWorktree,
  seedState,
  startServer,
} from "./helpers/server";
import { SleepingWorktreePage } from "./pages/SleepingWorktreePage";
import { WorktreePage } from "./pages/WorktreePage";

test.use({ viewport: { width: 1280, height: 800 } });

const TOKEN = "e2e-sleeping-token";
const REPO = "sleep-repo";

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  const worktrees = ["main", "napping", "stirring", "awake"].map((branch) => ({
    branch,
    path: `/tmp/fake/${REPO}/${branch}`,
  }));
  seedState(tmpHome, {
    repos: [{ name: REPO, path: `/tmp/fake/${REPO}`, defaultBranch: "main", worktrees }],
  });
  seedSleepingWorktree(tmpHome, {
    worktreeId: `${REPO}-napping`,
    repo: REPO,
    name: "napping",
    path: `/tmp/fake/${REPO}/napping`,
  });
  seedSleepingWorktree(tmpHome, {
    worktreeId: `${REPO}-stirring`,
    repo: REPO,
    name: "stirring",
    path: `/tmp/fake/${REPO}/stirring`,
    waking: true,
  });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("worktrees on a worker that exited show as sleeping or waking", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const sleeping = new SleepingWorktreePage(page);
  await worktreePage.goto(`${REPO}-main`);
  await worktreePage.waitForReady();

  await expect(sleeping.badge(`${REPO}-napping`)).toHaveAttribute("data-lifecycle", "sleeping");
  await expect(sleeping.badge(`${REPO}-stirring`)).toHaveAttribute("data-lifecycle", "waking");
  // A worktree with a running worker has no badge.
  await expect(sleeping.card(`${REPO}-awake`)).toBeVisible();
  await expect(sleeping.badge(`${REPO}-awake`)).toHaveCount(0);
});
