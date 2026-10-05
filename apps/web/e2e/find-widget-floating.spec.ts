/**
 * The in-pane find widget floats over the top-right corner of its pane, like
 * VS Code's find widget, in every pane that has one: the file editor, the
 * per-file diff and the terminal. It is laid over the content, so opening it
 * must not push the content down, and it keeps the Cmd/Ctrl+F, Enter,
 * Shift+Enter and Escape behaviour.
 *
 * The browser pane's find-in-page is not covered here: it needs an Electron
 * `<webview>`, which the plain-Chromium web build that e2e boots does not
 * have.
 *
 * Boots the real production server against a fresh tmp home and a real git
 * worktree, and drives a real Chromium through page objects. No tRPC mocking,
 * no `page.route()` on own routes.
 */

import { mkdirSync, writeFileSync } from "node:fs";
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
import { ChangesPanelPage } from "./pages/ChangesPanelPage";
import { topOf, type WidgetPlacement } from "./pages/FindWidget";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-find-widget-floating-token";
const REPO = "find-widget-repo";
const BRANCH = "main";
const FILE = "app.ts";
const WORKTREE = toWorktreeId(REPO, BRANCH);

// Committed content, then an uncommitted edit so the Changes tab lists FILE.
// The working copy holds "needle" three times.
const COMMITTED = "const needle = 1;\n// needle again\n";
const WORKING = "const needle = 1;\n// needle again\n// needle three\n";

// Wide viewport so `useIsDesktop()` reports true and the shared center
// dockview (file, diff and terminal leaves) renders.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, REPO);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, FILE), COMMITTED);
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  writeFileSync(join(repoPath, FILE), WORKING);

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
  // DOM renderer, so the terminal test can wait for echoed text in
  // `.xterm-rows` (a WebGL terminal leaves them empty).
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

// UI state lives on the server now: start each test from none, like the
// fresh localStorage each test's browser context used to give it.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

/** The widget hugs the pane's top-right corner and stays in its right half
 *  (the old full-width strip started at the pane's left edge). */
function expectTopRight(placement: WidgetPlacement): void {
  expect(placement.fromTop).toBeGreaterThanOrEqual(0);
  expect(placement.fromTop).toBeLessThan(16);
  expect(placement.fromRight).toBeGreaterThanOrEqual(0);
  expect(placement.fromRight).toBeLessThan(32);
  expect(placement.leftOfMidpoint).toBeGreaterThan(0);
}

test("file editor: the find widget floats top-right and steps through matches", async ({
  page,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await worktreePage.openFileLeaf(FILE, WORKTREE);
  await worktreePage.focusFileEditor(FILE);

  // A fixture line, not the editor's textbox: once the widget opens, its own
  // input is the leaf's first textbox.
  const firstLine = worktreePage.fileLeafLine("const needle = 1;");
  const lineTopBefore = await topOf(firstLine);

  await worktreePage.pressFindShortcut();
  const find = worktreePage.fileLeafFindWidget();
  await expect(find.input).toBeFocused();
  expectTopRight(await find.placement());
  // Laid over the editor, not stacked above it.
  expect(await topOf(firstLine)).toBe(lineTopBefore);

  await expect(find.matchCaseToggle).toBeVisible();
  await expect(find.wholeWordToggle).toBeVisible();
  await expect(find.regexToggle).toBeVisible();
  await expect(find.count).toHaveText("0/0");

  await find.type("needle");
  await expect(find.count).toHaveText("1/3");
  await find.press("Enter");
  await expect(find.count).toHaveText("2/3");
  await find.press("Shift+Enter");
  await expect(find.count).toHaveText("1/3");

  // Regex toggle changes the search: `needle (again|three)` matches two lines.
  await find.type("needle (again|three)");
  await find.expectNoResults();
  await find.regexToggle.click();
  await expect(find.count).toHaveText("1/2");

  await find.press("Escape");
  await expect(find.root).toHaveCount(0);
});

test("diff: the find widget floats top-right over the diff", async ({ page }) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await changes.goto(WORKTREE);
  await changes.openDiff(FILE, "unified");
  // Cmd+F is scoped to the focused leaf, so click into the diff first.
  await changes.diffLine("// needle three").click();

  const scrollerTopBefore = await topOf(changes.diffScroller);

  await worktreePage.pressFindShortcut();
  const find = changes.diffFindWidget;
  await expect(find.input).toBeFocused();
  expectTopRight(await find.placement());
  expect(await topOf(changes.diffScroller)).toBe(scrollerTopBefore);

  await find.type("needle three");
  await expect(find.count).toHaveText("1/1");
  await find.press("Escape");
  await expect(find.root).toHaveCount(0);
});

test("terminal: the find widget floats top-right over the terminal", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await worktreePage.focusTerminal();
  await worktreePage.waitForTerminalRenderedPrompt(WORKTREE);
  // Two output lines to find. The quotes keep the typed command itself from
  // matching, so only the executed output does.
  await worktreePage.runInTerminalUntilRendered(
    WORKTREE,
    'echo ZQX_"FOUND"; echo ZQX_"FOUND"',
    /ZQX_FOUND[\s\S]*ZQX_FOUND/,
  );

  const screen = worktreePage.terminalScreen();
  const screenTopBefore = await topOf(screen);

  await worktreePage.pressFindShortcut();
  const find = worktreePage.terminalPaneFindWidget();
  await expect(find.input).toBeFocused();
  expectTopRight(await find.placement());
  expect(await topOf(screen)).toBe(screenTopBefore);

  await expect(find.matchCaseToggle).toBeVisible();
  await expect(find.regexToggle).toBeVisible();
  await expect(find.count).toHaveText("0/0");

  await find.type("ZQX_FOUND");
  await expect(find.count).toHaveText("1/2");
  await find.press("Enter");
  await expect(find.count).toHaveText("2/2");
  await find.press("Shift+Enter");
  await expect(find.count).toHaveText("1/2");

  await find.press("Escape");
  await expect(find.root).toHaveCount(0);
});
