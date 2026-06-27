/**
 * End-to-end coverage for the Files-view auto-refresh behaviour:
 *
 *   - When a file open in the viewer changes on disk and the buffer is
 *     CLEAN, the viewer reloads and shows the new bytes.
 *   - When the buffer has UNSAVED edits, an on-disk change must NOT
 *     clobber what the user is typing.
 *
 * Architecture (mirrors the rest of the e2e suite):
 *   - REAL production `dist/start-server.mjs` boots against a fresh tmp
 *     `$HOME` with an on-disk git worktree. No tRPC mocking — the file
 *     read and the `workspace.fileChanges` subscription run through the
 *     same pipelines production uses.
 *   - "External" changes are plain `writeFileSync` calls into the worktree
 *     (the exact scenario the server watcher exists for: agents,
 *     terminals, `git`, other editors), which the server's per-workspace
 *     `fs.watch` reports to the client.
 *
 * Delivery determinism for the negative ("don't clobber") test: we write
 * a *second* file (`src/marker.txt`) in the same directory as the edited
 * file. The `FileBrowser` (Files tab) and the `FileViewer` both subscribe
 * to the same coalesced `src` change event. The marker row appearing in
 * the tree proves the `src` event was delivered to the client; the viewer
 * handles the same broadcast and decides synchronously (it bails the
 * moment it sees unsaved edits — no pending async write), so once the
 * marker is visible we can assert the edited buffer survived.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "@playwright/test";
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

// Wide viewport so `useIsDesktop()` reports true and the dockview Files
// panel + viewer render the desktop layout (same reasoning as the other
// file-tree specs).
test.use({ viewport: { width: 2400, height: 900 } });

const TOKEN = "e2e-file-auto-refresh-token";
const REPO_NAME = "auto-refresh-repo";
const BRANCH = "main";
const DIR_PATH = "src";
const FILE_PATH = "src/notes.txt";
const MARKER_PATH = "src/marker.txt";
const ORIGINAL = "ALPHA-ORIGINAL";

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;
let workspaceId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(join(repoPath, DIR_PATH), { recursive: true });

  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, FILE_PATH), `${ORIGINAL}\n`);
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

// Each test gets a fresh browser context (clean localStorage, so no tab
// state / unsaved-edit leakage), but the worktree is shared — reset the
// on-disk file to its committed contents and drop the marker so the two
// tests don't observe each other's writes.
test.beforeEach(() => {
  writeFileSync(join(repoPath, FILE_PATH), `${ORIGINAL}\n`);
  rmSync(join(repoPath, MARKER_PATH), { force: true });
});

test.describe("Files view auto-refresh", () => {
  test("reloads an open file when it changes on disk and the buffer is clean", async ({ page }) => {
    const workspace = new WorkspacePage(page, server.url, TOKEN);
    const trees = new FileTreesPage(page, workspace);
    const viewer = new FileViewerPage(page);

    await workspace.goto(workspaceId);
    await workspace.waitForReady();

    await trees.openFilesTab(DIR_PATH);
    await trees.expandFileTreeFolder(DIR_PATH, FILE_PATH);
    await trees.openFile(FILE_PATH);
    await viewer.expectContent(ORIGINAL);

    // External change (a teammate's `git pull`, the agent rewriting the
    // file, another editor saving). The server watcher reports it and the
    // viewer reloads because there are no unsaved edits.
    writeFileSync(join(repoPath, FILE_PATH), "BRAVO-REFRESHED\n");

    await viewer.expectContent("BRAVO-REFRESHED");
  });

  test("does not clobber unsaved edits when the file changes on disk", async ({ page }) => {
    const workspace = new WorkspacePage(page, server.url, TOKEN);
    const trees = new FileTreesPage(page, workspace);
    const viewer = new FileViewerPage(page);

    await workspace.goto(workspaceId);
    await workspace.waitForReady();

    await trees.openFilesTab(DIR_PATH);
    await trees.expandFileTreeFolder(DIR_PATH, FILE_PATH);
    await trees.openFile(FILE_PATH);
    await viewer.expectContent(ORIGINAL);

    // Make the buffer dirty: replace its contents with a unique token.
    await viewer.replaceAll("CHARLIE-EDIT");

    // External change to the SAME file while the buffer is dirty, plus a
    // marker file in the same directory whose appearance in the tree
    // proves the `src` change event reached the client.
    writeFileSync(join(repoPath, FILE_PATH), "DELTA-CLOBBER\n");
    writeFileSync(join(repoPath, MARKER_PATH), "marker\n");

    await trees.waitForFileTreeRow(MARKER_PATH);

    // The change event was delivered (marker is visible), but the dirty
    // buffer must be untouched — the user's edit survives and the on-disk
    // bytes did not overwrite it.
    await viewer.expectContent("CHARLIE-EDIT");
    await viewer.expectNotContent("DELTA-CLOBBER");
  });
});
