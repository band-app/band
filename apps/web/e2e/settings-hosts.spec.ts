/**
 * Settings › Hosts: the hosts list, "Add worker" (a one-time bootstrap token
 * and the `band-worker` command) and token revocation, driven through the
 * real Settings dialog against the real server.
 *
 * Assertions on the outcome read the server back: a revoked device token must
 * get 401 from the HTTP API, and a new bootstrap token must show up as active
 * in the hub's token list. `remote-host.spec.ts` covers a worker using it.
 *
 * A device token without the admin flag sees the hosts but not the tokens.
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
import { trpcMutateData, trpcQuery } from "./helpers/trpc";
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
  await settingsPage.openDialog("hosts");

  const local = settingsPage.hostRow("local");
  await settingsPage.expectRowVisible(local);
  await expect(local).toHaveAttribute("data-status", "online");
});

test("creates a worker bootstrap token and lists its offline host", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");

  await settingsPage.addWorker("build-box", "os=linux, gpu");

  const token = await settingsPage.readBootstrapToken();
  expect(token).toMatch(/^bwb_/);
  const command = await settingsPage.readWorkerCommand();
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

  // Closing the panel drops the secret from the page. A worker spends it on its first exchange.
  await expect(settingsPage.bootstrapToken()).toBeVisible();
  await settingsPage.finishAddWorker();
  await expect(settingsPage.addWorkerButton()).toBeVisible();
  await expect(settingsPage.bootstrapToken()).toHaveCount(0);

  const issued = (await tokens()).find(
    (t) => t.kind === "worker_bootstrap" && t.label === "build-box",
  );
  expect(issued?.state).toBe("active");
});

test("revokes a device token, which then gets 401", async ({ page }) => {
  const { token: deviceToken } = await trpcMutateData<{ token: string }>(
    server.url,
    TOKEN,
    "tokens.createDevice",
    { label: "e2e phone" },
  );
  const authed = () =>
    fetch(`${server.url}/trpc/projects.list`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
  expect((await authed()).status).toBe(200);

  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");

  const row = settingsPage.tokenRow("e2e phone");
  await settingsPage.expectRowVisible(row);
  await expect(row).toHaveAttribute("data-state", "active");
  await settingsPage.revokeToken("e2e phone");
  await expect(row).toHaveAttribute("data-state", "revoked");
  await expect(settingsPage.revokeTokenButton("e2e phone")).toBeDisabled();

  expect((await authed()).status).toBe(401);
  // The token the page itself uses is the shared one, which can't be revoked from here.
  await expect(settingsPage.revokeTokenButton("Shared token")).toBeDisabled();
});

test("a non-admin device token sees the hosts but is told tokens need an admin token", async ({
  page,
}) => {
  const { token: plainToken } = await trpcMutateData<{ token: string }>(
    server.url,
    TOKEN,
    "tokens.createDevice",
    { label: "e2e plain device" },
  );

  const settingsPage = new SettingsPage(page, server.url, plainToken);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");

  await settingsPage.expectRowVisible(settingsPage.hostRow("local"));
  await settingsPage.expectRowVisible(settingsPage.tokensDenied());
  await expect(settingsPage.tokenRows()).toHaveCount(0);
});
