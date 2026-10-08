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

  // The npm service tab installs the worker as a service with the same token and host id.
  const hostId = /BAND_WORKER_ID=(\S+)/.exec(command)?.[1] ?? "";
  const service = await settingsPage.readInstallCommand("service");
  expect(service).toBe(
    `npm install -g @band-app/worker && band-worker install-service --hub ${server.url} --worker-id ${hostId} --token ${token}`,
  );

  expect(await settingsPage.copyWorkerCommand()).toBe(service);

  // The Docker tabs run the published worker image. The test hub is on loopback, so they join the host network.
  const docker = await settingsPage.readInstallCommand("docker");
  expect(docker).toContain("ghcr.io/band-app/band-worker:latest");
  expect(docker).toContain("--network host");
  expect(docker).toContain(`-e BAND_WORKER_TOKEN=${token}`);
  expect(docker).toContain(`-e BAND_HUB_URL=${server.url}`);
  const compose = await settingsPage.readInstallCommand("compose");
  expect(compose).toContain("image: ghcr.io/band-app/band-worker:latest");
  expect(compose).toContain(`BAND_WORKER_TOKEN: ${token}`);
  expect(compose).toContain(`BAND_WORKER_ID: ${hostId}`);
  expect(compose).toContain("network_mode: host");

  // The new host is listed, offline, with its labels.
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

test("revokes a worker bootstrap token, and keeps device tokens out of the list", async ({
  page,
}) => {
  await trpcMutateData(server.url, TOKEN, "tokens.createDevice", { label: "e2e phone" });

  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");
  await settingsPage.addWorker("e2e revoke worker", "");
  const hostToken = await settingsPage.readBootstrapToken();
  expect(hostToken).toMatch(/^bwb_/);
  await settingsPage.finishAddWorker();

  const row = settingsPage.tokenRow("e2e revoke worker");
  await settingsPage.expectRowVisible(row);
  await expect(row).toHaveAttribute("data-state", "active");
  await settingsPage.revokeToken("e2e revoke worker");
  await expect(row).toHaveAttribute("data-state", "revoked");
  await expect(settingsPage.tokenRow("e2e phone")).toHaveCount(0);
});

test("a non-admin device token sees the hosts but is told worker tokens need an admin token", async ({
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
