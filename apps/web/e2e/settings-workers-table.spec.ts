/**
 * Settings > Workers as a table with a drawer: every worker in one table with its status, version
 * and Update pill, one Check for updates, a banner when a worker is behind the hub, the drawer
 * sections, the remove confirm dialog, and Activity and Tokens as tabs. Failed actions show as an
 * icon with a popover.
 *
 * The hub asks an Express stub of GitHub's "latest release" endpoint. The workers are stand-ins on
 * the real link protocol.
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
import { WorkersSettingsPage } from "./pages/WorkersSettingsPage";

const TOKEN = "e2e-workers-table-token";
const HUB_VERSION = "0.50.0";

let releases: ReleasesStub;
let server: ServerHandle;
let tmpHome: string;
let behind: StandInWorker;
let current: StandInWorker;

test.describe("Settings > Workers table", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    releases = await startReleasesStub(`v${HUB_VERSION}`);
    tmpHome = createTmpHome();
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({
      tmpHome,
      env: {
        BAND_GITHUB_API_URL: releases.url,
        BAND_INSTALL_METHOD: "npm",
        BAND_HUB_VERSION: HUB_VERSION,
        BAND_WORKER_UPDATE_AUTO_POLL_MS: "3600000",
      },
    });
    behind = await connectStandInWorker({
      hubUrl: server.url,
      adminToken: TOKEN,
      name: "contabo",
      version: "0.49.0",
      serviceManager: "systemd",
    });
    current = await connectStandInWorker({
      hubUrl: server.url,
      adminToken: TOKEN,
      name: "mac-mini",
      version: HUB_VERSION,
      serviceManager: "systemd",
    });
  });

  test.beforeEach(() => resetClientState(tmpHome));

  test.afterAll(async () => {
    await behind?.close();
    await current?.close();
    await server?.close();
    await releases?.close();
    cleanupTmpHome(tmpHome);
  });

  test("S1, S2: one table lists every worker, with the Update pill, the banner and one Check for updates", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const workers = new WorkersSettingsPage(page, server.url, TOKEN);
    await workers.open();

    await expect(workers.row("local")).toBeVisible();
    await expect(workers.row("contabo")).toBeVisible();
    await expect(workers.row("mac-mini")).toBeVisible();
    await expect(workers.row("contabo")).toContainText("online");
    await expect(workers.updatePill("contabo")).toHaveText(`Update to ${HUB_VERSION}`);
    await expect(workers.updatePill("mac-mini")).toHaveCount(0);

    // The rows are one height, whatever they hold.
    const heights = await workers.rows().evaluateAll((els) => els.map((e) => e.clientHeight));
    expect(new Set(heights).size).toBe(1);

    await expect(workers.banner()).toContainText("contabo is behind the hub (0.49.0");
    await expect(workers.banner()).toContainText(`hub runs ${HUB_VERSION}`);
    await expect(workers.updateAllButton()).toBeEnabled();
    await expect(workers.checkButtons()).toHaveCount(1);
    await expect(workers.checkedText()).toContainText("Checked");
  });

  test("S3: a click on a row opens a drawer with its sections, and a trust change applies", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const workers = new WorkersSettingsPage(page, server.url, TOKEN);
    await workers.open();
    await workers.openDrawer("contabo");
    for (const section of [
      "updates",
      "agents-section",
      "trust-section",
      "details",
      "danger",
    ] as const) {
      await expect(workers.section(section)).toBeVisible();
    }
    await expect(workers.section("details")).toContainText(behind.hostId);
    await expect(workers.trustHint()).toContainText("Agents on this worker");

    await workers.settings.chooseHostTrust(behind.hostId, "admin");
    await expect(workers.settings.hostTrustOption(behind.hostId, "admin")).toBeChecked();
    await expect(workers.trustHint()).toContainText("change hub settings");
    await workers.settings.chooseHostTrust(behind.hostId, "standard");
    await expect(workers.settings.hostTrustOption(behind.hostId, "standard")).toBeChecked();
  });

  test("S4: Remove is disabled with a reason while online and asks before it removes", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const issued = await trpcMutateData<{ hostId: string }>(
      server.url,
      TOKEN,
      "tokens.issueWorkerBootstrap",
      { hostName: "spare-box", labels: [] },
    );
    const workers = new WorkersSettingsPage(page, server.url, TOKEN);
    await workers.open();

    await workers.openDrawer("contabo");
    await expect(workers.removeButton()).toBeDisabled();
    await workers.removeReasonIcon().click();
    await expect(workers.removeReason()).toContainText("online");

    // An offline worker: the dialog asks first, and Cancel removes nothing.
    await workers.openDrawer("spare-box");
    await workers.removeButton().click();
    await expect(workers.removeDialog()).toBeVisible();
    await workers.removeCancel().click();
    await expect(workers.row("spare-box")).toBeVisible();

    // Confirming removes it, and the drawer closes with the row.
    await workers.removeButton().click();
    await workers.removeConfirm().click();
    await expect(workers.row("spare-box")).toHaveCount(0);
    await expect(workers.drawer()).toBeHidden();
  });

  test("S5: Activity and Tokens are tabs, not part of the worker list", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const workers = new WorkersSettingsPage(page, server.url, TOKEN);
    await workers.open();
    await expect(workers.table()).toBeVisible();
    await expect(workers.auditEmpty()).toHaveCount(0);

    await workers.tab("activity").click();
    await expect(workers.table()).toHaveCount(0);
    await expect(workers.auditEmpty()).toBeVisible();

    await workers.tab("tokens").click();
    await expect(workers.settings.tokenRows().first()).toBeVisible();
  });

  test("S10: the table stacks on a phone without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const workers = new WorkersSettingsPage(page, server.url, TOKEN);
    await workers.open();
    await expect(workers.row("contabo")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const dialogOverflow = await workers.settings.dialog.evaluate(
      (el) => el.scrollWidth - el.clientWidth,
    );
    expect(dialogOverflow).toBeLessThanOrEqual(0);
    await workers.openDrawer("contabo");
    await expect(workers.section("updates")).toBeVisible();
  });
});
