/**
 * Regression coverage: saving a file (Cmd+S) keeps the editor's scroll
 * position, cursor, selection and undo history.
 *
 * The save's own file-watcher event triggered `reloadFromDisk`, which replaced
 * the whole CodeMirror document with bytes the editor already held. That reset
 * the scroll to the top and dropped the selection.
 *
 * Architecture (repo integration doctrine): real production server, real git
 * worktree, real Chromium via `WorktreePage`. No tRPC mocking, no route
 * interception.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { git } from "./helpers/git";
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

const TOKEN = "e2e-editor-save-position-token";
const REPO = "editor-save-repo";
const BRANCH = "main";
const FILE = "long.ts";
const OTHER_FILE = "other.ts";
const WORKTREE = toWorktreeId(REPO, BRANCH, "local");

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repoPath = join(tmpHome, REPO);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  const lines = Array.from({ length: 500 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n");
  writeFileSync(join(repoPath, FILE), `${lines}\n`);
  writeFileSync(join(repoPath, OTHER_FILE), "export const other = 1;\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);

  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repoPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repoPath }],
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

// No UI signal says "the save's watcher event was handled and ignored", so the
// test waits a fixed span inside the page for it to arrive.
async function letWatcherEventLand(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 1_500)));
}

test("saving keeps scroll, cursor, selection and undo history", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await worktreePage.openFileLeaf(FILE, WORKTREE);
  await worktreePage.closeTerminalTab(WORKTREE);
  await worktreePage.focusFileEditor(FILE);

  // Cursor on line 410, scrolled well away from the top.
  await worktreePage.pressEditorToDocEnd();
  for (let i = 0; i < 91; i++) await page.keyboard.press("ArrowUp");
  await expect(async () => {
    expect(await worktreePage.activeEditorLineText()).toContain("const line410 =");
  }).toPass({ timeout: 10_000 });
  await page.keyboard.press("End");
  await page.keyboard.type("//x");
  const scrollBefore = await worktreePage.editorScrollTop();
  expect(scrollBefore).toBeGreaterThan(0);

  // S1 + S3: select three characters, save, nothing moves.
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  expect(await worktreePage.selectedText()).toBe("//x");
  await worktreePage.pressSaveShortcut();
  await expect
    .poll(() => readFileSync(join(repoPath, FILE), "utf8").includes("const line410 = 410;//x"))
    .toBe(true);
  await expect(page.getByTestId("center-file-leaf__save")).toHaveCount(0);
  // Give the watcher event time to arrive and be ignored.
  await letWatcherEventLand(page);
  expect(await worktreePage.editorScrollTop()).toBe(scrollBefore);
  expect(await worktreePage.activeEditorLineText()).toContain("const line410 =");
  expect(await worktreePage.selectedText()).toBe("//x");

  // S2: a second save changes nothing.
  await worktreePage.pressSaveShortcut();
  await letWatcherEventLand(page);
  expect(await worktreePage.editorScrollTop()).toBe(scrollBefore);
  expect(await worktreePage.activeEditorLineText()).toContain("const line410 =");

  // S4: history survives the save.
  await worktreePage.pressUndoShortcut();
  await expect(async () => {
    expect(await worktreePage.activeEditorLineText()).not.toContain("//x");
  }).toPass({ timeout: 10_000 });
});

test("switching to another tab and back keeps scroll and cursor", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await worktreePage.openFileLeaf(FILE, WORKTREE);
  await worktreePage.closeTerminalTab(WORKTREE);
  await worktreePage.focusFileEditor(FILE);

  await worktreePage.pressEditorToDocEnd();
  await expect.poll(() => worktreePage.editorScrollTop(), { timeout: 10_000 }).toBeGreaterThan(0);
  // Let the scroll settle before reading it.
  await expect
    .poll(async () => {
      const a = await worktreePage.editorScrollTop();
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
      return a === (await worktreePage.editorScrollTop());
    })
    .toBe(true);
  const scrollBefore = await worktreePage.editorScrollTop();
  const lineBefore = await worktreePage.activeEditorLineText();

  await worktreePage.openFileViaQuickOpen(OTHER_FILE);
  await worktreePage.activateFileTab(FILE);

  await expect.poll(() => worktreePage.editorScrollTop(), { timeout: 10_000 }).toBeGreaterThan(0);
  expect(Math.abs((await worktreePage.editorScrollTop()) - scrollBefore)).toBeLessThan(50);
  expect(await worktreePage.activeEditorLineText()).toBe(lineBefore);
});
