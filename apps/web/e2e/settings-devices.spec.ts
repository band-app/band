/**
 * Settings > Devices: "Add device" and "Connect details" (a link and QR code with a one-time
 * pairing code, and an address picker), the device list, Revoke (signs the device out and
 * removes it) and the admin-only gate, driven through the real Settings dialog against the
 * real server.
 *
 * The new device opens the link from a second, fresh browser context, so the test proves the
 * link works without the admin session's cookie.
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
import { PairPage } from "./pages/PairPage";
import { SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-devices-token";
const PUBLIC_URL = "https://band.example.ts.net";

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome, env: { BAND_PUBLIC_URL: PUBLIC_URL } });
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

test("S2/S3: adds a device, opens its link in a fresh context, and the link works once", async ({
  page,
  browser,
}) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("devices");

  await settingsPage.addDevice("Phone");
  await expect(settingsPage.pairingResult()).toBeVisible();

  // The public URL is the default, and the link carries a pairing code, not a token.
  await expect(settingsPage.pairingAddress()).toContainText(PUBLIC_URL);
  const publicLink = await settingsPage.pairingLink().inputValue();
  expect(publicLink.startsWith(`${PUBLIC_URL}/?pair=bdp_`)).toBe(true);
  expect(publicLink).not.toContain("bdt_");

  // Picking the page origin updates the link and QR at once. This origin is reachable here.
  await settingsPage.chooseAddress("page");
  const link = await settingsPage.pairingLink().inputValue();
  expect(link.startsWith(`${server.url}/?pair=bdp_`)).toBe(true);
  await expect(settingsPage.pairingQr()).toHaveAttribute("data-value", link);

  // Closing and reopening shows the same link.
  await settingsPage.closePairing();
  await settingsPage.openPairing("Phone");
  expect(await settingsPage.pairingLink().inputValue()).toBe(link);

  // A fresh context signs in as the same device.
  const phoneContext = await browser.newContext();
  await new PairPage(await phoneContext.newPage()).open(link);
  await expect
    .poll(async () => (await phoneContext.cookies(server.url)).some((c) => c.name === "band_token"))
    .toBe(true);
  await phoneContext.close();

  const devices = (await tokens()).filter((t) => t.label === "Phone");
  expect(devices).toHaveLength(1);

  // The same link a second time is refused with a clear message.
  const secondContext = await browser.newContext();
  const secondPair = new PairPage(await secondContext.newPage());
  await secondPair.open(link);
  await expect(secondPair.message()).toHaveAttribute("data-state", "refused");
  expect((await secondContext.cookies(server.url)).some((c) => c.name === "band_token")).toBe(
    false,
  );
  await secondContext.close();
});

test("S2: Regenerate shows a new link and the old one stops working", async ({ page, browser }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("devices");
  await settingsPage.addDevice("Tablet");
  await expect(settingsPage.pairingResult()).toBeVisible();
  await settingsPage.chooseAddress("page");
  const before = await settingsPage.pairingLink().inputValue();

  await settingsPage.regeneratePairing();
  await expect(settingsPage.pairingLink()).not.toHaveValue(before);

  const context = await browser.newContext();
  const stale = new PairPage(await context.newPage());
  await stale.open(before);
  await expect(stale.message()).toHaveAttribute("data-state", "refused");
  await context.close();
});

test("S6/S7/S8: the address picker lists the hub's addresses and keeps custom ones", async ({
  page,
}) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("devices");
  await settingsPage.addDevice("Picker");
  await expect(settingsPage.pairingResult()).toBeVisible();

  // Public URL first, then this page, then interfaces ranked by the hub, bridges last,
  // then custom addresses. The first two labels name their address.
  const sources = await settingsPage.pairingOptionSources();
  expect(sources.slice(0, 2)).toEqual(["public", "page"]);
  expect(sources.slice(2).every((s) => s === "interface")).toBe(true);
  const options = await settingsPage.pairingAddressOptions();
  expect(options[0]).toContain(PUBLIC_URL);
  expect(options[1]).toContain(server.url);
  const kinds = await settingsPage
    .pairingOptions()
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
  const firstBridge = kinds.indexOf("bridge");
  if (firstBridge >= 0) expect(kinds.slice(firstBridge).every((k) => k === "bridge")).toBe(true);
  expect(options.slice(2).join("\n")).not.toMatch(/127\.0\.0\.1 \(|fe80:|198\.1[89]\./);

  await settingsPage.refreshAddresses();
  await expect(settingsPage.pairingAddress()).toBeVisible();

  // A custom address is validated, saved, offered again on the next open, and can be removed.
  await settingsPage.addCustomAddress("ftp://nope");
  await expect(settingsPage.pairingError()).toBeVisible();
  await settingsPage.cancelCustomAddress();
  await settingsPage.addCustomAddress("https://custom.example.ts.net");
  await expect(settingsPage.pairingLink()).toHaveValue(
    /^https:\/\/custom\.example\.ts\.net\/\?pair=/,
  );
  await settingsPage.closePairing();

  await settingsPage.openPairing("Picker");
  // The last choice is remembered for this hub.
  await expect(settingsPage.pairingLink()).toHaveValue(/^https:\/\/custom\.example\.ts\.net\//);
  await settingsPage.removeCustomAddress();
  await expect
    .poll(async () => (await settingsPage.pairingAddressOptions()).join("\n"))
    .not.toContain("custom.example");
  await expect(settingsPage.pairingLink()).toHaveValue(new RegExp(`^${PUBLIC_URL}/`));
});

test("S1: revoking a device removes it, and its token stops working", async ({ page }) => {
  const { token, view } = await trpcMutateData<{ token: string; view: TokenView }>(
    server.url,
    TOKEN,
    "tokens.createDevice",
    { label: "iPhone" },
  );
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("devices");
  const row = settingsPage.deviceRow("iPhone");
  await settingsPage.expectRowVisible(row);

  const authed = () =>
    fetch(`${server.url}/trpc/repos.list`, { headers: { Authorization: `Bearer ${token}` } });
  expect((await authed()).status).toBe(200);

  await settingsPage.revokeDeviceButton("iPhone").click();
  // Nothing happens until the confirmation.
  await expect(settingsPage.confirmRevokeDeviceButton("iPhone")).toBeVisible();
  expect((await authed()).status).toBe(200);
  await settingsPage.confirmRevokeDeviceButton("iPhone").click();

  await expect(row).toHaveCount(0);
  expect((await authed()).status).toBe(401);
  expect((await tokens()).some((t) => t.id === view.id)).toBe(false);

  await settingsPage.reload();
  await settingsPage.openDialog("devices");
  await expect(settingsPage.deviceRow("iPhone")).toHaveCount(0);
});

test("S7: with no public URL the page origin is the default and no bridge is preselected", async ({
  page,
}) => {
  const home = createTmpHome();
  seedSettings(home, { tokenSecret: TOKEN });
  const plain = await startServer({ tmpHome: home, env: { BAND_PUBLIC_URL: "" } });
  try {
    const settingsPage = new SettingsPage(page, plain.url, TOKEN);
    await settingsPage.goto();
    await settingsPage.openDialog("devices");
    await settingsPage.addDevice("NoPublic");
    await expect(settingsPage.pairingResult()).toBeVisible();
    const sources = await settingsPage.pairingOptionSources();
    expect(sources).not.toContain("public");
    expect(sources[0]).toBe("page");
    await expect(settingsPage.pairingLink()).toHaveValue(new RegExp(`^${plain.url}/\\?pair=`));
    // The selected option is the page origin, never a bridge.
    await expect(settingsPage.pairingAddress()).toHaveValue(plain.url);
  } finally {
    await plain.close();
    cleanupTmpHome(home);
  }
});

test("S9: a non-admin device does not see Devices and gets 403 from the pairing procedures", async ({
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
  await expect(settingsPage.navEntry("devices")).toHaveCount(0);

  const res = await fetch(`${server.url}/trpc/tokens.pairingAddresses`, {
    headers: { Authorization: `Bearer ${plainToken}` },
  });
  expect(res.status).toBe(403);
});

test("revoking the session's own token asks for confirmation and says it signs you out", async ({
  page,
}) => {
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
  await expect(row).toHaveAttribute("data-confirming", "self");
  expect((await tokens()).find((t) => t.label === "e2e own admin")?.state).toBe("active");

  await settingsPage.confirmRevokeDeviceButton("e2e own admin").click();
  await expect
    .poll(async () => (await tokens()).some((t) => t.label === "e2e own admin"))
    .toBe(false);
});
