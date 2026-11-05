/**
 * Dropping a file from the file manager onto a tab strip in a plain browser.
 *
 * Only the desktop app can read a dropped file's path, so a browser opens nothing. The drop must
 * also not navigate the window to the file. The desktop behavior (each file opens as a tab) is in
 * `e2e-desktop/desktop-open-local-files.spec.ts`.
 *
 * Test boundary: the drag events are dispatched on the page, but the `File` objects come from a
 * file input filled by Playwright, so they are real files.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { gitInHome as git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { CenterTabStrip } from "./pages/CenterTabStrip";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-tab-strip-file-drop-token";
const REPO = "tab-drop-repo";
const WORKTREE = toWorktreeId(REPO, "main", "local");

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome: string | undefined;
let droppedFile!: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", "main"], tmpHome);
  writeFileSync(join(repoPath, "inside.ts"), "export const inside = 1;\n");
  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-m", "seed"], tmpHome);
  droppedFile = join(tmpHome, "dropped.txt");
  writeFileSync(droppedFile, "dropped\n");
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

test.beforeEach(() => {
  if (tmpHome) resetClientState(tmpHome);
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
});

test("a file dropped on the tab strip in a browser opens nothing and does not navigate", async ({
  page,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  const url = page.url();
  const tabsBefore = await worktreePage.readOpenTabPaths(WORKTREE);

  const strip = new CenterTabStrip(page);
  await expect(strip.strip.first()).toBeVisible();
  await strip.startFileDrag([droppedFile]);
  // The window-level handler cancels the default, so the browser does not open the file.
  expect(await strip.dropOnStrip()).toBe(true);

  expect(page.url()).toBe(url);
  await expect(worktreePage.fileTab(droppedFile)).toHaveCount(0);
  await expect(strip.dropHighlight).toHaveCount(0);
  expect(await worktreePage.readOpenTabPaths(WORKTREE)).toEqual(tabsBefore);
});
