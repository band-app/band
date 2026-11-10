/**
 * The update controls in Settings: the hub (Settings > Hub, for an admin on every client) and each
 * worker's drawer (Settings > Workers) show the update button when a newer release exists and the
 * Update automatically switch; the hub also shows the latest release and Check for updates, and the
 * Workers page has one Check for updates. A worker that
 * cannot update itself shows why instead.
 *
 * The hub asks an Express stub of GitHub's "latest release" endpoint. The workers are stand-ins on
 * the real link protocol. The automatic update itself is covered by
 * `hub/tests/worker-auto-update.test.ts`.
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
import { trpcMutateData } from "./helpers/trpc";
import { UpdateSettingsPage } from "./pages/UpdateSettingsPage";

const TOKEN = "e2e-update-controls-token";
const HUB_VERSION = "0.50.0";

let releases: ReleasesStub;
let server: ServerHandle;
let tmpHome: string;
let behind: StandInWorker;
let ahead: StandInWorker;
let bundled: StandInWorker;
let installed = 0;

test.describe("update controls in Settings", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    releases = await startReleasesStub("v9.0.0");
    tmpHome = createTmpHome();
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({
      tmpHome,
      env: {
        BAND_GITHUB_API_URL: releases.url,
        BAND_INSTALL_METHOD: "npm",
        // The built-in updater can run here, so the switch is on offer. No update is started.
        BAND_HUB_SERVICE_MANAGER: "systemd",
        BAND_HUB_INSTALL_PREFIX: tmpHome,
        BAND_HUB_VERSION: HUB_VERSION,
        // No auto tick during these specs: the switch is only persisted here.
        BAND_WORKER_UPDATE_AUTO_POLL_MS: "3600000",
      },
    });
    behind = await connectStandInWorker(
      {
        hubUrl: server.url,
        adminToken: TOKEN,
        name: "behind-box",
        version: "0.49.0",
        serviceManager: "systemd",
      },
      () => {
        installed += 1;
        setTimeout(() => void behind.reconnect(HUB_VERSION), 200);
        return { ok: true };
      },
    );
    ahead = await connectStandInWorker({
      hubUrl: server.url,
      adminToken: TOKEN,
      name: "ahead-box",
      version: "0.51.0",
      serviceManager: "systemd",
    });
    bundled = await connectStandInWorker({
      hubUrl: server.url,
      adminToken: TOKEN,
      name: "bundled-box",
      version: "0.49.0",
      updateBlocked: "it updates with the desktop app",
    });
  });

  test.beforeEach(() => resetClientState(tmpHome));

  test.afterAll(async () => {
    await behind?.close();
    await ahead?.close();
    await bundled?.close();
    await server?.close();
    await releases?.close();
    cleanupTmpHome(tmpHome);
  });

  for (const layout of [
    { name: "desktop layout", viewport: { width: 1280, height: 800 } },
    { name: "phone width", viewport: { width: 390, height: 844 } },
  ]) {
    test(`S1: Settings > Hub shows the hub's controls and the switch persists (${layout.name})`, async ({
      page,
    }) => {
      await page.setViewportSize(layout.viewport);
      const update = new UpdateSettingsPage(page, server.url, TOKEN);
      await update.openHub();
      await expect(update.hubVersion()).toContainText(HUB_VERSION);
      await update.hubCheck().click();
      await expect(update.hubLatest()).toContainText("9.0.0");
      await update.toggle(update.hubAuto(), true);
      await update.reload();
      await update.settings.openDialog("hub");
      await expect(update.hubAuto()).toBeChecked();
      await update.toggle(update.hubAuto(), false);
    });
  }

  test("S2: a worker that is behind has its controls in the drawer and the switch persists", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const update = new UpdateSettingsPage(page, server.url, TOKEN);
    await update.openWorkers();
    // One Check for updates for the whole page, not one per worker.
    await expect(update.checkButtons()).toHaveCount(1);
    await update.openWorker("behind-box");
    await update.toggle(update.workerAuto("behind-box"), true);
    await update.reload();
    await update.settings.openDialog("hosts");
    await update.openWorker("behind-box");
    await expect(update.workerAuto("behind-box")).toBeChecked();
    await update.toggle(update.workerAuto("behind-box"), false);
  });

  test("S2: Update on a worker that is behind installs the hub's version", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const update = new UpdateSettingsPage(page, server.url, TOKEN);
    await update.openWorkers();
    await update.openWorker("behind-box");
    await update.workerUpdateButton().click();
    await page.getByTestId("update-worker__confirm").click();
    await expect(update.workerVersion("behind-box")).toHaveAttribute("data-version", HUB_VERSION, {
      timeout: 30_000,
    });
    expect(installed).toBe(1);
  });

  test("S4: a worker that cannot update itself says why and has no switch", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const update = new UpdateSettingsPage(page, server.url, TOKEN);
    await update.openWorkers();
    await update.openWorker("bundled-box");
    await expect(update.workerBlocked()).toContainText("it updates with the desktop app");
    await expect(update.workerAuto("bundled-box")).toHaveCount(0);
    await expect(update.workerUpdateButton()).toHaveCount(0);
  });

  test("S4: a worker ahead of the hub says it is not updated", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const update = new UpdateSettingsPage(page, server.url, TOKEN);
    await update.openWorkers();
    await update.openWorker("ahead-box");
    await expect(update.workerAutoNote()).toContainText("Newer than the hub");
    await expect(update.workerAuto("ahead-box")).toBeDisabled();
  });

  test("S5: a non-admin device sees no Hub page and no controls on a worker row", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const { token: person } = await trpcMutateData<{ token: string }>(
      server.url,
      TOKEN,
      "tokens.createDevice",
      { label: "person" },
    );
    const update = new UpdateSettingsPage(page, server.url, person);
    await update.openWorkers();
    await expect(update.settings.dialog.getByTestId("settings__nav-hub")).toHaveCount(0);
    await expect(update.workerRow("behind-box")).toBeVisible();
    await update.openWorker("behind-box");
    await expect(update.workerAuto("behind-box")).toHaveCount(0);
    await expect(update.checkButtons()).toHaveCount(0);
  });
});
