/**
 * Settings screens that list vault items share one cache entry, so opening them in any order
 * neither crashes the error boundary nor shows an empty list. Credentials, Voice and Worker
 * profiles all read `trpc.vault.list`. Real hub, temp BAND_HOME.
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
import { trpcMutateData } from "./helpers/trpc";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkerProfilesPage } from "./pages/WorkerProfilesPage";

test.use({ viewport: { width: 1280, height: 800 } });

const TOKEN = "e2e-vault-cache-token";

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
  await trpcMutateData(server.url, TOKEN, "vault.put", {
    name: "cache-key",
    kind: "api_key",
    value: "e2e-placeholder-value-1",
  });
  await trpcMutateData(server.url, TOKEN, "vault.put", {
    name: "cache-git",
    kind: "git",
    host: "github.com",
    pathPattern: "owner/*",
    value: "e2e-placeholder-value-2",
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("Worker profiles after Credentials offers the git item without an error", async ({ page }) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  const profiles = new WorkerProfilesPage(page, server.url, TOKEN);
  await settings.goto();
  await settings.openDialog("credentials");
  await settings.expectRowVisible(settings.credentialRow("cache-key"));

  await profiles.openFromOpenDialog();
  await profiles.openEditorWithRestrictedCredentials();
  await expect(profiles.gitCredentialOption("cache-git")).toBeVisible();
  await expect(page.getByText("Something went wrong!")).toHaveCount(0);
});

test("Credentials after Worker profiles lists the items", async ({ page }) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  const profiles = new WorkerProfilesPage(page, server.url, TOKEN);
  await profiles.open();
  await profiles.openEditorWithRestrictedCredentials();
  await expect(profiles.gitCredentialOption("cache-git")).toBeVisible();

  await settings.openSection("credentials");
  await settings.expectRowVisible(settings.credentialRow("cache-key"));
  await settings.expectRowVisible(settings.credentialRow("cache-git"));
});

test("Voice after Worker profiles offers the api key", async ({ page }) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  const profiles = new WorkerProfilesPage(page, server.url, TOKEN);
  await profiles.open();
  await profiles.openEditorWithRestrictedCredentials();
  await expect(profiles.gitCredentialOption("cache-git")).toBeVisible();

  await settings.openSection("voice");
  await expect(settings.voiceKeyOption("cache-key")).toBeAttached();
  await expect(page.getByText("Something went wrong!")).toHaveCount(0);
});
