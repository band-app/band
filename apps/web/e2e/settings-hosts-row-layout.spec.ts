/**
 * Settings > Workers: every worker row has the same order whatever its buttons. The header line
 * holds the name and version on the left and the actions on the right, and the coding agents list
 * spans the row's full width below it. A worker with the desktop capability has one more button
 * ("Open desktop"); it must not move the actions under the list or narrow the list.
 *
 * Two real `band-worker` processes, one with a `DISPLAY` and an `x11vnc` on its PATH (the
 * `desktop` capability, as in `desktop-viewer.spec.ts`) and one without.
 */

import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  startServer,
} from "./helpers/server";
import { trpcMutateData, trpcQuery } from "./helpers/trpc";
import { startWorker, type WorkerHandle } from "./helpers/worker";
import { SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-hosts-row-layout-token";

let server: ServerHandle;
let tmpHome: string;
const workers: WorkerHandle[] = [];
const scratch: string[] = [];
let plainId: string;
let desktopId: string;

const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

async function addWorker(name: string, desktop: boolean): Promise<string> {
  const issued = await trpcMutateData<{ token: string; hostId: string }>(
    server.url,
    TOKEN,
    "tokens.issueWorkerBootstrap",
    { hostName: name, labels: [] },
  );
  const env: Record<string, string> = {
    BAND_HUB_URL: server.url,
    BAND_BOOTSTRAP_TOKEN: issued.token,
    BAND_WORKER_ID: issued.hostId,
  };
  if (desktop) {
    const bin = tmpDir("band-e2e-rowlayout-bin-");
    const fakeX11vnc = join(bin, "x11vnc");
    writeFileSync(fakeX11vnc, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeX11vnc, 0o755);
    env.DISPLAY = ":99";
    env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  }
  workers.push(
    startWorker({
      env,
      root: tmpDir("band-e2e-rowlayout-root-"),
      stateDir: tmpDir("band-e2e-rowlayout-state-"),
      home: tmpDir("band-e2e-rowlayout-home-"),
    }),
  );
  await expect
    .poll(
      async () => {
        const { hosts } = await trpcQuery<{
          hosts: Array<{ id: string; status: string; capabilities: string[] }>;
        }>(server.url, TOKEN, "hosts.list");
        const host = hosts.find((h) => h.id === issued.hostId);
        return host?.status === "online" && host.capabilities.includes("desktop") === desktop;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return issued.hostId;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  server = await startServer({ tmpHome });
  plainId = await addWorker("plain-box", false);
  desktopId = await addWorker("desktop-box", true);
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  for (const worker of workers) await worker.kill();
  await server?.close();
  cleanupTmpHome(tmpHome);
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

async function openHosts(page: Page): Promise<SettingsPage> {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");
  for (const id of [plainId, desktopId]) {
    await expect(settingsPage.hostAgentsList(id)).toBeVisible();
  }
  return settingsPage;
}

async function boxes(settingsPage: SettingsPage, hostId: string) {
  const row = await settingsPage.hostRow(hostId).boundingBox();
  const list = await settingsPage.hostAgentsList(hostId).boundingBox();
  const status = await settingsPage.hostStatusPill(hostId).boundingBox();
  const remove = await settingsPage.hostRemoveButton(hostId).boundingBox();
  if (!row || !list || !status || !remove) throw new Error("missing bounding box");
  return { row, list, status, remove };
}

test.describe("desktop width", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("actions sit on the header line and the agents list is full width in both rows", async ({
    page,
  }, testInfo) => {
    const settingsPage = await openHosts(page);
    await expect(
      settingsPage.hostRow(desktopId).getByTestId("settings__host-open-desktop"),
    ).toBeVisible();
    await expect(
      settingsPage.hostRow(plainId).getByTestId("settings__host-open-desktop"),
    ).toHaveCount(0);

    for (const id of [plainId, desktopId]) {
      const { row, list, status, remove } = await boxes(settingsPage, id);
      const name = await settingsPage.hostRow(id).getByTestId("settings__host-name").boundingBox();
      if (!name) throw new Error("missing name box");
      // On the header line: the status pill starts right of the name and not below it.
      expect(status.x).toBeGreaterThanOrEqual(name.x + name.width);
      expect(status.y).toBeLessThan(name.y + name.height);
      expect(status.y + status.height).toBeLessThanOrEqual(list.y);
      expect(remove.y + remove.height).toBeLessThanOrEqual(list.y);
      // The row has a 12 px (px-3) padding and a 1 px border on each side.
      expect(Math.abs(list.x - (row.x + 12))).toBeLessThanOrEqual(2);
      expect(Math.abs(list.x + list.width - (row.x + row.width - 12))).toBeLessThanOrEqual(2);
    }
    await page.screenshot({ path: testInfo.outputPath("workers-desktop.png") });
  });
});

test.describe("narrow width", () => {
  test.use({ viewport: { width: 420, height: 800 } });

  test("actions wrap under the name, above the agents list, with no horizontal overflow", async ({
    page,
  }, testInfo) => {
    const settingsPage = await openHosts(page);
    for (const id of [plainId, desktopId]) {
      const { row, list, status, remove } = await boxes(settingsPage, id);
      const name = await settingsPage.hostRow(id).getByTestId("settings__host-name").boundingBox();
      if (!name) throw new Error("missing name box");
      expect(status.y).toBeGreaterThanOrEqual(name.y + name.height - 1);
      expect(status.y + status.height).toBeLessThanOrEqual(list.y);
      expect(remove.y + remove.height).toBeLessThanOrEqual(list.y);
      expect(list.x + list.width).toBeLessThanOrEqual(row.x + row.width + 1);
      expect(remove.x + remove.width).toBeLessThanOrEqual(row.x + row.width + 1);
    }
    const overflow = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return dialog ? dialog.scrollWidth - dialog.clientWidth : 0;
    });
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath("workers-narrow.png") });
  });
});
