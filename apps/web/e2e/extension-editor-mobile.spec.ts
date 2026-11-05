/**
 * Editor extensions in the phone-width layout (S7): the file opens from the Explorer sheet in
 * the extension's tab, one tab at a time, and Cmd+S saves it to disk.
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
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
import { ExtensionEditorPage } from "./pages/ExtensionEditorPage";
import { FileTreesPage } from "./pages/FileTreesPage";
import { MobileLayoutPage } from "./pages/MobileLayoutPage";
import { WorktreePage } from "./pages/WorktreePage";

test.use({ viewport: { width: 800, height: 900 } });

const TOKEN = "e2e-extension-editor-mobile-token";
const REPO_NAME = "extension-mobile-repo";
const NOTE = "dir/note.band-test";

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;
let worktreeId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(join(repoPath, "dir"), { recursive: true });
  git(repoPath, ["init", "-b", "main"]);
  writeFileSync(join(repoPath, NOTE), "hello from the phone\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  seedState(tmpHome, {
    repos: [
      {
        name: REPO_NAME,
        path: repoPath,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  cpSync(
    join(import.meta.dirname, "fixtures", "extensions", "text-editor"),
    join(tmpHome, ".band", "extensions", "text-editor"),
    { recursive: true },
  );
  server = await startServer({ tmpHome });
  worktreeId = toWorktreeId(REPO_NAME, "main", "local");
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("S7: the file opens in the extension tab on a phone and saves", async ({ page }) => {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const trees = new FileTreesPage(page, worktree);
  const editor = new ExtensionEditorPage(page, worktree, trees);
  await worktree.goto(worktreeId);
  await worktree.waitForMobileReady();
  await new MobileLayoutPage(page, server.url, TOKEN).openSheet("explorer");
  await trees.openFileInMobileSheet("dir", NOTE);

  await expect(editor.editor(NOTE)).toHaveAttribute("data-ready", "true");
  await expect(editor.textarea(NOTE)).toHaveValue("hello from the phone\n");

  await editor.replaceText(NOTE, "edited on the phone\n");
  await expect(editor.dirtyDot(NOTE)).toBeVisible();
  await editor.save(NOTE);

  await expect(editor.dirtyDot(NOTE)).toHaveCount(0);
  expect(readFileSync(join(repoPath, NOTE), "utf8")).toBe("edited on the phone\n");
});

test("S6: the editor is told the layout, and the Save button saves", async ({ page }) => {
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const trees = new FileTreesPage(page, worktree);
  const editor = new ExtensionEditorPage(page, worktree, trees);
  await worktree.goto(worktreeId);
  await worktree.waitForMobileReady();
  await new MobileLayoutPage(page, server.url, TOKEN).openSheet("explorer");
  await trees.openFileInMobileSheet("dir", NOTE);
  await expect(editor.editor(NOTE)).toHaveAttribute("data-ready", "true");
  await expect(editor.layout(NOTE)).toHaveText("compact");

  await expect(editor.saveButton(NOTE)).toBeDisabled();
  await editor.replaceText(NOTE, "saved with the button\n");
  await expect(editor.saveButton(NOTE)).toBeEnabled();
  await editor.saveButton(NOTE).click();
  await expect(editor.saveButton(NOTE)).toBeDisabled();
  expect(readFileSync(join(repoPath, NOTE), "utf8")).toBe("saved with the button\n");

  // A wide window is the regular layout: the editor hears it, and the Save button is gone.
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(editor.layout(NOTE)).toHaveText("regular");
  await expect(editor.saveButton(NOTE)).toHaveCount(0);
});
