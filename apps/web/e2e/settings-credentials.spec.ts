/**
 * Settings > Credentials (plan step 4.1): add an API key whose value is write-only, connect an
 * OAuth-protected server through the consent window (started from the MCP form, plan step 4.5),
 * and delete both. The authorization server is
 * a real local Express stub with discovery, dynamic client registration and PKCE
 * (`apps/hub/tests/fixtures/oauth-stub.ts`). Real hub, temp BAND_HOME.
 * `apps/hub/tests/vault.test.ts` covers encryption, rotation, refresh and revocation.
 */

import { expect, test } from "@playwright/test";
import { type OAuthStub, startOAuthStub } from "../../hub/tests/fixtures/oauth-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  startServer,
} from "./helpers/server";
import { SettingsPage } from "./pages/SettingsPage";

test.use({ viewport: { width: 1280, height: 800 } });

const TOKEN = "e2e-credentials-token";
const SECRET = "sk-e2e-WRITE-ONLY-VALUE-123";

let server: ServerHandle;
let tmpHome: string;
let oauth: OAuthStub;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  oauth = await startOAuthStub();
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  await oauth.close();
  cleanupTmpHome(tmpHome);
});

test("adds an API key whose value is never shown again, then deletes it", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("credentials");

  await settingsPage.addCredential("E2E_API_KEY", SECRET);
  const row = settingsPage.credentialRow("E2E_API_KEY");
  await settingsPage.expectRowVisible(row);
  await expect(row).toHaveAttribute("data-kind", "api_key");
  // The value is write-only: it is in neither the row nor the page.
  await expect(row).not.toContainText(SECRET);
  await expect(settingsPage.dialog).not.toContainText(SECRET);

  await settingsPage.deleteCredential("E2E_API_KEY");
  await expect(row).toHaveCount(0);
});

test("adds a git credential on the Credentials page, and the MCP form does not offer it", async ({
  page,
}) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("credentials");

  await settingsPage.addGitCredential(
    "E2E_GIT_TOKEN",
    "ghp_E2E_GIT_SECRET_123",
    "github.com",
    "acme/*",
  );
  const row = settingsPage.credentialRow("E2E_GIT_TOKEN");
  await settingsPage.expectRowVisible(row);
  await expect(row).toHaveAttribute("data-kind", "git");
  await expect(settingsPage.dialog).not.toContainText("ghp_E2E_GIT_SECRET_123");

  // A git credential cannot authenticate an MCP server, so the picker leaves it out.
  await settingsPage.openSection("mcp");
  await settingsPage.dialog.getByTestId("settings__mcp-add").click();
  await expect(settingsPage.mcpCredentialOptions().first()).toBeAttached();
  await expect(
    settingsPage.mcpCredentialOptions().filter({ hasText: "E2E_GIT_TOKEN" }),
  ).toHaveCount(0);

  await settingsPage.openSection("credentials");
  await settingsPage.deleteCredential("E2E_GIT_TOKEN");
  await expect(row).toHaveCount(0);
});

test("connects an OAuth server through the consent window, then deletes and revokes it", async ({
  page,
}) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("mcp");

  const consent = await settingsPage.connectMcpOAuth("e2e-mcp", oauth.resourceUrl);
  // The stub consents at once and redirects the window back to the hub's callback.
  await settingsPage.expectOAuthCallbackConnected(consent);

  await settingsPage.openSection("credentials");
  const row = settingsPage.credentialRow("e2e-mcp");
  await settingsPage.expectRowVisible(row);
  await expect(row).toHaveAttribute("data-kind", "oauth");
  await expect(settingsPage.credentialOAuthDetail(row)).toContainText("tester@example.test");
  await expect(settingsPage.credentialOAuthDetail(row)).toContainText("read write");

  const revocations = oauth.revocations.length;
  await settingsPage.deleteCredential("e2e-mcp");
  await expect(row).toHaveCount(0);
  expect(oauth.revocations.length).toBe(revocations + 1);
});

test("shows the hub's refusal when a server cannot be reached", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("mcp");

  await settingsPage.connectMcpOAuth("nowhere", "http://127.0.0.1:1/mcp");
  await expect(settingsPage.mcpError()).toBeVisible();
  await settingsPage.openSection("credentials");
  await expect(settingsPage.credentialRow("nowhere")).toHaveCount(0);
});
