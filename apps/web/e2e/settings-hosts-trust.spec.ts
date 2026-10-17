/**
 * Settings › Hosts: the trust level of a host. An admin token picks restricted, standard or admin in the host's
 * row and the hub stores it; a device token without the admin flag sees the level as a badge and cannot change it.
 * The hub's relay rules for each level are covered in `apps/hub/tests/host-trust-levels.test.ts`.
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

const TOKEN = "e2e-hosts-trust-token";

let server: ServerHandle;
let tmpHome: string;
let hostId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
  const issued = await trpcMutateData<{ hostId: string }>(
    server.url,
    TOKEN,
    "tokens.issueWorkerBootstrap",
    { hostName: "trust-box" },
  );
  hostId = issued.hostId;
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

async function storedTrust(): Promise<string | undefined> {
  const { hosts } = await trpcQuery<{ hosts: Array<{ id: string; trust: string }> }>(
    server.url,
    TOKEN,
    "hosts.list",
  );
  return hosts.find((h) => h.id === hostId)?.trust;
}

test("an admin picks a trust level and the hub stores it", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");

  await expect(settingsPage.hostTrustSelect(hostId)).toHaveValue("standard");
  await settingsPage.chooseHostTrust(hostId, "admin");
  await expect.poll(storedTrust).toBe("admin");
  await expect(settingsPage.hostTrustSelect(hostId)).toHaveValue("admin");

  await settingsPage.chooseHostTrust(hostId, "restricted");
  await expect.poll(storedTrust).toBe("restricted");
});

test("a device token without the admin flag sees the level but cannot change it", async ({
  page,
}) => {
  const { token: plain } = await trpcMutateData<{ token: string }>(
    server.url,
    TOKEN,
    "tokens.createDevice",
    { label: "e2e plain trust device" },
  );
  const settingsPage = new SettingsPage(page, server.url, plain);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");

  await expect(settingsPage.hostTrustBadge(hostId)).toBeVisible();
  await expect(settingsPage.hostTrustSelect(hostId)).toHaveCount(0);
});
