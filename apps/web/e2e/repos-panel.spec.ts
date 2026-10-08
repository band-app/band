/**
 * The sidebar's Repos panel (`ReposPanel.tsx`) collapses to its header and resizes from its top
 * edge, and both states survive a reload (`band:repos-panel-collapsed`, `band:repos-panel-height`,
 * synced per device type through the server's client state).
 *
 * Real server against a temp HOME, one seeded repo, driven through `ReposPanelPage`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
import { ReposPanelPage } from "./pages/ReposPanelPage";

const TOKEN = "e2e-repos-panel-token";
const REPO = "panel-repo";

// Desktop layout, where the sidebar shows the panel.
test.use({ viewport: { width: 1280, height: 900 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const path = join(tmpHome, REPO);
  mkdirSync(path, { recursive: true });
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server?.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

test("collapses to its header and stays collapsed after a reload", async ({ page }) => {
  const panel = new ReposPanelPage(page, server.url, TOKEN);
  await panel.goto();
  await expect(panel.list).toBeVisible();
  await expect(panel.count()).toHaveText("1");

  await panel.toggleCollapsed();
  await expect(panel.list).toBeHidden();
  await expect(panel.toggle).toHaveAttribute("aria-expanded", "false");

  await panel.reload();
  await expect(panel.toggle).toHaveAttribute("aria-expanded", "false");
  await expect(panel.list).toBeHidden();

  await panel.toggleCollapsed();
  await expect(panel.list).toBeVisible();
});

test("resizes from its top edge and keeps the height after a reload", async ({ page }) => {
  const panel = new ReposPanelPage(page, server.url, TOKEN);
  await panel.goto();
  await expect(panel.list).toBeVisible();
  const before = await panel.listHeight();

  // Dragging the top edge up makes the panel taller.
  await panel.dragTopEdge(-100);
  await expect.poll(() => panel.listHeight()).toBeGreaterThan(before + 80);
  const after = await panel.listHeight();

  await panel.reload();
  await expect(panel.list).toBeVisible();
  await expect.poll(() => panel.listHeight()).toBeCloseTo(after, 0);
});
