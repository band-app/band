/**
 * The in-pane find widget floats over the top-right corner of its pane, like
 * VS Code's find widget, in every pane that has one: the file editor, the
 * per-file diff and the terminal. It is laid over the content, so opening it
 * must not push the content down, and it keeps the Cmd/Ctrl+F, Enter,
 * Shift+Enter and Escape behaviour.
 *
 * The browser pane's find-in-page is not covered here: it needs the Electron
 * WebContentsView, which the web build that e2e boots does not create.
 *
 * Architecture (repo integration doctrine): boots the real production server
 * against a fresh tmp home and a real git worktree, and drives a real Chromium
 * through page objects. No tRPC mocking, no `page.route()` on own routes.
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
import { ChangesPanelPage } from "./pages/ChangesPanelPage";
import { FindWidget, topOf, type WidgetPlacement } from "./pages/FindWidget";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-find-widget-floating-token";
const PROJECT = "find-widget-repo";
const BRANCH = "main";
const FILE = "app.ts";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);

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
  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, FILE), COMMITTED);
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  writeFileSync(join(repoPath, FILE), WORKING);

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
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();
  await workspacePage.openFileLeaf(FILE, WORKSPACE);
  await workspacePage.focusFileEditor(FILE);

  const leaf = workspacePage.fileLeafVisibilityMarker(true).first();
  // A fixture line, not the editor's textbox: once the widget opens, its own
  // input is the leaf's first textbox.
  const firstLine = workspacePage.fileLeafLine("const needle = 1;");
  const lineTopBefore = await topOf(firstLine);

  await workspacePage.pressFindShortcut();
  const find = new FindWidget(leaf);
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
  await expect(find.count).toHaveText("No results");
  await find.regexToggle.click();
  await expect(find.count).toHaveText("1/2");

  await find.press("Escape");
  await expect(find.root).toHaveCount(0);
});

test("diff: the find widget floats top-right over the diff", async ({ page }) => {
  const changes = new ChangesPanelPage(page, server.url, TOKEN);
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await changes.goto(WORKSPACE);
  await changes.openDiff(FILE, "unified");
  // Cmd+F is scoped to the focused leaf, so click into the diff first.
  await changes.diffLine("// needle three").click();

  const scrollerTopBefore = await topOf(changes.diffScroller);

  await workspacePage.pressFindShortcut();
  const find = new FindWidget(changes.diffLeaf);
  await expect(find.input).toBeFocused();
  expectTopRight(await find.placement());
  expect(await topOf(changes.diffScroller)).toBe(scrollerTopBefore);

  await find.type("needle three");
  await expect(find.count).toHaveText("1/1");
  await find.press("Escape");
  await expect(find.root).toHaveCount(0);
});

test("terminal: the find widget floats top-right over the terminal", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();
  await workspacePage.focusTerminal();

  const pane = workspacePage.terminalPanes().first();
  const screen = workspacePage.terminalScreen();
  const screenTopBefore = await topOf(screen);

  await workspacePage.pressFindShortcut();
  const find = new FindWidget(pane);
  await expect(find.input).toBeFocused();
  expectTopRight(await find.placement());
  expect(await topOf(screen)).toBe(screenTopBefore);

  await expect(find.matchCaseToggle).toBeVisible();
  await expect(find.regexToggle).toBeVisible();
  await expect(find.count).toHaveText("0/0");

  await find.press("Escape");
  await expect(find.root).toHaveCount(0);
});
