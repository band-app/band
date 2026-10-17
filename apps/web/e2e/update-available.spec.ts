/**
 * Version updates: the "update available" badge, the update panel (the hub's command per install
 * method, each worker's version and target), the one-click worker update with its confirm dialog,
 * and the version line on Settings > Hosts.
 *
 * The hub asks an Express stub of GitHub's "latest release" endpoint (`BAND_GITHUB_API_URL`).
 * Workers are stand-ins on the real link protocol that say hello with a version, so the hub, the
 * Hosts screen and the panel are the real ones.
 */

import { expect, test } from "@playwright/test";

import {
  type ReleasesStub,
  startReleasesStub,
} from "../../hub/tests/fixtures/github-releases-stub";
import { connectStandInWorker, type StandInWorker } from "../../hub/tests/helpers/stand-in-worker";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  startServer,
} from "./helpers/server";
import { SettingsPage } from "./pages/SettingsPage";
import { ToastHostPage } from "./pages/ToastHostPage";
import { UpdatePanelPage } from "./pages/UpdatePanelPage";

const TOKEN = "e2e-update-token";

/** The hub under test is told to report this release (`BAND_HUB_VERSION`). */
const HUB_VERSION = "0.50.0";

let releases: ReleasesStub;
let server: ServerHandle;
let tmpHome: string;
let behind: StandInWorker;
let legacy: StandInWorker;
let installAttempts = 0;

test.describe("a newer release exists", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(async () => {
    releases = await startReleasesStub("v9.0.0");
    tmpHome = createTmpHome();
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({
      tmpHome,
      env: {
        BAND_GITHUB_API_URL: releases.url,
        BAND_INSTALL_METHOD: "compose",
        BAND_HUB_VERSION: HUB_VERSION,
      },
    });
    // The first install fails, as npm does without permission; the retry works and the worker
    // comes back on the new version.
    behind = await connectStandInWorker(
      {
        hubUrl: server.url,
        adminToken: TOKEN,
        name: "build-box",
        version: "0.49.0",
        serviceManager: "systemd",
      },
      () => {
        installAttempts++;
        if (installAttempts === 1) {
          throw Object.assign(
            new Error("npm install failed (exit 243): EACCES permission denied"),
            {
              code: -32020,
            },
          );
        }
        setTimeout(() => void behind.reconnect(HUB_VERSION), 200);
        return { ok: true };
      },
    );
    legacy = await connectStandInWorker({ hubUrl: server.url, adminToken: TOKEN, name: "old-box" });
  });

  test.beforeEach(() => resetClientState(tmpHome));

  test.afterAll(async () => {
    await behind?.close();
    await legacy?.close();
    await server?.close();
    await releases?.close();
    cleanupTmpHome(tmpHome);
  });

  test("the badge names the new version and the panel lists the hub and every worker", async ({
    page,
  }) => {
    const update = new UpdatePanelPage(page, server.url, TOKEN);
    await update.goto();
    await expect(update.badge).toContainText("9.0.0");
    await update.openPanel();

    await expect(update.hubVersion()).toHaveText(HUB_VERSION);
    await expect(update.hubTarget()).toHaveText("9.0.0");
    await expect(update.workerVersion(behind.hostId)).toHaveAttribute("data-version", "0.49.0");
    await expect(update.workerTarget(behind.hostId)).toHaveText(HUB_VERSION);
    await expect(update.workerVersion(legacy.hostId)).toHaveAttribute("data-version", "unknown");
  });

  test("the hub row shows the compose command and copies it", async ({ page }) => {
    const update = new UpdatePanelPage(page, server.url, TOKEN);
    await update.goto();
    await update.openPanel();
    const shown = await update.hubCommand().innerText();
    expect(shown).toContain("docker compose pull");
    expect(shown).toContain("BAND_VERSION=9.0.0");
    expect(await update.copyHubCommand()).toBe(shown);
  });

  test("a worker without a service manager gets its command instead of a button", async ({
    page,
  }) => {
    const update = new UpdatePanelPage(page, server.url, TOKEN);
    await update.goto();
    await update.openPanel();
    await expect(update.updateButton(legacy.hostId)).toHaveCount(0);
    await expect(update.workerManualCommand(legacy.hostId)).toHaveText(
      `npm i -g @band-app/worker@${HUB_VERSION}`,
    );
  });

  test("Settings > Hosts marks the workers that are behind", async ({ page }) => {
    const settings = new SettingsPage(page, server.url, TOKEN);
    const update = new UpdatePanelPage(page, server.url, TOKEN);
    await settings.goto();
    await settings.openDialog("hosts");
    const row = settings.hostRow(behind.hostId);
    await settings.expectRowVisible(row);
    await expect(update.hostsVersion(row)).toHaveAttribute("data-version", "0.49.0");
    await expect(update.hostsVersionState(row)).toHaveAttribute("data-state", "behind");
    const old = settings.hostRow(legacy.hostId);
    await expect(update.hostsVersion(old)).toHaveAttribute("data-version", "unknown");
    await expect(update.hostsVersionState(old)).toHaveAttribute("data-state", "unknown");
  });

  test("Update asks first, shows a failed install, and a retry brings the worker to the new version", async ({
    page,
  }) => {
    const update = new UpdatePanelPage(page, server.url, TOKEN);
    await update.goto();
    await update.openPanel();

    // Cancelling sends nothing.
    await update.clickUpdate(behind.hostId);
    await expect(update.confirmAgents()).toHaveAttribute("data-state", "none");
    await update.cancelUpdate();
    expect(installAttempts).toBe(0);

    // The install fails: the call answers at once, the row says why and the worker stays on its version.
    await update.clickUpdate(behind.hostId);
    await update.confirmUpdate();
    await expect(update.confirmDialog).toBeHidden();
    await expect(update.workerVersion(behind.hostId)).toHaveAttribute("data-version", "0.49.0");
    await expect(update.workerError(behind.hostId)).toContainText("EACCES");

    // The retry installs, the worker restarts and reconnects on the hub's version.
    await update.updateButton(behind.hostId).click();
    await update.confirmUpdate();
    await expect(update.workerVersion(behind.hostId)).toHaveAttribute("data-version", HUB_VERSION);
    await expect(update.updateButton(behind.hostId)).toHaveCount(0);
    expect(installAttempts).toBe(2);
  });
});

test.describe("nothing to update", () => {
  test("no badge when the latest release is not newer than the hub", async ({ page }) => {
    const stub = await startReleasesStub("v0.0.1");
    const home = createTmpHome();
    seedSettings(home, { tokenSecret: TOKEN });
    const hub = await startServer({ tmpHome: home, env: { BAND_GITHUB_API_URL: stub.url } });
    try {
      await expect.poll(() => stub.requests()).toBeGreaterThan(0);
      const update = new UpdatePanelPage(page, hub.url, TOKEN);
      await update.goto();
      await update.expectDashboardLoaded();
      await expect(update.badge).toHaveCount(0);
    } finally {
      await hub.close();
      await stub.close();
      cleanupTmpHome(home);
    }
  });

  test("no badge and no error toast when GitHub cannot be reached", async ({ page }) => {
    const stub = await startReleasesStub("v9.0.0");
    stub.failWith(503);
    const home = createTmpHome();
    seedSettings(home, { tokenSecret: TOKEN });
    const hub = await startServer({ tmpHome: home, env: { BAND_GITHUB_API_URL: stub.url } });
    try {
      await expect.poll(() => stub.requests()).toBeGreaterThan(0);
      const update = new UpdatePanelPage(page, hub.url, TOKEN);
      await update.goto();
      await update.expectDashboardLoaded();
      await expect(update.badge).toHaveCount(0);
      await expect(new ToastHostPage(page).notices).toHaveCount(0);
    } finally {
      await hub.close();
      await stub.close();
      cleanupTmpHome(home);
    }
  });
});
