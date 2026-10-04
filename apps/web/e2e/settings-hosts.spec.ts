/**
 * Settings › Hosts: the hosts list, "Add worker" (a one-time bootstrap token
 * and the `band-worker` command) and token revocation, driven through the
 * real Settings dialog against the real server.
 *
 * Assertions on the outcome read the server back: a revoked device token must
 * get 401 from the HTTP API, and the bootstrap token shown on screen must be
 * the one the hub accepts exactly once (checked through its token list).
 */

import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  startServer,
} from "./helpers/server";
import { trpcQuery } from "./helpers/trpc";
import { SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-hosts-token";

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

interface TokenView {
  id: string;
  kind: string;
  label: string;
  state: string;
}

async function tokens(): Promise<TokenView[]> {
  const data = await trpcQuery<{ tokens: TokenView[] }>(server.url, TOKEN, "tokens.list");
  return data.tokens;
}

test("lists the local host", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog();

  const local = settingsPage.hostRow("local");
  await settingsPage.expectRowVisible(local);
  await expect(local).toHaveAttribute("data-status", "online");
});

test("creates a worker bootstrap token that is shown once", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog();

  await settingsPage.addWorker("build-box", "os=linux, gpu");

  const token = await settingsPage.bootstrapToken().inputValue();
  expect(token).toMatch(/^bwb_/);
  const command = await settingsPage.workerCommand().inputValue();
  expect(command).toContain(`BAND_BOOTSTRAP_TOKEN=${token}`);
  expect(command).toContain(`BAND_HUB_URL=${server.url}`);
  expect(command).toMatch(/BAND_WORKER_ID=h-[0-9a-f]+/);
  expect(command.endsWith("band-worker")).toBe(true);

  // The new host is listed, offline, with its labels.
  const hostId = /BAND_WORKER_ID=(\S+)/.exec(command)?.[1] ?? "";
  const row = settingsPage.hostRow(hostId);
  await settingsPage.expectRowVisible(row);
  await expect(row).toHaveAttribute("data-status", "offline");
  await expect(row).toContainText("os=linux, gpu");

  // Closing the panel drops the secret from the page. Only the hash is left on the hub.
  await settingsPage.finishAddWorker();
  await expect(settingsPage.bootstrapToken()).toHaveCount(0);

  const issued = (await tokens()).find(
    (t) => t.kind === "worker_bootstrap" && t.label === "build-box",
  );
  expect(issued?.state).toBe("active");
});

test("revokes a device token, which then gets 401", async ({ page }) => {
  const created = await fetch(`${server.url}/trpc/tokens.createDevice`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
    body: JSON.stringify({ label: "e2e phone" }),
  });
  const { result } = (await created.json()) as { result: { data: { token: string } } };
  const deviceToken = result.data.token;
  const authed = () =>
    fetch(`${server.url}/trpc/projects.list`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
  expect((await authed()).status).toBe(200);

  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog();

  const row = settingsPage.tokenRow("e2e phone");
  await settingsPage.expectRowVisible(row);
  await expect(row).toHaveAttribute("data-state", "active");
  await settingsPage.revokeTokenButton("e2e phone").click();
  await expect(row).toHaveAttribute("data-state", "revoked");
  await expect(settingsPage.revokeTokenButton("e2e phone")).toBeDisabled();

  expect((await authed()).status).toBe(401);
  // The token the page itself uses is the shared one, which can't be revoked from here.
  await expect(settingsPage.revokeTokenButton("Shared token")).toBeDisabled();
});
