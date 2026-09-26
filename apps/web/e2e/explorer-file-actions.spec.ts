/**
 * End-to-end coverage for the Explorer file operations in the right
 * sidepanel (`FileBrowser` + the `ExplorerHeader` toolbar in
 * `RightSidepanel.tsx`):
 *
 *   - Header toolbar: New File, New Folder, Refresh, Collapse all.
 *   - Drag and drop: move into a folder, Alt-drag to copy, drop on the root,
 *     and the error banner for a name clash.
 *   - Context menu: Cut / Copy / Paste (pasting onto a file lands beside it).
 *   - Rename (menu and F2) and Delete keep the open editor tabs in step.
 *
 * Architecture (mirrors the rest of the e2e suite): the REAL production
 * server boots against a fresh tmp `$HOME` whose project is an on-disk git
 * worktree. Every operation goes through the real tRPC file procedures, and
 * the assertions read the resulting filesystem directly, plus the rendered
 * tree rows and file tabs. Each test works in its own top-level folder so the
 * tests don't depend on each other's order.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
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
import { FileViewerPage } from "./pages/FileViewerPage";
import { WorkspacePage } from "./pages/WorkspacePage";

test.use({ viewport: { width: 1600, height: 900 } });

const TOKEN = "e2e-explorer-file-actions-token";
const REPO_NAME = "explorer-actions-repo";
const BRANCH = "main";

const SEED_FILES = [
  "header/nested/deep.txt",
  // The worktree watcher ignores `dist`, so only Refresh picks up changes here.
  "header/dist/old.js",
  "dnd/src.txt",
  "dnd/copyme.txt",
  "dnd/dup.txt",
  "dnd/target/keep.txt",
  "dnd/clash/dup.txt",
  "clip/a.txt",
  "clip/dest/keep.txt",
  "ren/old.txt",
  "dirty/keep-open.txt",
];

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;
let workspaceId: string;

const onDisk = (rel: string) => existsSync(join(repoPath, rel));
const isDirOnDisk = (rel: string) => onDisk(rel) && statSync(join(repoPath, rel)).isDirectory();

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  for (const rel of SEED_FILES) {
    mkdirSync(dirname(join(repoPath, rel)), { recursive: true });
    writeFileSync(join(repoPath, rel), `${rel}\n`);
  }
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);

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

async function openExplorer(page: Page, firstRow: string) {
  const workspace = new WorkspacePage(page, server.url, TOKEN);
  const trees = new FileTreesPage(page, workspace);
  await workspace.goto(workspaceId);
  await workspace.waitForReady();
  await trees.openFilesTab(firstRow);
  return { workspace, trees };
}

test.describe("Explorer file actions", () => {
  test("header toolbar creates files and folders, refreshes, and collapses all", async ({
    page,
  }) => {
    const { workspace, trees } = await openExplorer(page, "header");

    // New File with nothing selected lands at the root and opens the file.
    await trees.clickHeaderButton("new-file");
    await trees.submitName("from-toolbar.txt");
    await expect.poll(() => onDisk("from-toolbar.txt")).toBe(true);
    await expect(trees.fileTreeRow("from-toolbar.txt")).toBeVisible();
    await expect(workspace.fileTab("from-toolbar.txt")).toBeVisible();

    // New Folder with a folder selected lands inside that folder.
    await trees.expandFileTreeFolder("header", "header/nested");
    await trees.clickHeaderButton("new-folder");
    await trees.submitName("made");
    await expect.poll(() => isDirOnDisk("header/made")).toBe(true);
    await expect(trees.fileTreeRow("header/made")).toBeVisible();

    // Refresh re-reads the loaded folders from disk. The watcher skips
    // `dist`, so without Refresh the new file would never show up.
    await trees.expandFileTreeFolder("header/dist", "header/dist/old.js");
    writeFileSync(join(repoPath, "header", "dist", "new.js"), "new\n");
    await trees.clickHeaderButton("refresh");
    await expect(trees.fileTreeRow("header/dist/new.js")).toBeVisible();

    // Collapse all folds every open folder back to the root listing.
    await trees.expandFileTreeFolder("header/nested", "header/nested/deep.txt");
    await trees.clickHeaderButton("collapse-all");
    await expect(trees.fileTreeRow("header")).toBeVisible();
    await expect(trees.fileTreeRow("header/nested")).toHaveCount(0);
  });

  test("drag and drop moves, Alt-drag copies, and a clash shows an error", async ({ page }) => {
    const { trees } = await openExplorer(page, "dnd");
    await trees.expandFileTreeFolder("dnd", "dnd/src.txt");

    // Drop onto a folder moves the file inside it (and expands the folder).
    await trees.dragRowOnto("dnd/src.txt", "dnd/target");
    await expect.poll(() => onDisk("dnd/target/src.txt")).toBe(true);
    expect(onDisk("dnd/src.txt")).toBe(false);
    await expect(trees.fileTreeRow("dnd/target/src.txt")).toBeVisible();

    // Holding Alt copies instead of moving.
    await trees.dragRowOnto("dnd/copyme.txt", "dnd/target", { copy: true });
    await expect.poll(() => onDisk("dnd/target/copyme.txt")).toBe(true);
    expect(onDisk("dnd/copyme.txt")).toBe(true);

    // Dropping on the empty area below the rows moves it to the root.
    await trees.dragRowToRoot("dnd/target/src.txt");
    await expect.poll(() => onDisk("src.txt")).toBe(true);
    expect(onDisk("dnd/target/src.txt")).toBe(false);

    // Moving onto an existing name fails and leaves the source in place.
    await trees.dragRowOnto("dnd/dup.txt", "dnd/clash");
    await expect(trees.errorBanner).toBeVisible();
    expect(onDisk("dnd/dup.txt")).toBe(true);
    await expect(trees.fileTreeRow("dnd/dup.txt")).toBeVisible();
  });

  test("cut, copy and paste from the context menu", async ({ page }) => {
    const { trees } = await openExplorer(page, "clip");
    await trees.expandFileTreeFolder("clip", "clip/a.txt");

    // Cut + Paste on a folder moves the file into it.
    await trees.runRowAction("clip/a.txt", "cut");
    await trees.runRowAction("clip/dest", "paste");
    await expect.poll(() => onDisk("clip/dest/a.txt")).toBe(true);
    expect(onDisk("clip/a.txt")).toBe(false);
    await expect(trees.fileTreeRow("clip/dest/a.txt")).toBeVisible();

    // Copy + Paste on a file lands beside it with a "copy" suffix.
    await trees.runRowAction("clip/dest/a.txt", "copy");
    await trees.runRowAction("clip/dest/a.txt", "paste");
    await expect.poll(() => onDisk("clip/dest/a copy.txt")).toBe(true);
    expect(onDisk("clip/dest/a.txt")).toBe(true);
    await expect(trees.fileTreeRow("clip/dest/a copy.txt")).toBeVisible();

    // Escape cancels a pending cut, so Paste is no longer offered.
    await trees.runRowAction("clip/dest/a copy.txt", "cut");
    await trees.pressOnRow("clip/dest/a copy.txt", "Escape");
    await trees.openFileTreeMenu("clip/dest");
    await expect(trees.menuItem("copy")).toBeVisible();
    await expect(trees.menuItem("paste")).toHaveCount(0);
  });

  test("rename and delete keep the open editor tab in step", async ({ page }) => {
    const { workspace, trees } = await openExplorer(page, "ren");
    await trees.expandFileTreeFolder("ren", "ren/old.txt");
    await trees.openFile("ren/old.txt");
    await expect(workspace.fileTab("ren/old.txt")).toBeVisible();

    // Rename from the context menu retargets the open tab.
    await trees.runRowAction("ren/old.txt", "rename");
    await trees.submitName("new.txt");
    await expect.poll(() => onDisk("ren/new.txt")).toBe(true);
    await expect(workspace.fileTab("ren/new.txt")).toBeVisible();
    await expect(workspace.fileTab("ren/old.txt")).toHaveCount(0);

    // F2 on a selected row starts the same inline rename.
    await trees.pressOnRow("ren/new.txt", "F2");
    await trees.submitName("f2.txt");
    await expect.poll(() => onDisk("ren/f2.txt")).toBe(true);
    await expect(workspace.fileTab("ren/f2.txt")).toBeVisible();

    // Renaming the parent folder retargets tabs of files inside it.
    await trees.runRowAction("ren", "rename");
    await trees.submitName("ren2");
    await expect.poll(() => onDisk("ren2/f2.txt")).toBe(true);
    await expect(workspace.fileTab("ren2/f2.txt")).toBeVisible();
    await expect(workspace.fileTab("ren/f2.txt")).toHaveCount(0);

    // A drag-and-drop move retargets the tab too.
    await trees.dragRowToRoot("ren2/f2.txt");
    await expect.poll(() => onDisk("f2.txt")).toBe(true);
    await expect(workspace.fileTab("f2.txt")).toBeVisible();
    await expect(workspace.fileTab("ren2/f2.txt")).toHaveCount(0);

    // Deleting the file closes its tab.
    await trees.runRowAction("f2.txt", "delete");
    await trees.confirmDelete();
    await expect.poll(() => onDisk("f2.txt")).toBe(false);
    await expect(trees.fileTreeRow("f2.txt")).toHaveCount(0);
    await expect(workspace.fileTab("f2.txt")).toHaveCount(0);
  });

  test("deleting a file with unsaved edits keeps its tab open", async ({ page }) => {
    const { workspace, trees } = await openExplorer(page, "dirty");
    await trees.expandFileTreeFolder("dirty", "dirty/keep-open.txt");
    await trees.openFile("dirty/keep-open.txt");
    await new FileViewerPage(page).replaceAll("unsaved edit");

    await trees.runRowAction("dirty/keep-open.txt", "delete");
    await trees.confirmDelete();
    await expect.poll(() => onDisk("dirty/keep-open.txt")).toBe(false);
    await expect(trees.fileTreeRow("dirty/keep-open.txt")).toHaveCount(0);
    await expect(workspace.fileTab("dirty/keep-open.txt")).toBeVisible();
  });
});
