/**
 * A worktree being deleted stays in the sidebar, disabled and marked
 * "Deleting…", until it is gone.
 *
 * Removal waits for the repo's `.band/config.json` `teardown` command,
 * which here sleeps for a few seconds, so there is a window to observe:
 *
 *   - deleting from the sidebar marks the card from the moment the request
 *     goes out;
 *   - deleting through the API (as the CLI does) marks it from the server's
 *     teardown status, since this dashboard never sent that request.
 *
 * Real production server, real git repo, real teardown in a terminal. No
 * tRPC mocking, no `page.route()`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
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
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-worktree-deleting-state-token";
const REPO = "deleting-repo";
const DEFAULT_BRANCH = "main";
const BRANCH_UI = "feature-delete-ui";
const BRANCH_API = "feature-delete-api";

const WORKTREE_MAIN = toWorktreeId(REPO, DEFAULT_BRANCH, "local");
const WORKTREE_UI = toWorktreeId(REPO, BRANCH_UI, "local");
const WORKTREE_API = toWorktreeId(REPO, BRANCH_API, "local");

// Long enough to observe the deleting state, well under the 60s cap. The
// API case asserts the marker within MARKER_TIMEOUT_MS, well before the
// teardown ends and the `remove` event arrives, so only the teardown's
// `setup-status` event can satisfy it.
const TEARDOWN = "sleep 10";
const MARKER_TIMEOUT_MS = 3_000;

test.use({ viewport: { width: 1280, height: 800 } });

/** `worktrees.remove` straight over HTTP, the way the `band` CLI calls it. */
function removeViaApi(serverUrl: string, name: string): Promise<Response> {
  return fetch(`${serverUrl}/trpc/worktrees.remove`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
    body: JSON.stringify({ repo: REPO, name }),
  });
}

let server!: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO);
  mkdirSync(repoPath, { recursive: true });
  gitInHome(repoPath, ["init", "-b", DEFAULT_BRANCH], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# Deleting state test\n");
  gitInHome(repoPath, ["add", "."], tmpHome);
  gitInHome(repoPath, ["commit", "-m", "initial commit"], tmpHome);
  // Untracked, so the worktrees fall back to the repo's copy.
  mkdirSync(join(repoPath, ".band"), { recursive: true });
  writeFileSync(join(repoPath, ".band", "config.json"), JSON.stringify({ teardown: TEARDOWN }));

  const uiPath = join(tmpHome, `${REPO}-${BRANCH_UI}`);
  const apiPath = join(tmpHome, `${REPO}-${BRANCH_API}`);
  gitInHome(repoPath, ["worktree", "add", "-b", BRANCH_UI, uiPath], tmpHome);
  gitInHome(repoPath, ["worktree", "add", "-b", BRANCH_API, apiPath], tmpHome);

  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repoPath,
        defaultBranch: DEFAULT_BRANCH,
        worktrees: [
          { branch: DEFAULT_BRANCH, path: repoPath },
          { branch: BRANCH_UI, path: uiPath },
          { branch: BRANCH_API, path: apiPath },
        ],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

// UI state lives on the server now: start each test from none, like the
// fresh localStorage each test's browser context used to give it.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  if (server) await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Worktree deleting state in the sidebar", () => {
  test("a card deleted from the sidebar is disabled and marked until it is gone", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    await worktreePage.goto(WORKTREE_MAIN);
    await worktreePage.waitForReady();
    const card = worktreePage.worktreeCard(WORKTREE_UI);
    await expect(card).toBeVisible();
    await expect(card).not.toHaveAttribute("aria-disabled");

    await worktreePage.deleteWorktreeFromSidebar(WORKTREE_UI);

    await expect(worktreePage.worktreeDeletingMarker(WORKTREE_UI)).toBeVisible();
    await expect(card).toHaveAttribute("aria-disabled", "true");

    // Clicking the disabled card does not open it.
    await worktreePage.clickDisabledWorktreeCard(WORKTREE_UI);
    await expect(worktreePage.worktreeCard(WORKTREE_MAIN)).toHaveAttribute("aria-current", "page");
    await expect(card).not.toHaveAttribute("aria-current");

    await expect(card).toHaveCount(0, { timeout: 30_000 });
  });

  test("a card deleted through the API is marked from the server's teardown status", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    await worktreePage.goto(WORKTREE_MAIN);
    await worktreePage.waitForReady();
    const card = worktreePage.worktreeCard(WORKTREE_API);
    await expect(card).toBeVisible();
    await expect(worktreePage.worktreeDeletingMarker(WORKTREE_API)).toHaveCount(0);

    // Not awaited yet: the request resolves only after the teardown.
    const removal = removeViaApi(server.url, BRANCH_API);

    await expect(worktreePage.worktreeDeletingMarker(WORKTREE_API)).toBeVisible({
      timeout: MARKER_TIMEOUT_MS,
    });
    await expect(card).toHaveAttribute("aria-disabled", "true");

    expect((await removal).status).toBe(200);
    await expect(card).toHaveCount(0, { timeout: 30_000 });
  });
});
