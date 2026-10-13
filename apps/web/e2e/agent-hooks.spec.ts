/**
 * Claude Code hooks are the user's choice. A fresh setup writes nothing to
 * `~/.claude/settings.json`; a banner offers to install the hooks, can be
 * dismissed for good, and Settings > Agent hooks installs or removes them per
 * host. Remove deletes only Band's entries.
 *
 * Real hub with a temporary HOME (the hub's `~/.claude` is the temp one). A
 * fake `band` on PATH stands in for the CLI, which nothing runs. The worker case
 * is covered with a real `band-worker` in `apps/hub/tests/claude-hooks-install.test.ts`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  startServer,
} from "./helpers/server";
import { SettingsPage } from "./pages/SettingsPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-agent-hooks-token";
const BANNER_TEXT =
  "To get notifications from agents running in a terminal, Claude Code hooks need to be installed.";
const USER_HOOK = { type: "command", command: "/usr/bin/true user-own-hook" };
const DISMISSED_KEY = "band:agent-hooks-banner-dismissed";

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

const settingsFile = () => join(tmpHome, ".claude", "settings.json");
const userSettings = { theme: "dark", hooks: { Stop: [{ hooks: [USER_HOOK] }] } };
const readSettings = () => JSON.parse(readFileSync(settingsFile(), "utf8"));
const bandEntryCount = () =>
  Object.values(readSettings().hooks ?? {})
    .flat()
    .filter((e) => JSON.stringify(e).includes(" notify ")).length;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const bin = join(tmpHome, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "band"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "band"), 0o755);
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  server = await startServer({ tmpHome, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
});

test.beforeEach(() => {
  resetClientState(tmpHome);
  mkdirSync(join(tmpHome, ".claude"), { recursive: true });
  writeFileSync(settingsFile(), `${JSON.stringify(userSettings, null, 2)}\n`);
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("a fresh setup leaves the settings file alone and offers the install in a banner", async ({
  page,
}, testInfo) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  await settings.goto();
  await expect(settings.hooksBanner).toContainText(BANNER_TEXT);
  await testInfo.attach("hooks-banner", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  // Nothing was written: the file is the one the test made.
  expect(readSettings()).toEqual(userSettings);
});

test("dismissing the banner hides it, and it stays hidden after a reload", async ({ page }) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  await settings.goto();
  await expect(settings.hooksBanner).toBeVisible();

  await settings.hooksBannerDismiss.click();
  await expect(settings.hooksBanner).toBeHidden();
  // Wait until the dismissal reached the server, which keeps it across devices.
  await expect.poll(() => worktree.readServerClientState(null, DISMISSED_KEY)).not.toBeNull();

  await settings.goto();
  await expect(settings.hooksBanner).toHaveCount(0);
  expect(readSettings()).toEqual(userSettings);
});

test("Install in the banner installs the hooks and keeps the user's own", async ({ page }) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  await settings.goto();

  await settings.hooksBannerInstall.click();
  await expect(settings.hooksBanner).toHaveCount(0);

  const written = readSettings();
  expect(written.theme).toBe("dark");
  expect(written.hooks.Stop[0]).toEqual({ hooks: [USER_HOOK] });
  expect(bandEntryCount()).toBeGreaterThan(5);
});

test("Settings > Agent hooks lists the host, installs, and removes only Band's entries", async ({
  page,
}, testInfo) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  await settings.goto();
  await settings.openDialog("agent-hooks");

  const row = settings.hooksHostRow("local");
  await expect(row).toHaveAttribute("data-state", "not_installed");
  await expect(settings.hooksRemoveButton("local")).toBeDisabled();

  await settings.hooksInstallButton("local").click();
  await expect(row).toHaveAttribute("data-state", "installed");
  await expect(settings.hooksInstallButton("local")).toHaveText("Reinstall");
  expect(bandEntryCount()).toBeGreaterThan(5);
  await testInfo.attach("agent-hooks-installed", {
    body: await settings.dialog.screenshot(),
    contentType: "image/png",
  });

  await settings.hooksRemoveButton("local").click();
  await expect(row).toHaveAttribute("data-state", "not_installed");
  expect(existsSync(settingsFile())).toBe(true);
  expect(readSettings()).toEqual(userSettings);
});
