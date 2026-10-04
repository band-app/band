/**
 * A workspace whose ephemeral worker exited shows as sleeping in the project
 * list, and as waking while a new worker starts (plan step 3.5). The hub marks
 * both states in `projects.list`; the rows are seeded because the worker's
 * exit and restart are covered by `apps/hub/tests/ephemeral-lifecycle.test.ts`.
 */

import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedSleepingWorkspace,
  seedState,
  startServer,
} from "./helpers/server";
import { SleepingWorkspacePage } from "./pages/SleepingWorkspacePage";
import { WorkspacePage } from "./pages/WorkspacePage";

test.use({ viewport: { width: 1280, height: 800 } });

const TOKEN = "e2e-sleeping-token";
const PROJECT = "sleep-project";

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  const worktrees = ["main", "napping", "stirring", "awake"].map((branch) => ({
    branch,
    path: `/tmp/fake/${PROJECT}/${branch}`,
  }));
  seedState(tmpHome, {
    projects: [{ name: PROJECT, path: `/tmp/fake/${PROJECT}`, defaultBranch: "main", worktrees }],
  });
  seedSleepingWorkspace(tmpHome, {
    workspaceId: `${PROJECT}-napping`,
    project: PROJECT,
    name: "napping",
    path: `/tmp/fake/${PROJECT}/napping`,
  });
  seedSleepingWorkspace(tmpHome, {
    workspaceId: `${PROJECT}-stirring`,
    project: PROJECT,
    name: "stirring",
    path: `/tmp/fake/${PROJECT}/stirring`,
    waking: true,
  });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("workspaces on a worker that exited show as sleeping or waking", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const sleeping = new SleepingWorkspacePage(page);
  await workspacePage.goto(`${PROJECT}-main`);
  await workspacePage.waitForReady();

  await expect(sleeping.badge(`${PROJECT}-napping`)).toHaveAttribute("data-lifecycle", "sleeping");
  await expect(sleeping.badge(`${PROJECT}-stirring`)).toHaveAttribute("data-lifecycle", "waking");
  // A workspace with a running worker has no badge.
  await expect(sleeping.card(`${PROJECT}-awake`)).toBeVisible();
  await expect(sleeping.badge(`${PROJECT}-awake`)).toHaveCount(0);
});
