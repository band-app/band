/**
 * End-to-end coverage for the "Copy relative path" / "Copy absolute path"
 * right-click actions in BOTH workspace file trees:
 *
 *   - Files view  → `FileBrowser`.
 *   - Changes view → `ChangesFileTree`.
 *
 * Architecture (mirrors the rest of the e2e suite):
 *   - REAL production `dist/start-server.mjs` boots against a fresh tmp
 *     `$HOME` with an on-disk git worktree. No tRPC mocking — the file
 *     listing and diff come through the same pipelines production uses.
 *   - Clipboard writes are captured via `WorkspacePage.installClipboardCapture`,
 *     which removes `navigator.clipboard` (the non-secure / LAN-IP case) and
 *     records the `execCommand("copy")` fallback payload. That doubles as a
 *     regression guard: code that bypassed the shared `writeClipboardText`
 *     helper and called `navigator.clipboard` directly would copy nothing
 *     here and fail the assertion.
 *
 * The relative path is the workspace-relative file path; the absolute path is
 * the worktree root (the seeded project path) joined with it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { FileTreesPage } from "./pages/FileTreesPage";
import { WorkspacePage } from "./pages/WorkspacePage";

// Wide viewport so `useIsDesktop()` reports true AND the Changes panel's
// container clears the `@[40rem]/diff` query that gates the file-tree
// sidebar — at 2400 px the Changes group lands well past 640 px so the
// ChangesFileTree renders. (Same reasoning as diff-horizontal-scroll.spec.)
test.use({ viewport: { width: 2400, height: 900 } });

const TOKEN = "e2e-copy-file-path-token";
const REPO_NAME = "copy-path-repo";
const BRANCH = "main";
// A NESTED file (not a flat top-level name) so the assertions actually
// distinguish the relative path ("src/notes.txt") from the basename and
// exercise `joinWorkspacePath`'s interior-slash joining for the absolute
// path. A flat filename would pass even if the relative-copy handler copied
// only the basename.
const DIR_PATH = "src";
const FILE_PATH = "src/notes.txt";

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;
let workspaceId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(repoPath, { recursive: true });

  // Commit the file at HEAD, then leave a modification on disk so the
  // Changes view lists it ("M") and the Files view lists it as a normal
  // entry. The file lives in a subdirectory so the copied paths are
  // multi-segment.
  mkdirSync(join(repoPath, DIR_PATH), { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, FILE_PATH), "first line\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  writeFileSync(join(repoPath, FILE_PATH), "first line\nsecond line\n");

  seedState(tmpHome, {
    projects: [
      {
        name: REPO_NAME,
        path: repoPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
  workspaceId = toWorkspaceId(REPO_NAME, BRANCH);
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Copy file path from the tree context menus", () => {
  test("Files view copies relative and absolute paths", async ({ page }) => {
    const workspace = new WorkspacePage(page, server.url, TOKEN);
    const trees = new FileTreesPage(page, workspace);

    await workspace.installClipboardCapture();
    await workspace.goto(workspaceId);
    await workspace.waitForReady();

    // The Files tree lazy-loads directory contents, so expand `src` before
    // the nested file row exists.
    await trees.openFilesTab(DIR_PATH);
    await trees.expandFileTreeFolder(DIR_PATH, FILE_PATH);

    // Copy relative path → the workspace-relative file path.
    await trees.openFileTreeMenu(FILE_PATH);
    await expect(trees.fileTreeCopyRelative).toBeVisible();
    await trees.fileTreeCopyRelative.click();
    await expect
      .poll(async () => (await workspace.readCopied()).at(-1), {
        message: "relative path copied to clipboard",
        timeout: 15_000,
      })
      .toBe(FILE_PATH);

    // Copy absolute path → worktree root joined with the relative path.
    await trees.openFileTreeMenu(FILE_PATH);
    await expect(trees.fileTreeCopyAbsolute).toBeVisible();
    await trees.fileTreeCopyAbsolute.click();
    await expect
      .poll(async () => (await workspace.readCopied()).at(-1), {
        message: "absolute path copied to clipboard",
        timeout: 15_000,
      })
      .toBe(`${repoPath}/${FILE_PATH}`);
  });

  test("Changes view copies relative and absolute paths", async ({ page }) => {
    const workspace = new WorkspacePage(page, server.url, TOKEN);
    const trees = new FileTreesPage(page, workspace);

    await workspace.installClipboardCapture();
    await workspace.goto(workspaceId);
    await workspace.waitForReady();

    await trees.openChangesTab(FILE_PATH);

    await trees.openChangesTreeMenu(FILE_PATH);
    await expect(trees.changesTreeCopyRelative).toBeVisible();
    await trees.changesTreeCopyRelative.click();
    await expect
      .poll(async () => (await workspace.readCopied()).at(-1), {
        message: "relative path copied to clipboard",
        timeout: 15_000,
      })
      .toBe(FILE_PATH);

    await trees.openChangesTreeMenu(FILE_PATH);
    await expect(trees.changesTreeCopyAbsolute).toBeVisible();
    await trees.changesTreeCopyAbsolute.click();
    await expect
      .poll(async () => (await workspace.readCopied()).at(-1), {
        message: "absolute path copied to clipboard",
        timeout: 15_000,
      })
      .toBe(`${repoPath}/${FILE_PATH}`);
  });
});
