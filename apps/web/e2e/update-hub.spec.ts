/**
 * Updating the hub from the update panel: the npm install method's manual command, the admin's
 * hub update command with the Update hub button and its failure message, and Update all workers.
 * Without a command the panel keeps only the manual command.
 *
 * The hub asks an Express stub of GitHub's "latest release" endpoint. The hub update command is a
 * shell script that does nothing, so the hub never comes back on the target and the timeout
 * (`BAND_HUB_UPDATE_TIMEOUT_MS`) turns the run into a failure that quotes the script's output.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { UpdatePanelPage } from "./pages/UpdatePanelPage";

const TOKEN = "e2e-update-hub-token";
const HUB_VERSION = "0.50.0";

let releases: ReleasesStub;
let server: ServerHandle;
let tmpHome: string;
let worker: StandInWorker;

test.describe("the hub installed from npm", () => {
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
        BAND_HUB_VERSION: HUB_VERSION,
        BAND_HUB_UPDATE_TIMEOUT_MS: "1500",
      },
    });
    worker = await connectStandInWorker(
      {
        hubUrl: server.url,
        adminToken: TOKEN,
        name: "build-box",
        version: "0.49.0",
        serviceManager: "systemd",
      },
      () => {
        setTimeout(() => void worker.reconnect(HUB_VERSION), 200);
        return { ok: true };
      },
    );
  });

  test.beforeEach(() => resetClientState(tmpHome));

  test.afterAll(async () => {
    await worker?.close();
    await server?.close();
    await releases?.close();
    cleanupTmpHome(tmpHome);
  });

  test("shows the npm command and no button while no hub command is set", async ({ page }) => {
    const update = new UpdatePanelPage(page, server.url, TOKEN);
    await update.goto();
    await update.openPanel();
    const shown = await update.hubCommand().innerText();
    expect(shown).toBe("npm i -g @band-app/server@9.0.0 && systemctl --user restart band-hub");
    await expect(update.hubUpdateButton()).toHaveCount(0);
  });

  test("Update hub runs the command and reports a hub that did not come back", async ({ page }) => {
    const script = join(tmpHome, "update-hub.sh");
    writeFileSync(script, "echo installing the hub\n");
    const update = new UpdatePanelPage(page, server.url, TOKEN);
    await update.goto();
    await update.openPanel();
    await update.setHubUpdateCommand(`sh ${script}`);
    await update.clickUpdateHub();
    await expect(update.hubUpdateError()).toContainText("did not come back on 9.0.0");
    await expect(update.hubUpdateError()).toContainText("installing the hub");
  });

  test("Update all workers updates the worker that is behind", async ({ page }) => {
    const update = new UpdatePanelPage(page, server.url, TOKEN);
    await update.goto();
    await update.openPanel();
    await update.updateAllButton().click();
    await expect(update.updateAllResult(worker.hostId)).toHaveAttribute("data-state", "updated");
    await expect(update.workerVersion(worker.hostId)).toHaveAttribute("data-version", HUB_VERSION);
  });
});
