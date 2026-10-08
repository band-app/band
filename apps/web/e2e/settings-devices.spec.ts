/**
 * Settings › Devices: "Add device" (sign-in link, QR code and token shown once),
 * the device list with last-used times, Revoke (with a confirmation for the
 * session's own token) and the admin-only gate, driven through the real
 * Settings dialog against the real server.
 *
 * The new device signs in from a second, fresh browser context, so the test
 * proves the link works without the admin session's cookie.
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

const TOKEN = "e2e-devices-token";

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
  lastUsedAt: number | null;
}

async function tokens(): Promise<TokenView[]> {
  return (await trpcQuery<{ tokens: TokenView[] }>(server.url, TOKEN, "tokens.list")).tokens;
}

test("S1/S2: adds a device, signs it in from a fresh context, then revokes it", async ({
  page,
  browser,
}) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("devices");

  await settingsPage.addDevice("Phone");
  await expect(settingsPage.deviceResult()).toBeVisible();
  const signInUrl = await settingsPage.deviceSignInUrl().inputValue();
  const token = await settingsPage.deviceToken().inputValue();
  expect(token).toMatch(/^bdt_/);
  expect(signInUrl).toBe(`${server.url}/?token=${encodeURIComponent(token)}`);
  await expect(settingsPage.deviceQr()).toHaveAttribute("data-value", signInUrl);

  // Not signed in yet: the device has never been used.
  const created = (await tokens()).find((t) => t.label === "Phone");
  expect(created?.lastUsedAt).toBeNull();

  // The link signs in a fresh browser context.
  const phoneContext = await browser.newContext();
  const phonePage = await phoneContext.newPage();
  await phonePage.goto(signInUrl);
  await phonePage.waitForLoadState("networkidle");
  const cookies = await phoneContext.cookies(server.url);
  expect(cookies.some((c) => c.name === "band_token")).toBe(true);
  await phoneContext.close();

  // Closing the dialog discards the secret; the list shows the device as used.
  await settingsPage.closeDeviceResult();
  await expect(settingsPage.deviceResult()).toHaveCount(0);
  const row = settingsPage.deviceRow("Phone");
  await settingsPage.expectRowVisible(row);
  await expect(row).not.toContainText("Last used Never");

  const authed = () =>
    fetch(`${server.url}/trpc/repos.list`, { headers: { Authorization: `Bearer ${token}` } });
  expect((await authed()).status).toBe(200);
  await settingsPage.revokeDeviceButton("Phone").click();
  await expect(row).toHaveAttribute("data-state", "revoked");
  expect((await authed()).status).toBe(401);
});

test("S3: a non-admin device does not see Devices and gets 403 from create", async ({ page }) => {
  const { token: plainToken } = await trpcMutateData<{ token: string }>(
    server.url,
    TOKEN,
    "tokens.createDevice",
    { label: "e2e plain device" },
  );

  const settingsPage = new SettingsPage(page, server.url, plainToken);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");
  await expect(settingsPage.navEntry("devices")).toHaveCount(0);

  const res = await fetch(`${server.url}/trpc/tokens.createDevice`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${plainToken}` },
    body: JSON.stringify({ label: "minted" }),
  });
  expect(res.status).toBe(403);
});

test("S4: revoking the session's own token asks for confirmation", async ({ page }) => {
  const { token: adminToken } = await trpcMutateData<{ token: string }>(
    server.url,
    TOKEN,
    "tokens.createDevice",
    { label: "e2e own admin", admin: true },
  );

  const settingsPage = new SettingsPage(page, server.url, adminToken);
  await settingsPage.goto();
  await settingsPage.openDialog("devices");

  const row = settingsPage.deviceRow("e2e own admin");
  await settingsPage.expectRowVisible(row);
  await expect(row).toHaveAttribute("data-current", "true");

  await settingsPage.revokeDeviceButton("e2e own admin").click();
  // Nothing is revoked until the confirmation.
  await expect(row).toHaveAttribute("data-state", "active");
  await expect(settingsPage.confirmRevokeDeviceButton("e2e own admin")).toBeVisible();
  expect((await tokens()).find((t) => t.label === "e2e own admin")?.state).toBe("active");

  await settingsPage.confirmRevokeDeviceButton("e2e own admin").click();
  await expect
    .poll(async () => (await tokens()).find((t) => t.label === "e2e own admin")?.state)
    .toBe("revoked");
});
