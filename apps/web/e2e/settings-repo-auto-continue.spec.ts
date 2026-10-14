/**
 * Settings > Repos: the "Continue on another host automatically" switch. It is off until someone
 * turns it on, and the choice is stored on the hub (`repos.autoContinue`).
 *
 * Real production hub with a temp BAND_HOME. The repo is a seeded row; no worker is needed.
 */

import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcQuery } from "./helpers/trpc";
import { FollowPage } from "./pages/FollowPage";
import { SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-repo-auto-continue-token";

let server: ServerHandle;
let tmpHome: string;

const autoContinue = async (name: string) =>
  (
    await trpcQuery<{ repos: Array<{ name: string; autoContinue: boolean }> }>(
      server.url,
      TOKEN,
      "repos.list",
    )
  ).repos.find((r) => r.name === name)?.autoContinue;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  seedState(tmpHome, {
    repos: [
      { name: "everywhere", path: "/nonexistent/everywhere", defaultBranch: "main", worktrees: [] },
    ],
  });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("the switch is off by default and a choice sticks (S2)", async ({ page }) => {
  const settings = new SettingsPage(page, server.url, TOKEN);
  const follow = new FollowPage(page);
  await settings.goto();
  await settings.openDialog("repos");

  await expect(follow.autoContinueSwitch("everywhere")).not.toBeChecked();
  await follow.autoContinueSwitch("everywhere").click();
  await expect(follow.autoContinueSwitch("everywhere")).toBeChecked();
  await expect.poll(() => autoContinue("everywhere")).toBe(true);

  await follow.autoContinueSwitch("everywhere").click();
  await expect(follow.autoContinueSwitch("everywhere")).not.toBeChecked();
  await expect.poll(() => autoContinue("everywhere")).toBe(false);
});
