/**
 * The right sidepanel's tabs show icon + title while they fit, and all
 * switch to icons only (title as tooltip and accessible name) when the
 * strip is too narrow. The test drags the panel's separator.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { git, gitCommit } from "./helpers/git";
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

const TOKEN = "e2e-right-panel-tabs-icons-token";
const REPO = "alpha-tabs-icons";
const WORKTREE = toWorktreeId(REPO, "main", "local");

test.use({ viewport: { width: 1600, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO);
  mkdirSync(repoPath, { recursive: true });
  // A github.com origin gives the worktree a review provider, so it has the Checks tab too.
  git(repoPath, ["init", "-b", "main"]);
  writeFileSync(join(repoPath, "README.md"), "hello\n");
  gitCommit(repoPath, "init");
  git(repoPath, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repoPath,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("tabs collapse to icons when titles do not fit and return when there is room", async ({
  page,
}) => {
  const wp = new WorktreePage(page, server.url, TOKEN);
  await wp.gotoAndWaitForPlugins(WORKTREE);
  await wp.waitForReady();
  await wp.revealRightPanel();

  // S1: room for titles.
  await wp.resizeRightPanelTo(600);
  await expect(wp.rightPanelTab("explorer")).toContainText("Explorer");
  expect(await wp.rightPanelTabsFitStrip()).toBe(true);

  // S2: narrow the panel until it can't hold the titles.
  await wp.resizeRightPanelTo(260);
  await expect(wp.rightPanelTab("explorer")).not.toContainText("Explorer");
  await expect(wp.rightPanelTab("changes")).not.toContainText("Changes");
  expect(await wp.rightPanelTabsFitStrip()).toBe(true);

  // S4: the title stays as the accessible name and tabs still switch.
  const changes = page.getByRole("tab", { name: "Changes" });
  await changes.click();
  await expect(changes).toHaveAttribute("aria-selected", "true");
  await expect(changes).toHaveAttribute("title", "Changes");

  // S3: widen again.
  await wp.resizeRightPanelTo(600);
  await expect(wp.rightPanelTab("explorer")).toContainText("Explorer");
  await expect(wp.rightPanelTab("changes")).toContainText("Changes");
});
