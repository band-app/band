/**
 * Settings > Workers > Profiles: an admin creates, edits and deletes worker profiles, the hub
 * refuses a bad value with the field named, a profile in use cannot be deleted, and the profile
 * selector in a worker's drawer attaches one. The hub rules are covered in
 * `apps/hub/tests/worker-profiles.test.ts`.
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
import { WorkerProfilesPage } from "./pages/WorkerProfilesPage";

const TOKEN = "e2e-worker-profiles-token";

let server: ServerHandle;
let tmpHome: string;
let hostId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
  hostId = (
    await trpcMutateData<{ hostId: string }>(server.url, TOKEN, "tokens.issueWorkerBootstrap", {
      hostName: "profile-box",
    })
  ).hostId;
  await trpcMutateData(server.url, TOKEN, "vault.put", {
    name: "anthropic-key",
    kind: "api_key",
    value: "sk-e2e-0123456789",
  });
  await trpcMutateData(server.url, TOKEN, "vault.put", {
    name: "GH_TOKEN_ITEM",
    kind: "env",
    value: "e2e-gh-0123456789",
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

const stored = () =>
  trpcQuery<{
    profiles: Array<{
      name: string;
      trust?: string;
      secrets?: Array<{ item: string; env?: string; file?: string; mode?: string }>;
      provisioning?: { tokenItem?: string };
    }>;
  }>(server.url, TOKEN, "workerProfiles.list");

test("creates, edits and deletes a profile, and names the field of a bad value", async ({
  page,
}) => {
  const profiles = new WorkerProfilesPage(page, server.url, TOKEN);
  await profiles.open();

  // A name outside BAND_WORKER_* is refused with the field named, and the editor stays open.
  await profiles.create({ name: "agent-user", labels: "gui=1", trust: "restricted", env: "FOO=1" });
  await profiles.saveErrorIcon().click();
  await expect(profiles.saveErrorText()).toContainText("BAND_WORKER_");

  await profiles.fillEditor({
    env: "BAND_WORKER_LINK_LOG_MS=5000",
    tokenItem: "GH_TOKEN_ITEM",
  });
  await profiles.addSecret(0, { item: "anthropic-key", env: "ANTHROPIC_API_KEY" });
  await profiles.addSecret(1, { item: "GH_TOKEN_ITEM", file: "~/.config/gh/token", mode: "0400" });
  await profiles.saveEditor();
  await expect(profiles.profile("agent-user")).toHaveAttribute("data-trust", "restricted");
  await expect
    .poll(async () => (await stored()).profiles.find((p) => p.name === "agent-user")?.secrets)
    .toEqual([
      { item: "anthropic-key", env: "ANTHROPIC_API_KEY" },
      { item: "GH_TOKEN_ITEM", file: "~/.config/gh/token", mode: "0400" },
    ]);
  expect(
    (await stored()).profiles.find((p) => p.name === "agent-user")?.provisioning?.tokenItem,
  ).toBe("GH_TOKEN_ITEM");

  await profiles.edit("agent-user", { trust: "standard" });
  await expect(profiles.profile("agent-user")).toHaveAttribute("data-trust", "standard");

  await profiles.delete("agent-user");
  await expect(profiles.profile("agent-user")).toHaveCount(0);
  expect((await stored()).profiles.map((p) => p.name)).not.toContain("agent-user");
});

test("the hub refuses a reserved env name and a path with .. and names the field", async ({
  page,
}) => {
  const profiles = new WorkerProfilesPage(page, server.url, TOKEN);
  await profiles.open();

  await profiles.startNew({ name: "bad-secrets" });
  await profiles.addSecret(0, { item: "anthropic-key", env: "BAND_X" });
  await profiles.saveEditor();
  await profiles.saveErrorIcon().click();
  await expect(profiles.saveErrorText()).toContainText("secrets.0.env");
  await profiles.dismissError();

  await profiles.removeSecret(0);
  await profiles.addSecret(0, { item: "anthropic-key", env: "PATH" });
  await profiles.saveEditor();
  await profiles.saveErrorIcon().click();
  await expect(profiles.saveErrorText()).toContainText("secrets.0.env");
  await profiles.dismissError();

  await profiles.removeSecret(0);
  await profiles.addSecret(0, { item: "anthropic-key", file: "~/../etc/token" });
  await profiles.saveEditor();
  await profiles.saveErrorIcon().click();
  await expect(profiles.saveErrorText()).toContainText("secrets.0.file");
  expect((await stored()).profiles.map((p) => p.name)).not.toContain("bad-secrets");
});

test("a profile in use cannot be deleted, and the drawer selector attaches and detaches one", async ({
  page,
}) => {
  await trpcMutateData(server.url, TOKEN, "workerProfiles.create", {
    name: "locked",
    trust: "restricted",
  });
  const profiles = new WorkerProfilesPage(page, server.url, TOKEN);
  await profiles.open();
  await profiles.showWorkers();
  await profiles.settings.openHostDrawer(hostId);
  await profiles.workerProfileSelect("profile-box").selectOption("locked");
  await expect(profiles.settings.hostTrustOption(hostId, "restricted")).toBeChecked();

  await profiles.settings.closeHostDrawer();
  await profiles.showProfiles();
  await profiles.delete("locked");
  await profiles.deleteErrorIcon().click();
  await expect(profiles.deleteErrorText()).toBeVisible();
  await expect(profiles.profile("locked")).toHaveAttribute("data-workers", "1");

  await profiles.dismissError();
  await profiles.showWorkers();
  await profiles.settings.openHostDrawer(hostId);
  await profiles.workerProfileSelect("profile-box").selectOption("");
  await expect
    .poll(async () => {
      const { hosts } = await trpcQuery<{ hosts: Array<{ id: string; profile: string | null }> }>(
        server.url,
        TOKEN,
        "hosts.list",
      );
      return hosts.find((h) => h.id === hostId)?.profile;
    })
    .toBeNull();
});

test("the Add worker dialog makes a provisioning command for the picked profile", async ({
  page,
}) => {
  await trpcMutateData(server.url, TOKEN, "workerProfiles.create", {
    name: "for-command",
    trust: "restricted",
  });
  const profiles = new WorkerProfilesPage(page, server.url, TOKEN);
  await profiles.open();
  await profiles.showWorkers();
  await profiles.getProvisioningCommandWith("for-command");
  const command = (await profiles.settings.provisionCommand().textContent()) ?? "";
  const code = /\/api\/provision\/(bpc_[\w-]+)\/script/.exec(command)?.[1];
  expect(code).toBeTruthy();

  // The hub holds the profile with the code: the exchange gives the new worker that profile.
  const res = await fetch(`${server.url}/api/provision/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  expect(res.status).toBe(200);
  await expect
    .poll(async () => {
      const { hosts } = await trpcQuery<{
        hosts: Array<{ profile: string | null; trust: string }>;
      }>(server.url, TOKEN, "hosts.list");
      return hosts.find((h) => h.profile === "for-command")?.trust;
    })
    .toBe("restricted");
});
