/**
 * GitHub project avatars in the sidebar.
 *
 * A git project whose `origin` is on github.com shows its owner's avatar in
 * the project header instead of the folder icon. A project on another host
 * keeps the folder, and so does a GitHub project whose avatar cannot be
 * fetched (GitHub down or offline, nothing cached).
 *
 * Real production binary, real git repos with real remotes, github.com
 * replaced by the Express stub in `tests/fixtures/github-stub.ts` through
 * `BAND_GITHUB_URL`. No tRPC mocks, page objects only.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { type GitHubStub, githubStub } from "../tests/fixtures/github-stub";
import { AVATAR_PNG } from "../tests/fixtures/github-test-data";
import { gitInHome } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { CronjobsDialog } from "./pages/CronjobsDialog";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-project-avatars-token";
const GITHUB_PROJECT = "widgets";
const GITLAB_PROJECT = "tool";
const UNREACHABLE_PROJECT = "outage";

// Wide viewport so `useIsDesktop()` reports true and the desktop sidebar
// renders the project list.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;
let stub: GitHubStub;

function makeRepo(name: string, origin: string): string {
  const path = join(tmpHome, name);
  mkdirSync(path, { recursive: true });
  gitInHome(path, ["init", "-b", "main"], tmpHome);
  gitInHome(path, ["commit", "--allow-empty", "-m", "init"], tmpHome);
  gitInHome(path, ["remote", "add", "origin", origin], tmpHome);
  return path;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const project = (name: string, origin: string) => {
    const path = makeRepo(name, origin);
    return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
  };
  seedState(tmpHome, {
    projects: [
      project(GITHUB_PROJECT, "git@github.com:acme-org/widgets.git"),
      project(GITLAB_PROJECT, "https://gitlab.com/acme/tool.git"),
      project(UNREACHABLE_PROJECT, "https://github.com/outage-owner/down.git"),
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });

  stub = await githubStub.start();
  stub.setAvatar("acme-org", AVATAR_PNG);
  stub.setAvatarStatus("outage-owner", 503);
  server = await startServer({ tmpHome, env: { BAND_GITHUB_URL: stub.baseUrl } });
});

test.afterAll(async () => {
  await server?.close();
  await stub?.stop();
  cleanupTmpHome(tmpHome);
});

test.describe("GitHub project avatars", () => {
  test("a GitHub project shows its owner's avatar instead of the folder icon", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(toWorkspaceId(GITHUB_PROJECT, "main"));

    await expect(workspacePage.projectAvatar(GITHUB_PROJECT)).toBeVisible();
    await expect(workspacePage.projectAvatar(GITHUB_PROJECT)).toHaveAttribute(
      "alt",
      "acme-org/widgets",
    );
    expect(await workspacePage.readProjectAvatarNaturalWidth(GITHUB_PROJECT)).toBe(1);
    await expect(workspacePage.projectFolderIcon(GITHUB_PROJECT)).toHaveCount(0);
  });

  test("a project hosted elsewhere keeps the folder icon", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(toWorkspaceId(GITLAB_PROJECT, "main"));

    await expect(workspacePage.projectFolderIcon(GITLAB_PROJECT)).toBeVisible();
    await expect(workspacePage.projectAvatar(GITLAB_PROJECT)).toHaveCount(0);
  });

  test("a GitHub project whose avatar cannot be fetched falls back to the folder icon", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await workspacePage.goto(toWorkspaceId(UNREACHABLE_PROJECT, "main"));

    // Positive anchor: the neighbouring GitHub project's avatar rendered, so
    // the project list has loaded its avatar data.
    await expect(workspacePage.projectAvatar(GITHUB_PROJECT)).toBeVisible();
    await expect(workspacePage.projectFolderIcon(UNREACHABLE_PROJECT)).toBeVisible();
    // The failed image is removed rather than left as a broken glyph.
    await expect(workspacePage.projectAvatar(UNREACHABLE_PROJECT)).toHaveCount(0);
  });

  test("the cronjob project picker shows the avatar next to GitHub projects", async ({ page }) => {
    const cronjobs = new CronjobsDialog(page, server.url, TOKEN);
    await cronjobs.goto();
    await cronjobs.open();
    await cronjobs.openProjectPicker();

    await expect(cronjobs.projectAvatar(GITHUB_PROJECT)).toBeVisible();
    // Positive anchor: the GitLab project's option rendered, without an avatar.
    await expect(cronjobs.projectOption(GITLAB_PROJECT)).toBeVisible();
    await expect(cronjobs.projectAvatar(GITLAB_PROJECT)).toHaveCount(0);
  });
});
