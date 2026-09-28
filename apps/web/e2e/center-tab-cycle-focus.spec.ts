/**
 * Ctrl+Tab / Ctrl+Shift+Tab cycle the center tabs, and after every press the
 * new tab's own input holds keyboard focus: the terminal's xterm textarea (the
 * active pane's, in a split), the file's CodeMirror editor, the markdown
 * preview, the diff's scroller, the chat composer. Focus used to stay behind
 * on a hidden tab or fall to <body>, and the next Ctrl+Tab did nothing.
 *
 * Browser tabs are not covered: they are `<webview>` guests only the desktop
 * build renders, and this harness boots the web build in plain Chromium (same
 * gap as `keyboard-shortcuts.spec.ts`).
 *
 * Boots the real production server against a fresh tmp home, with the ACP stub
 * agent behind the chat, and drives a real Chromium through page objects.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { acpStubEnv } from "./helpers/acp-stub";
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
import { CenterTabFocus, type FocusedSurface } from "./pages/CenterTabFocus";
import { FileViewerPage } from "./pages/FileViewerPage";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-center-tab-cycle-focus-token";
const BRANCH = "main";
// One project per test: the server keeps terminals and chats alive across the
// tests in a file.
const PROJECT_ALL = "tab-cycle-all-kinds";
const PROJECT_SPLIT = "tab-cycle-split";
const PROJECT_CLICK = "tab-cycle-click";
const PROJECT_SWITCH = "tab-cycle-switch";
const WORKSPACE_ALL = toWorkspaceId(PROJECT_ALL, BRANCH);
const WORKSPACE_SPLIT = toWorkspaceId(PROJECT_SPLIT, BRANCH);
const WORKSPACE_CLICK = toWorkspaceId(PROJECT_CLICK, BRANCH);
const WORKSPACE_SWITCH = toWorkspaceId(PROJECT_SWITCH, BRANCH);

const CODE_FILE = "code.ts";
const MARKDOWN_FILE = "notes.md";
const CHANGED_FILE = "changed.txt";

// Wide viewport so `useIsDesktop()` reports true and the center dockview renders.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const makeRepo = (name: string) => {
    const repoPath = join(tmpHome, name);
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, ["init", "-b", BRANCH]);
    writeFileSync(join(repoPath, CODE_FILE), "export const answer = 42;\n");
    // Frontmatter at the top, where a fresh preview's cursor sits.
    writeFileSync(
      join(repoPath, MARKDOWN_FILE),
      "---\nowner: band\n---\n\n# Notes\n\nSome notes.\n",
    );
    writeFileSync(join(repoPath, CHANGED_FILE), "committed\n");
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-m", "initial"]);
    // An uncommitted edit, so the file has a diff to open.
    writeFileSync(join(repoPath, CHANGED_FILE), "edited\n");
    return {
      name,
      path: repoPath,
      defaultBranch: BRANCH,
      worktrees: [{ branch: BRANCH, path: repoPath }],
    };
  };
  seedState(tmpHome, {
    projects: [PROJECT_ALL, PROJECT_SPLIT, PROJECT_CLICK, PROJECT_SWITCH].map(makeRepo),
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    useWebGLTerminalRenderer: false,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  server = await startServer({ tmpHome, env: acpStubEnv(tmpHome) });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("Ctrl+Tab and Ctrl+Shift+Tab focus every kind of tab and can leave each one", async ({
  page,
}) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const focus = new CenterTabFocus(page);
  const viewer = new FileViewerPage(page, workspacePage.fileLeafVisibilityMarker(true));
  await workspacePage.goto(WORKSPACE_ALL);
  await workspacePage.waitForReady();

  // The default layout is one terminal. Each tab opened below lands after the
  // active one, so the strip reads in the order they're opened.
  await workspacePage.openChat(WORKSPACE_ALL);
  await workspacePage.openFileViaQuickOpen(CODE_FILE);
  await workspacePage.openFileViaQuickOpen(MARKDOWN_FILE);
  await workspacePage.openFileViaQuickOpen(CHANGED_FILE);
  await workspacePage.openChangesOfActiveFile(CHANGED_FILE);

  const cycle: { tab: Locator; surface: FocusedSurface }[] = [
    { tab: workspacePage.tabContainer("terminal"), surface: "terminal" },
    { tab: workspacePage.tabContainer("chat"), surface: "chat-composer" },
    { tab: workspacePage.fileTabContainer(CODE_FILE), surface: "editor" },
    {
      tab: workspacePage.fileTabContainer(MARKDOWN_FILE),
      surface: "markdown-preview",
    },
    { tab: workspacePage.fileTabContainer(CHANGED_FILE), surface: "editor" },
    { tab: workspacePage.diffTabContainer(CHANGED_FILE), surface: "diff" },
  ];
  const expectShown = async (index: number) => {
    const { tab, surface } = cycle[index];
    await expect(tab).toHaveClass(/\bdv-active-tab\b/);
    await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe(surface);
    // Focus from a tab switch doesn't put the cursor into the frontmatter:
    // it stays rendered instead of showing its source.
    if (surface === "markdown-preview") {
      await expect(viewer.previewRenderedBlock("frontmatter")).toContainText("owner");
    }
  };

  // Opening the diff made it the active tab, and focused it.
  await expectShown(5);

  // Forward twice around, so every tab is entered and left with Ctrl+Tab
  // (the diff wraps to the terminal).
  for (let step = 1; step <= cycle.length * 2; step++) {
    await focus.pressNextTab();
    await expectShown((5 + step) % cycle.length);
  }

  // Backward once around.
  for (let step = 1; step <= cycle.length; step++) {
    await focus.pressPreviousTab();
    await expectShown((5 + cycle.length - step) % cycle.length);
  }

  // Focus on <body> doesn't strand Ctrl+Tab.
  await focus.dropFocusToBody();
  await focus.pressNextTab();
  await expectShown(0);
});

test("clicking a tab focuses its content", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const focus = new CenterTabFocus(page);
  await workspacePage.goto(WORKSPACE_CLICK);
  await workspacePage.waitForReady();
  await workspacePage.openChat(WORKSPACE_CLICK);
  await workspacePage.openFileViaQuickOpen(CODE_FILE);

  await workspacePage.tab("chat").click();
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("chat-composer");

  await workspacePage.fileTab(CODE_FILE).click();
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("editor");

  await workspacePage.tab("terminal").click();
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("terminal");
});

test("a split terminal gets focus back in the pane that had it", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const focus = new CenterTabFocus(page);
  await workspacePage.goto(WORKSPACE_SPLIT);
  await workspacePage.waitForReady();

  await workspacePage.focusTerminal();
  await workspacePage.splitTerminalRight();
  await expect(workspacePage.terminalPanes()).toHaveCount(2);
  // The new pane focuses itself once its shell connects; let that happen
  // before moving focus back to the first pane.
  await workspacePage.waitForPanePrompt(1);
  await workspacePage.focusPane(0);
  await expect.poll(() => workspacePage.focusedPaneIndex()).toBe(0);

  await workspacePage.openFileViaQuickOpen(CODE_FILE);
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("editor");

  await focus.pressPreviousTab();
  await expect(workspacePage.tabContainer("terminal")).toHaveClass(/\bdv-active-tab\b/);
  await expect.poll(() => workspacePage.focusedPaneIndex(), { timeout: 10_000 }).toBe(0);

  await focus.pressNextTab();
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("editor");
});

test("switching workspace focuses the active tab of the one shown", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const focus = new CenterTabFocus(page);
  await workspacePage.goto(WORKSPACE_SWITCH);
  await workspacePage.waitForReady();
  await workspacePage.openFileViaQuickOpen(CODE_FILE);
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("editor");

  await workspacePage.switchWorkspace(WORKSPACE_SPLIT);
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("terminal");

  await workspacePage.switchWorkspace(WORKSPACE_SWITCH);
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("editor");
  await focus.pressPreviousTab();
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("terminal");
});
