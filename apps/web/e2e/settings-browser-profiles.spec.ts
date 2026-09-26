/**
 * Settings › Browser: the browser profile list and each project's default
 * profile, driven through the real Settings dialog against the real server.
 *
 * Profiles are seeded over tRPC (the Chrome import that normally creates
 * them runs in the desktop app, which the e2e harness does not boot). The
 * assertions read the server back over tRPC: a project's default decides
 * which profile a new browser tab in any of its workspaces opens with.
 */

import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcMutate, trpcQuery } from "./helpers/trpc";
import { SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-browser-profiles-token";
const PROJECT = "alpha-profiles";
const FEATURE_BRANCH = "feat/login";
const PROFILE_ID = "profile_e2e_work";
const PROFILE_NAME = "Work (Chrome)";

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: `/tmp/fake/${PROJECT}`,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: `/tmp/fake/${PROJECT}` },
          { branch: FEATURE_BRANCH, path: `/tmp/fake/${PROJECT}-feature` },
        ],
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

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

async function projectDefault(): Promise<string | null> {
  const data = await trpcQuery<{ profileId: string | null }>(
    server.url,
    TOKEN,
    "browserProfiles.getProjectDefault",
    { projectName: PROJECT },
  );
  return data.profileId;
}

async function newTabProfile(workspaceId: string): Promise<string | null> {
  const before = await trpcQuery<{ browsers: { id: string }[] }>(
    server.url,
    TOKEN,
    "browsers.list",
    { workspaceId },
  );
  await trpcMutate(server.url, TOKEN, "browsers.create", { workspaceId });
  const after = await trpcQuery<{ browsers: { id: string; profileId: string | null }[] }>(
    server.url,
    TOKEN,
    "browsers.list",
    { workspaceId },
  );
  const known = new Set(before.browsers.map((b) => b.id));
  const created = after.browsers.find((b) => !known.has(b.id));
  if (!created) throw new Error("browsers.create did not add a tab");
  return created.profileId;
}

test("picking a project's browser profile makes new tabs in every workspace use it", async ({
  page,
}) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog();

  await settingsPage.expectRowVisible(settingsPage.browserProfileRows().first());
  await expect(settingsPage.browserProfileRows()).toHaveCount(1);
  await expect(settingsPage.projectBrowserProfileSelect(PROJECT)).toContainText("Default");

  await settingsPage.selectProjectBrowserProfile(PROJECT, PROFILE_NAME);

  await expect.poll(projectDefault).toBe(PROFILE_ID);
  expect(await newTabProfile(toWorkspaceId(PROJECT, FEATURE_BRANCH))).toBe(PROFILE_ID);
  expect(await newTabProfile(toWorkspaceId(PROJECT, "main"))).toBe(PROFILE_ID);
});

test("deleting a profile removes it and puts its project back on Default", async ({ page }) => {
  await trpcMutate(server.url, TOKEN, "browserProfiles.setProjectDefault", {
    projectName: PROJECT,
    profileId: PROFILE_ID,
  });
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog();
  await settingsPage.expectRowVisible(settingsPage.projectBrowserProfileSelect(PROJECT));
  await expect(settingsPage.projectBrowserProfileSelect(PROJECT)).toContainText(PROFILE_NAME);

  await settingsPage.deleteBrowserProfile(PROFILE_NAME);

  await expect(settingsPage.browserProfileRows()).toHaveCount(0);
  await expect(settingsPage.projectBrowserProfileSelect(PROJECT)).toContainText("Default");
  await expect.poll(projectDefault).toBeNull();
  expect(await newTabProfile(toWorkspaceId(PROJECT, "main"))).toBeNull();
});
