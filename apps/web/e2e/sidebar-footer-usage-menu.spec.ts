/**
 * The sidebar footer's Usage entry lives in the overflow (⋮) menu, and the
 * keep-awake toggle shows only inside the desktop app. This spec runs the web
 * build in plain Chromium, which has no `window.__BAND_DESKTOP__`.
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
import { ReportsDialog } from "./pages/ReportsDialog";

const TOKEN = "e2e-footer-usage-menu-token";

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, { repos: [] });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server?.close();
  cleanupTmpHome(tmpHome);
});

test("Usage is a menu item, not a footer button, and the keep-awake toggle is absent in a browser", async ({
  page,
}) => {
  const footer = new ReportsDialog(page, server.url, TOKEN);
  await footer.gotoDashboard();
  await expect(footer.legacyUsageButton).toHaveCount(0);
  await expect(footer.keepAwakeButton).toHaveCount(0);
  await footer.openOverflowMenu();
});
