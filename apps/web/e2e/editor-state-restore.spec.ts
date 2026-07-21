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
 * The fix wires the file leaf to `FileViewer`'s existing
 * `savedEditorState`/`savedScrollTop` (restore) + `onEditorView` (capture): the
 * live view is serialized on hide / unmount / pagehide into the per-tab store
 * (`band-tab-state:<ws>`) and re-applied on the next view creation.
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
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-editor-state-restore-token";
const PROJECT = "editor-state-repo";
const BRANCH = "main";
// A long file so there is real vertical scroll to lose/restore.
const FILE = "long.ts";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  const lines = Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join("\n");
  writeFileSync(join(repoPath, FILE), `${lines}\n`);
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

  // Open the long file and move the cursor to the end — the editor scrolls to
  // the bottom (scrollTop > 0).
  await workspacePage.openFileLeaf(FILE, WORKSPACE);
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
