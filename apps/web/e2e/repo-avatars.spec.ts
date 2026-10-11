/**
 * GitHub repo avatars in the sidebar.
 *
 * A git repo whose `origin` is on github.com shows its owner's avatar in
 * the repo header instead of the folder icon. A repo on another host
 * keeps the folder, and so does a GitHub repo whose avatar cannot be
 * fetched (GitHub down or offline, nothing cached).
 *
 * Real production binary, real git repos with real remotes, github.com
 * replaced by the Express stub in `tests/fixtures/github-stub.ts` through
 * `BAND_GITHUB_URL`. No tRPC mocks, page objects only.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { type GitHubStub, githubStub } from "../../hub/tests/fixtures/github-stub";
import { AVATAR_PNG } from "../../hub/tests/fixtures/github-test-data";
import { gitInHome } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { CronjobsDialog } from "./pages/CronjobsDialog";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-repo-avatars-token";
const GITHUB_REPO = "widgets";
const GITLAB_REPO = "tool";
const UNREACHABLE_REPO = "outage";

// Wide viewport so `useIsDesktop()` reports true and the desktop sidebar
// renders the repo list.
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
  const repo = (name: string, origin: string) => {
    const path = makeRepo(name, origin);
    return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
  };
  seedState(tmpHome, {
    repos: [
      repo(GITHUB_REPO, "git@github.com:acme-org/widgets.git"),
      repo(GITLAB_REPO, "https://gitlab.com/acme/tool.git"),
      repo(UNREACHABLE_REPO, "https://github.com/outage-owner/down.git"),
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });

  stub = await githubStub.start();
  stub.setAvatar("acme-org", AVATAR_PNG);
  stub.setAvatarStatus("outage-owner", 503);
  server = await startServer({ tmpHome, env: { BAND_GITHUB_URL: stub.baseUrl } });
});

// UI state lives on the server now: start each test from none, like the
// fresh localStorage each test's browser context used to give it.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server?.close();
  await stub?.stop();
  cleanupTmpHome(tmpHome);
});

test.describe("GitHub repo avatars", () => {
  test("a GitHub repo shows its owner's avatar instead of the folder icon", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    await worktreePage.goto(toWorktreeId(GITHUB_REPO, "main", "local"));

    await expect(worktreePage.repoAvatar(GITHUB_REPO)).toBeVisible();
    await expect(worktreePage.repoAvatar(GITHUB_REPO)).toHaveAttribute("alt", "acme-org/widgets");
    expect(await worktreePage.readRepoAvatarNaturalWidth(GITHUB_REPO)).toBe(1);
    await expect(worktreePage.repoFolderIcon(GITHUB_REPO)).toHaveCount(0);
  });

  test("a repo hosted elsewhere keeps the folder icon", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    await worktreePage.goto(toWorktreeId(GITLAB_REPO, "main", "local"));

    await expect(worktreePage.repoFolderIcon(GITLAB_REPO)).toBeVisible();
    await expect(worktreePage.repoAvatar(GITLAB_REPO)).toHaveCount(0);
  });

  test("a GitHub repo whose avatar cannot be fetched falls back to the folder icon", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    await worktreePage.goto(toWorktreeId(UNREACHABLE_REPO, "main", "local"));

    // Positive anchor: the neighbouring GitHub repo's avatar rendered, so
    // the repo list has loaded its avatar data.
    await expect(worktreePage.repoAvatar(GITHUB_REPO)).toBeVisible();
    await expect(worktreePage.repoFolderIcon(UNREACHABLE_REPO)).toBeVisible();
    // The failed image is removed rather than left as a broken glyph.
    await expect(worktreePage.repoAvatar(UNREACHABLE_REPO)).toHaveCount(0);
  });

  test("the cronjob repo picker shows the avatar next to GitHub repos", async ({ page }) => {
    const cronjobs = new CronjobsDialog(page, server.url, TOKEN);
    await cronjobs.goto();
    await cronjobs.open();
    await cronjobs.openRepoPicker();

    await expect(cronjobs.repoAvatar(GITHUB_REPO)).toBeVisible();
    // Positive anchor: the GitLab repo's option rendered, without an avatar.
    await expect(cronjobs.repoOption(GITLAB_REPO)).toBeVisible();
    await expect(cronjobs.repoAvatar(GITLAB_REPO)).toHaveCount(0);
  });
});
