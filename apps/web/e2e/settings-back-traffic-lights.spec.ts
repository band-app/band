/**
 * Settings' "Back to app" link must clear the macOS traffic lights in the
 * desktop shell. The harness boots the web build, so the Electron preload
 * bridge is stubbed with `addInitScript`: `invoke("get_window_fullscreen")`
 * answers from the `fullscreen` argument, `updater_status` is idle and every other call resolves to null.
 * Drag regions are not observable here and stay a manual check.
 */

import { expect, type Page, test } from "@playwright/test";

import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-settings-traffic-lights-token";
// Matches the `pl-[80px]` gutter in `useTitleBarOffset`.
const TRAFFIC_LIGHT_GUTTER = 80;

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, { repos: [] });
  seedSettings(tmpHome, { tokenSecret: TOKEN, theme: "dark" });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

async function stubDesktop(page: Page, fullscreen: boolean): Promise<void> {
  await page.addInitScript((fs) => {
    (window as unknown as Record<string, unknown>).__BAND_DESKTOP__ = {
      version: 1,
      invoke: async (channel: string) => {
        if (channel === "get_window_fullscreen") return fs;
        if (channel === "updater_status") return { state: "idle" };
        return null;
      },
      on: () => () => {},
    };
  }, fullscreen);
}

test("desktop window: Back to app starts right of the traffic lights and still works", async ({
  page,
}) => {
  await stubDesktop(page, false);
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog();

  const nav = await settingsPage.navBox();
  const back = await settingsPage.backBox();
  expect(back.x - nav.x).toBeGreaterThanOrEqual(TRAFFIC_LIGHT_GUTTER);

  await settingsPage.backToApp();
  await expect(settingsPage.dialog).toBeHidden();
});

test("desktop fullscreen: Back to app keeps the normal left padding", async ({ page }) => {
  await stubDesktop(page, true);
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog();

  await expect
    .poll(async () => (await settingsPage.backBox()).x - (await settingsPage.navBox()).x)
    .toBeLessThan(TRAFFIC_LIGHT_GUTTER);
});

test("browser build: Back to app keeps the normal left padding", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog();

  const back = await settingsPage.backBox();
  const nav = await settingsPage.navBox();
  expect(back.x - nav.x).toBeLessThan(TRAFFIC_LIGHT_GUTTER);
});
