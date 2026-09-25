/**
 * Regression coverage: the center `file` leaf restores the editor's cursor /
 * selection / scroll position across a reload (issue #643 follow-up).
 *
 * Before this fix the flattened file leaf persisted only edited content, the
 * markdown code/preview choice, and the language override — NOT the CodeMirror
 * `editorState` (cursor/selection/undo history) or `scrollTop`, which the
 * pre-#643 `CodeBrowserView` did restore. So reopening a file or reloading
 * dumped the user back at the top of the document.
 *
 * The fix wires the file leaf to `FileViewer`'s `savedSelection` /
 * `savedScrollTop` (restore) + `onEditorView` (capture): the cursor selection
 * and scroll offset are captured on unmount / pagehide into the per-tab store
 * (`band-tab-state:<ws>`) and re-applied on the next view creation.
 *
 * Only positions are persisted, never the document. An earlier version stored
 * the full CodeMirror `EditorState` (text + undo history) and rebuilt the
 * editor from it, so a file changed on disk in the meantime reopened showing
 * the stale copy, and a save wrote that copy back over the newer file. The
 * second test pins that.
 *
 * Architecture (repo integration doctrine): real production server, real git
 * worktree, real Chromium via `WorkspacePage`. No tRPC mocking, no route
 * interception, no `page.getByTestId` in the test body.
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
import { FileViewerPage } from "./pages/FileViewerPage";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-editor-state-restore-token";
const PROJECT = "editor-state-repo";
const BRANCH = "main";
// A long file so there is real vertical scroll to lose/restore.
const FILE = "long.ts";
// A one-line file whose whole document CodeMirror renders at once, so the
// stale-snapshot test can assert on its full text.
const SHORT_FILE = "version.ts";
const SHORT_BEFORE = "export const version = 1;";
// Shorter than SHORT_BEFORE on purpose: the cursor saved at the old end of the
// file is then past the new end, so reopening exercises the selection clamp
// (an unclamped out-of-range selection throws when dispatched).
const SHORT_AFTER = "export const v = 2;";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  const lines = Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join("\n");
  writeFileSync(join(repoPath, FILE), `${lines}\n`);
  writeFileSync(join(repoPath, SHORT_FILE), `${SHORT_BEFORE}\n`);
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);

  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repoPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("the file leaf restores cursor + scroll position across a reload", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();

  // Open the long file. The default layout is a single terminal, so the file
  // opens as a tab in the terminal's group. Close the terminal so the file is
  // the sole leaf — otherwise on reload the terminal's nested-pane restore
  // races to grab active and can hide the file behind its tab, which is
  // orthogonal to the cursor/scroll-restore behaviour under test here.
  await workspacePage.openFileLeaf(FILE, WORKSPACE);
  await workspacePage.closeTerminalTab(WORKSPACE);
  await expect(workspacePage.fileLeafVisibilityMarker(true).first()).toBeVisible({
    timeout: 20_000,
  });

  // Move the cursor to the end — the editor scrolls to the bottom (scrollTop > 0).
  await workspacePage.focusFileEditor(FILE);
  await workspacePage.pressEditorToDocEnd();
  await expect.poll(() => workspacePage.editorScrollTop(), { timeout: 10_000 }).toBeGreaterThan(0);

  // Reload — `pagehide` captures the editor state into the per-tab store.
  await page.reload();
  await workspacePage.waitForReady();

  // The file leaf restores from the persisted layout AND its editor lands back
  // near the bottom, not scrolled to the top (which is what the pre-fix leaf
  // did — scrollTop 0).
  await expect(workspacePage.fileLeafVisibilityMarker(true).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect.poll(() => workspacePage.editorScrollTop(), { timeout: 20_000 }).toBeGreaterThan(0);
});

test("a reopened file leaf shows the file's current on-disk content, not a stale snapshot", async ({
  page,
}) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();

  // Same setup as above: make the file the sole leaf so the reload restores
  // it as the visible tab.
  await workspacePage.openFileLeaf(SHORT_FILE, WORKSPACE);
  await workspacePage.closeTerminalTab(WORKSPACE);
  const leaf = workspacePage.fileLeafVisibilityMarker(true).first();
  await expect(leaf).toBeVisible({ timeout: 20_000 });
  const viewer = new FileViewerPage(page, leaf);
  await viewer.expectContent(SHORT_BEFORE);

  // Put the cursor somewhere so the leaf has a position worth persisting.
  await workspacePage.focusFileEditor(SHORT_FILE);
  await workspacePage.pressEditorToDocEnd();

  // Leave the app FIRST (pagehide captures the leaf's state while it still
  // holds version 1), and only then change the file on disk — e.g. an agent
  // editing it in the background. Changing it while the page is open could let
  // a live editor pick the new text up before the capture, which would hide
  // the bug.
  await workspacePage.navigateAway();
  writeFileSync(join(repoPath, SHORT_FILE), `${SHORT_AFTER}\n`);

  // Come back. The leaf must be built from the file as it is now. The pre-fix
  // leaf persisted the whole document and rebuilt the editor from that copy,
  // so it showed version 1 here, and a save would have written it back over
  // the newer file.
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();
  await expect(leaf).toBeVisible({ timeout: 20_000 });
  await viewer.expectContent(SHORT_AFTER);
  await viewer.expectNotContent(SHORT_BEFORE);
});

test("legacy full-document editor state is stripped from stored tab state on load", async ({
  page,
}) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();

  // An entry as an earlier build left it: the whole document (and undo history)
  // under `editorState`. It belongs to a workspace this session never opens,
  // the case an on-read cleanup alone would never reach.
  const OTHER_WORKSPACE = "never-opened-workspace";
  await workspacePage.writeTabStateEntry(OTHER_WORKSPACE, "secret.env", {
    editorState: { doc: "API_KEY=do-not-keep-me", selection: { ranges: [], main: 0 } },
    scrollTop: 42,
  });

  await workspacePage.reload();
  await workspacePage.waitForReady();

  // The document copy is gone and the rest of the entry survives, so the blob
  // was rewritten, not dropped.
  await expect
    .poll(() => workspacePage.readTabStateEntry(OTHER_WORKSPACE, "secret.env"), {
      timeout: 10_000,
    })
    .toEqual({ scrollTop: 42 });
});
