/**
 * Settings > Hub: the Updates card states (Up to date, Update available, Failed, Cannot update
 * itself), the last update with its log in a dialog, the custom command under Advanced, and the
 * Connection card in a browser. Driven through the hub's real update state: the release feed is an
 * Express stub of GitHub, the update command is a script, and the built-in updater runs a stub npm.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startReleasesStub } from "../../hub/tests/fixtures/github-releases-stub";
import { cleanupTmpHome, createTmpHome, seedSettings, startServer } from "./helpers/server";
import { HubSettingsPage } from "./pages/HubSettingsPage";
import { UpdateSettingsPage } from "./pages/UpdateSettingsPage";

const TOKEN = "e2e-hub-updates-token";
const HUB_VERSION = "0.50.0";

test("S6: a current hub says Up to date with its version and the last check", async ({ page }) => {
  const stub = await startReleasesStub(`v${HUB_VERSION}`);
  const home = createTmpHome();
  seedSettings(home, { tokenSecret: TOKEN });
  const hub = await startServer({
    tmpHome: home,
    env: {
      BAND_GITHUB_API_URL: stub.url,
      BAND_INSTALL_METHOD: "npm",
      BAND_HUB_VERSION: HUB_VERSION,
    },
  });
  try {
    const hubPage = new HubSettingsPage(page, hub.url, TOKEN);
    await hubPage.open();
    await expect(hubPage.statusLine()).toHaveAttribute("data-state", "up-to-date");
    await expect(hubPage.headline()).toHaveText("Up to date");
    await expect(hubPage.summary()).toContainText(HUB_VERSION);
    await expect(hubPage.summary()).toContainText("Checked");
    await expect(hubPage.updateNow()).toHaveCount(0);

    // The custom command sits under Advanced, with a label, and an empty field reads as not set.
    await hubPage.openAdvanced();
    await expect(hubPage.commandInput()).toHaveValue("");
    await expect(hubPage.commandInput()).toHaveAttribute("placeholder", "Not set");

    // A browser shows the hub it talks to, with no desktop-only choice.
    await expect(hubPage.connectionUrl()).toContainText(new URL(hub.url).host);
    await expect(hubPage.changeButton()).toHaveCount(0);
  } finally {
    await hub.close();
    await stub.close();
    cleanupTmpHome(home);
  }
});

test("S6, S9: a newer release shows Update now, and a failing update shows an icon with Retry and View log", async ({
  page,
}) => {
  const stub = await startReleasesStub("v9.0.0");
  const home = createTmpHome();
  seedSettings(home, { tokenSecret: TOKEN });
  const script = join(home, "update-hub.sh");
  writeFileSync(script, "echo installing the hub\n");
  const hub = await startServer({
    tmpHome: home,
    env: {
      BAND_GITHUB_API_URL: stub.url,
      BAND_INSTALL_METHOD: "npm",
      BAND_HUB_VERSION: HUB_VERSION,
      BAND_HUB_UPDATE_TIMEOUT_MS: "1500",
    },
  });
  try {
    // With no command and no service manager the hub cannot update itself and says which command to run.
    const hubPage = new HubSettingsPage(page, hub.url, TOKEN);
    await hubPage.open();
    await expect(hubPage.statusLine()).toHaveAttribute("data-state", "blocked");
    await expect(hubPage.headline()).toHaveText("Cannot update itself");
    await expect(hubPage.manualCommand()).toContainText("npm i -g @band-app/server@9.0.0");

    // A custom command makes the update available.
    await hubPage.openAdvanced();
    await hubPage.commandInput().fill(`sh ${script}`);
    await hubPage.saveCommand().click();
    await expect(hubPage.statusLine()).toHaveAttribute("data-state", "available");
    await expect(hubPage.headline()).toContainText("Update available 9.0.0");
    await hubPage.updateNow().click();

    // The hub never comes back on the target, so the run fails. The error is an icon.
    await expect(hubPage.statusLine()).toHaveAttribute("data-state", "failed", { timeout: 20_000 });
    await expect(hubPage.statusLine()).not.toContainText("did not come back");
    await hubPage.errorIcon().click();
    await expect(hubPage.errorMessage()).toContainText("did not come back on 9.0.0");
    await expect(hubPage.retry()).toBeVisible();
    await page.keyboard.press("Escape");
    const log = await hubPage.openLog();
    await expect(hubPage.logText()).toContainText("installing the hub");
    await expect(log).toBeVisible();
  } finally {
    await hub.close();
    await stub.close();
    cleanupTmpHome(home);
  }
});

test("S7: the built-in updater leaves a last update line, and its log is in a dialog", async ({
  page,
}) => {
  const stub = await startReleasesStub("v9.0.0");
  const home = createTmpHome();
  const work = join(home, "rig");
  mkdirSync(join(work, "prefix"), { recursive: true });
  writeFileSync(join(work, "npm"), '#!/bin/sh\necho npm-stub-ran "$@"\n', { mode: 0o755 });
  writeFileSync(join(work, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // The hub cannot restart itself in a test, so the restarted hub's health is a stub that reports the target.
  const health = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok", version: "9.0.0" }));
  });
  await new Promise<void>((resolve) => health.listen(0, "127.0.0.1", resolve));
  const healthPort = (health.address() as { port: number }).port;
  seedSettings(home, { tokenSecret: TOKEN });
  const hub = await startServer({
    tmpHome: home,
    env: {
      BAND_GITHUB_API_URL: stub.url,
      BAND_INSTALL_METHOD: "npm",
      BAND_HUB_VERSION: HUB_VERSION,
      BAND_HUB_SERVICE_MANAGER: "systemd",
      BAND_HUB_INSTALL_PREFIX: join(work, "prefix"),
      BAND_NPM_BIN: join(work, "npm"),
      BAND_SYSTEMCTL_BIN: join(work, "systemctl"),
      BAND_HUB_UPDATE_HEALTH_URL: `http://127.0.0.1:${healthPort}/api/health`,
      BAND_HUB_UPDATE_HEALTH_POLL_MS: "100",
    },
  });
  try {
    const hubPage = new HubSettingsPage(page, hub.url, TOKEN);
    const update = new UpdateSettingsPage(page, hub.url, TOKEN);
    await hubPage.open();
    await expect(hubPage.statusLine()).toHaveAttribute("data-state", "available");
    await hubPage.updateNow().click();
    await expect(hubPage.lastResult()).toContainText("0.50.0 → 9.0.0", { timeout: 30_000 });
    await expect(hubPage.lastResult()).toContainText("Succeeded");
    // The log is not printed in the card.
    await expect(hubPage.logText()).toHaveCount(0);
    await hubPage.openLog();
    await expect(hubPage.logText()).toContainText("npm-stub-ran i -g --prefix");
    await expect(hubPage.backup()).toContainText("0.50.0-");
    await page.keyboard.press("Escape");

    // The auto-update switch keeps its behaviour and states its rule in one line.
    await expect(update.hubControls()).toContainText("Waits for running agent turns");
    await update.toggle(update.hubAuto(), true);
    await update.toggle(update.hubAuto(), false);
  } finally {
    await hub.close();
    await new Promise((r) => health.close(r));
    await stub.close();
    cleanupTmpHome(home);
  }
});
