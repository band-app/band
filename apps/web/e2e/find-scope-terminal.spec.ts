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

test("Cmd+F opens the find bar for the focused surface, not another leaf", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();

  // Open a file into a center `file` leaf. The default layout is a single
  // terminal, so the file opens as a tab in the terminal's group: file and
  // terminal are co-grouped tabs. The terminal stays mounted (hidden) while the
  // file is shown, via `renderer: "always"`, but only one of them can hold
  // focus at a time. The contract this guards is that Cmd+F is scoped to
  // whichever surface holds focus, and never cross-opens the other leaf's bar. (The retired global
  // handler ignored focus and fired for every mounted leaf — the bug fixed by
  // `use-search`'s `registerGlobalFindKey` opt-out + the terminal-focus guard in
  // `SharedDockviewLayout`.)
  await workspacePage.openFileLeaf(FILE, WORKSPACE);

  // Focus the terminal → Cmd+F opens the TERMINAL's own find bar, and never the
  // file/preview bar. `handleOpenSearch` renders a frame later, so poll for the
  // wrong (file) bar's ARRIVAL within a bounded window and assert it never came,
  // rather than a bare t=0 `toHaveCount(0)` that could pass trivially.
  await workspacePage.focusTerminal();
  await workspacePage.pressFindShortcut();
  await expect(workspacePage.findInTerminalBar).toHaveCount(1);
  await expect(workspacePage.findInTerminalBar).toBeFocused();
  let leakedToFile = false;
  try {
    await expect
      .poll(async () => workspacePage.findInFileOrPreviewBar.count(), { timeout: 1500 })
      .toBeGreaterThan(0);
    leakedToFile = true;
  } catch {
    // Poll exhausted its budget without the file bar appearing — the contract.
  }
  expect(leakedToFile).toBe(false);

  // Close the terminal's bar (Escape, the focused bar's own dismiss) so the
  // final `toHaveCount(0)` below proves the FILE's Cmd+F didn't open it.
  // Terminal leaves use `renderer: "always"`, so a bar left open here would stay
  // in the DOM (hidden) after switching tabs and make that assertion meaningless.
  await workspacePage.pressEscape();
  await expect(workspacePage.findInTerminalBar).toHaveCount(0);

  // Symmetric positive control: activate + focus the file editor → Cmd+F opens
  // its find bar (not the terminal's), proving the scoping holds both ways and
  // the negative above is a real guard rather than a dead keybind.
  await workspacePage.focusFileEditor(FILE);
  await workspacePage.pressFindShortcut();
  await expect(workspacePage.findInFileOrPreviewBar).toHaveCount(1);
  await expect(workspacePage.findInFileOrPreviewBar).toBeFocused();
  await expect(workspacePage.findInTerminalBar).toHaveCount(0);
});
