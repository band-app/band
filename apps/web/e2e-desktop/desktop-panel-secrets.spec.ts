/**
 * Panel secrets in the real desktop app: a value set through the bridge comes back after the app
 * restarts, another extension cannot read it, and no file under the home holds it in clear text.
 * The Keychain and Touch ID cannot be driven here, so the app uses the fixed-key test store and
 * skips the prompt (`BAND_DESKTOP_SECRET_STORE=test`).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { acpStubEnv } from "../e2e/helpers/acp-stub";
import { cleanupTmpHome, createTmpHome, getRandomPort, seedSettings } from "../e2e/helpers/server";
import { isPackagedRun, type LaunchedDesktop, launchDesktop } from "./helpers/desktop-app";
import { DesktopDashboardPage } from "./pages/DesktopDashboardPage";

const PASSWORD = "correct-horse-battery-staple";
const KEY = "mac:w1:me";

function filesContaining(dir: string, needle: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesContaining(path, needle));
    else if (entry.isFile() && readFileSync(path).includes(needle)) found.push(path);
  }
  return found;
}

// A packaged app always asks for Touch ID before a read, which no test can answer.
test.skip(isPackagedRun(), "the Touch ID prompt is skipped only in an unpackaged app");

let home: string;
let desktop: LaunchedDesktop | null = null;

test.beforeAll(() => {
  home = createTmpHome();
});
test.afterAll(() => cleanupTmpHome(home));
test.afterEach(async () => {
  await desktop?.close();
  desktop = null;
});

async function launch(): Promise<DesktopDashboardPage> {
  desktop = await launchDesktop({
    home,
    env: acpStubEnv(home, { turns: [{ steps: [{ say: "ok" }] }] }),
  });
  return new DesktopDashboardPage(desktop.window);
}

test("S1/S3: a panel secret survives a restart, is scoped by extension and is never in clear text", async () => {
  seedSettings(home, {
    tokenSecret: "desktop-secrets-token",
    webServerPort: await getRandomPort(),
  });

  let dashboard = await launch();
  await dashboard.panelSecret("set", { extensionId: "desktop", key: KEY, value: PASSWORD });
  expect(await dashboard.panelSecret("get", { extensionId: "desktop", key: KEY })).toBe(PASSWORD);
  expect(await dashboard.panelSecret("get", { extensionId: "other", key: KEY })).toBeNull();
  await desktop?.close();

  dashboard = await launch();
  expect(await dashboard.panelSecret("get", { extensionId: "desktop", key: KEY })).toBe(PASSWORD);
  expect(filesContaining(home, PASSWORD)).toEqual([]);

  await dashboard.panelSecret("delete", { extensionId: "desktop", key: KEY });
  expect(await dashboard.panelSecret("get", { extensionId: "desktop", key: KEY })).toBeNull();
});
