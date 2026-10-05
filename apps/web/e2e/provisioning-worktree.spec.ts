/**
 * A worktree created with placement criteria that no host meets shows as
 * provisioning in the repo list, can be cancelled, and shows a reason when
 * the hub gives up (plan step 3.3, S4). Real hub, temp BAND_HOME, no worker.
 */

import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcMutate } from "./helpers/trpc";
import { ProvisioningPage } from "./pages/ProvisioningPage";
import { WorktreePage } from "./pages/WorktreePage";

test.use({ viewport: { width: 1280, height: 800 } });

const TOKEN = "e2e-provisioning-token";
const REPO = "prov-repo";

let server: ServerHandle;
let tmpHome: string;

const createWaiting = (branch: string) =>
  trpcMutate(server.url, TOKEN, "worktrees.create", {
    repo: REPO,
    branch,
    placement: { labels: { zone: "moon" } },
  });

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: `/tmp/fake/${REPO}`,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: `/tmp/fake/${REPO}` }],
      },
    ],
  });
  server = await startServer({ tmpHome, env: { BAND_PLACEMENT_TIMEOUT_MS: "8000" } });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("a waiting worktree shows as provisioning and can be cancelled", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const provisioning = new ProvisioningPage(page);
  await worktreePage.goto(`${REPO}-main`);
  await worktreePage.waitForReady();

  await createWaiting("waiting-for-moon");
  await expect(provisioning.card("waiting-for-moon")).toHaveAttribute("data-status", "pending");

  await provisioning.cancel("waiting-for-moon");
  await expect(provisioning.card("waiting-for-moon")).toHaveCount(0);
});

test("a worktree nobody could host shows why it failed, and the card can be dismissed", async ({
  page,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const provisioning = new ProvisioningPage(page);
  await worktreePage.goto(`${REPO}-main`);
  await worktreePage.waitForReady();

  await createWaiting("timed-out");
  await expect(provisioning.card("timed-out")).toHaveAttribute("data-status", "failed", {
    timeout: 20_000,
  });
  await expect(provisioning.error("timed-out")).toBeVisible();

  await provisioning.cancel("timed-out");
  await expect(provisioning.card("timed-out")).toHaveCount(0);
});
