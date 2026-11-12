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
    name: "github-agents",
    kind: "git",
    host: "github.com",
    pathPattern: "owner/*",
    value: "gitpat_e2e_0123456789",
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

const stored = () =>
  trpcQuery<{
    profiles: Array<{ name: string; trust?: string; credentials?: { git?: string[] } }>;
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
    env: "BAND_WORKER_HUB_GIT_CREDENTIALS_ONLY=1",
    restrictCredentials: true,
    gitCredentials: ["github-agents"],
  });
  await profiles.saveEditor();
  await expect(profiles.profile("agent-user")).toHaveAttribute("data-trust", "restricted");
  await expect(profiles.profile("agent-user")).toHaveAttribute(
    "data-credential-policy",
    "restricted",
  );
  await expect
    .poll(async () => (await stored()).profiles.find((p) => p.name === "agent-user")?.credentials)
    .toEqual({ git: ["github-agents"], agentLogins: [] });

  await profiles.edit("agent-user", { trust: "standard" });
  await expect(profiles.profile("agent-user")).toHaveAttribute("data-trust", "standard");

  await profiles.delete("agent-user");
  await expect(profiles.profile("agent-user")).toHaveCount(0);
  expect((await stored()).profiles.map((p) => p.name)).not.toContain("agent-user");
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
