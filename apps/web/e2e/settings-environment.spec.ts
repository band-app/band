/**
 * Settings > Environment: each repo's `.band/environment.json`, parsed,
 * with its validation problems and which hosts meet its `requires`, driven
 * through the real Settings dialog against the real server.
 *
 * The repos point at real temp directories that hold the files, because the
 * hub reads `.band/environment.json` from a repo's checkout.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-settings-environment-token";

const FILES: Record<string, string | null> = {
  "env-valid": JSON.stringify({
    install: "pnpm install",
    start: "./scripts/start.sh",
    terminals: [{ name: "dev", command: "pnpm dev" }],
    isolation: "container",
    requires: { node: ">=99" },
  }),
  "env-broken": JSON.stringify({ isolation: "docker", instal: "pnpm install" }),
  "env-missing-file": JSON.stringify({
    build: { devcontainer: ".devcontainer/devcontainer.json" },
  }),
  "env-none": null,
};

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const root = mkdtempSync(join(tmpdir(), "band-e2e-env-"));
  const repos = Object.entries(FILES).map(([name, json]) => {
    const path = join(root, name);
    mkdirSync(join(path, ".band"), { recursive: true });
    if (json !== null) writeFileSync(join(path, ".band", "environment.json"), json);
    return {
      name,
      path,
      defaultBranch: "main",
      worktrees: [{ branch: "main", path }],
    };
  });
  seedState(tmpHome, { repos });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

async function open(page: Page): Promise<SettingsPage> {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("environment");
  return settingsPage;
}

test("a valid environment shows its fields and the hosts that miss requires", async ({ page }) => {
  const settingsPage = await open(page);
  await expect(settingsPage.environmentTrigger("env-valid")).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  await settingsPage.expandEnvironment("env-valid");

  await expect(settingsPage.environmentValid()).toBeVisible();
  await expect(settingsPage.environmentIssues()).toHaveCount(0);
  await expect(settingsPage.environmentSummary()).toContainText("pnpm install");
  await expect(settingsPage.environmentSummary()).toContainText("dev: pnpm dev");
  const local = settingsPage.environmentHosts().first();
  await expect(local).toBeVisible();
  await expect(local).toHaveAttribute("data-meets", "false");
  await expect(local).toContainText("node >=99");
});

test("an invalid environment lists each problem with its path", async ({ page }) => {
  const settingsPage = await open(page);
  await settingsPage.expandEnvironment("env-broken");

  const issues = settingsPage.environmentIssues();
  await expect(issues).toBeVisible();
  await expect(issues).toContainText("instal");
  await expect(issues).toContainText("isolation");
  await expect(settingsPage.environmentValid()).toHaveCount(0);
});

test("a devcontainer file that does not exist is reported", async ({ page }) => {
  const settingsPage = await open(page);
  await settingsPage.expandEnvironment("env-missing-file");

  await expect(settingsPage.environmentIssues()).toContainText("build.devcontainer");
});

test("a repo without the file says so", async ({ page }) => {
  const settingsPage = await open(page);
  await settingsPage.expandEnvironment("env-none");

  await expect(settingsPage.environmentNone()).toBeVisible();
});
