/**
 * Regression coverage: Cmd+F while a terminal is focused must NOT open the
 * find bar in other, non-active center leaves (the file editor / changes
 * diff view).
 *
 * Root cause: `useSearch` registered its OWN window-level, unscoped Cmd/Ctrl+F
 * handler that opened the bar on ANY find keypress, regardless of focus or
 * visibility. In the unified center dockview several leaves are mounted at once
 * (dockview keeps inactive tabs alive), and with split groups several are even
 * visible — so a single Cmd+F pressed from a focused terminal opened every
 * mounted file/diff leaf's bar. `useLeafFind`'s focus-scoped handler only
 * stopped the event when focus was inside its own container, so a keypress
 * originating in the terminal sailed straight through to every leaf's global
 * handler.
 *
 * Fix: `useSearch` gained `registerGlobalFindKey` (default `true` for
 * standalone consumers like mobile `CodeBrowserView` / `DiffView`), and
 * `useLeafFind` passes `false` — its focus-in-container capture handler is the
 * single opener. So a Cmd+F from the terminal opens no editor/preview bar.
 *
 * Architecture (repo integration doctrine): boots the real production server
 * against a fresh tmp home + a real git worktree, drives a real Chromium via a
 * `WorkspacePage` page object (no tRPC mocking, no `page.route()` on own
 * routes, no direct `page.getByTestId` in the test body).
 *
 * The file editor is the surface asserted here; the changes/diff leaf shares
 * the exact same `useLeafFind` → `useSearch` code path, so covering one proves
 * the class of bug.
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

const TOKEN = "e2e-find-scope-terminal-token";
const PROJECT = "find-scope-repo";
const BRANCH = "main";
const FILE = "app.ts";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);

// Wide viewport so `useIsDesktop()` reports true and the shared center dockview
// (with its per-leaf find + terminal) renders — matches >= 1024px.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });

  // A real worktree with a committed file — `workspace.getFile` reads the file
  // off disk when the `file` leaf opens.
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, FILE), "const needle = 1;\n// needle again\n");
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

test("Cmd+F in the terminal does not open the find bar in an unfocused file leaf", async ({
  page,
}) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();

  // Open a file into a center `file` leaf, then focus the terminal. The default
  // layout is a split — chat/file on the left group, terminal on the right — so
  // the file leaf's find-capable editor stays MOUNTED and VISIBLE while the
  // terminal is the focused surface. That "visible but not focused" file leaf is
  // exactly what the buggy global handler opened.
  await workspacePage.openFileLeaf(FILE, WORKSPACE);
  await workspacePage.focusTerminal();
  await expect(workspacePage.fileLeafVisibilityMarker(true)).toHaveCount(1);

  // Contract: Cmd+F from the focused terminal must not open the file's find
  // bar. `handleOpenSearch` renders the bar a frame later, so a bare
  // `toHaveCount(0)` could pass trivially at t=0 (before a buggy bar mounts) —
  // poll for its ARRIVAL within a bounded window and assert it never came.
  await workspacePage.pressFindShortcut();
  let leaked = false;
  try {
    await expect
      .poll(async () => workspacePage.findInFileOrPreviewBar.count(), { timeout: 1500 })
      .toBeGreaterThan(0);
    leaked = true;
  } catch {
    // Poll exhausted its budget without the bar appearing — the contract.
  }
  expect(leaked).toBe(false);

  // Positive control: focusing the editor and pressing Cmd+F DOES open its find
  // bar — proving the leaf's find is live, so the negative above is meaningful
  // rather than a dead keybind.
  await workspacePage.focusFileEditor(FILE);
  await workspacePage.pressFindShortcut();
  await expect(workspacePage.findInFileOrPreviewBar).toHaveCount(1);
  await expect(workspacePage.findInFileOrPreviewBar).toBeFocused();
});
