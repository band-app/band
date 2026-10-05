/**
 * Settings › Browser: the browser profile list and, in a collapsed
 * "Repo defaults" accordion, each repo's default profile, driven
 * through the real Settings dialog against the real server.
 *
 * Profiles are seeded over tRPC (the Chrome import that normally creates
 * them runs in the desktop app, which the e2e harness does not boot). The
 * assertions read the server back over tRPC: a repo's default decides
 * which profile a new browser tab in any of its worktrees opens with.
 */

import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcMutate, trpcQuery } from "./helpers/trpc";
import { SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-browser-profiles-token";
const REPO = "alpha-profiles";
const OTHER_REPO = "beta-profiles";
// Both repos carry the same repo label. The rows used to be named
// after it, so the two showed up as one repeated `lbl_...` id.
const SHARED_LABEL = "lbl_e2e_shared";
const FEATURE_BRANCH = "feat/login";
const PROFILE_ID = "profile_e2e_work";
const PROFILE_NAME = "Work (Chrome)";

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: `/tmp/fake/${REPO}`,
        defaultBranch: "main",
        label: SHARED_LABEL,
        worktrees: [
          { branch: "main", path: `/tmp/fake/${REPO}` },
          { branch: FEATURE_BRANCH, path: `/tmp/fake/${REPO}-feature` },
        ],
      },
      {
        name: OTHER_REPO,
        path: `/tmp/fake/${OTHER_REPO}`,
        defaultBranch: "main",
        label: SHARED_LABEL,
        worktrees: [{ branch: "main", path: `/tmp/fake/${OTHER_REPO}` }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
  await trpcMutate(server.url, TOKEN, "browserProfiles.create", {
    id: PROFILE_ID,
    name: PROFILE_NAME,
    source: "chrome",
  });
});

// UI state lives on the server now: start each test from none, like the
// fresh localStorage each test's browser context used to give it.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

async function repoDefault(): Promise<string | null> {
  const data = await trpcQuery<{ profileId: string | null }>(
    server.url,
    TOKEN,
    "browserProfiles.getRepoDefault",
    { repoName: REPO },
  );
  return data.profileId;
}

async function newTabProfile(worktreeId: string): Promise<string | null> {
  const before = await trpcQuery<{ browsers: { id: string }[] }>(
    server.url,
    TOKEN,
    "browsers.list",
    { worktreeId },
  );
  await trpcMutate(server.url, TOKEN, "browsers.create", { worktreeId });
  const after = await trpcQuery<{ browsers: { id: string; profileId: string | null }[] }>(
    server.url,
    TOKEN,
    "browsers.list",
    { worktreeId },
  );
  const known = new Set(before.browsers.map((b) => b.id));
  const created = after.browsers.find((b) => !known.has(b.id));
  if (!created) throw new Error("browsers.create did not add a tab");
  return created.profileId;
}

test("repo defaults start collapsed and list each repo once by name", async ({ page }) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("browser");

  await settingsPage.expectRowVisible(settingsPage.browserProfileRows().first());
  await settingsPage.expectRowVisible(settingsPage.repoDefaultsTrigger());
  await expect(settingsPage.repoDefaultsTrigger()).toHaveAttribute("aria-expanded", "false");
  await expect(settingsPage.repoBrowserProfileSelect(REPO)).toBeHidden();

  await settingsPage.expandRepoDefaults();

  await expect(settingsPage.repoBrowserProfileRows()).toHaveCount(2);
  // The repo names come from the seed above, so matching on their text is safe.
  await expect(settingsPage.repoBrowserProfileRows()).toContainText([REPO, OTHER_REPO]);
  await expect(settingsPage.repoBrowserProfileSelect(REPO)).toBeVisible();
  await expect(settingsPage.repoBrowserProfileSelect(OTHER_REPO)).toBeVisible();
  await expect(settingsPage.repoBrowserProfileSelect(SHARED_LABEL)).toHaveCount(0);
});

test("picking a repo's browser profile makes new tabs in every worktree use it", async ({
  page,
}) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("browser");

  await settingsPage.expectRowVisible(settingsPage.browserProfileRows().first());
  await expect(settingsPage.browserProfileRows()).toHaveCount(1);
  await settingsPage.expandRepoDefaults();
  await expect(settingsPage.repoBrowserProfileSelect(REPO)).toContainText("Default");

  await settingsPage.selectRepoBrowserProfile(REPO, PROFILE_NAME);

  await expect.poll(repoDefault).toBe(PROFILE_ID);
  await expect(settingsPage.repoBrowserProfileSelect(OTHER_REPO)).toContainText("Default");
  expect(await newTabProfile(toWorktreeId(REPO, FEATURE_BRANCH))).toBe(PROFILE_ID);
  expect(await newTabProfile(toWorktreeId(REPO, "main"))).toBe(PROFILE_ID);
});

test("deleting a profile removes it and puts its repo back on Default", async ({ page }) => {
  await trpcMutate(server.url, TOKEN, "browserProfiles.setRepoDefault", {
    repoName: REPO,
    profileId: PROFILE_ID,
  });
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("browser");
  await settingsPage.expandRepoDefaults();
  await settingsPage.expectRowVisible(settingsPage.repoBrowserProfileSelect(REPO));
  await expect(settingsPage.repoBrowserProfileSelect(REPO)).toContainText(PROFILE_NAME);

  await settingsPage.deleteBrowserProfile(PROFILE_NAME);

  await expect(settingsPage.browserProfileRows()).toHaveCount(0);
  await expect(settingsPage.repoBrowserProfileSelect(REPO)).toContainText("Default");
  await expect.poll(repoDefault).toBeNull();
  expect(await newTabProfile(toWorktreeId(REPO, "main"))).toBeNull();
});
