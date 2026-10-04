/**
 * A workspace created with placement criteria that no host meets shows as
 * provisioning in the project list, can be cancelled, and shows a reason when
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
import { WorkspacePage } from "./pages/WorkspacePage";

test.use({ viewport: { width: 1280, height: 800 } });

const TOKEN = "e2e-provisioning-token";
const PROJECT = "prov-project";

let server: ServerHandle;
let tmpHome: string;

const createWaiting = (branch: string) =>
  trpcMutate(server.url, TOKEN, "workspaces.create", {
    project: PROJECT,
    branch,
    placement: { labels: { zone: "moon" } },
  });

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: `/tmp/fake/${PROJECT}`,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: `/tmp/fake/${PROJECT}` }],
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

test("a waiting workspace shows as provisioning and can be cancelled", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const provisioning = new ProvisioningPage(page);
  await workspacePage.goto(`${PROJECT}-main`);
  await workspacePage.waitForReady();

  await createWaiting("waiting-for-moon");
  await expect(provisioning.card("waiting-for-moon")).toHaveAttribute("data-status", "pending");

  await provisioning.cancel("waiting-for-moon");
  await expect(provisioning.card("waiting-for-moon")).toHaveCount(0);
});

test("a workspace nobody could host shows why it failed, and the card can be dismissed", async ({
  page,
}) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const provisioning = new ProvisioningPage(page);
  await workspacePage.goto(`${PROJECT}-main`);
  await workspacePage.waitForReady();

  await createWaiting("timed-out");
  await expect(provisioning.card("timed-out")).toHaveAttribute("data-status", "failed", {
    timeout: 20_000,
  });
  await expect(provisioning.error("timed-out")).toBeVisible();

  await provisioning.cancel("timed-out");
  await expect(provisioning.card("timed-out")).toHaveCount(0);
});
