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
import { toWorktreeId } from "@/dashboard";
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
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-center-tab-cycle-focus-token";
const BRANCH = "main";
// One repo per test: the server keeps terminals and chats alive across the
// tests in a file.
const REPO_ALL = "tab-cycle-all-kinds";
const REPO_SPLIT = "tab-cycle-split";
const REPO_CLICK = "tab-cycle-click";
const REPO_SWITCH = "tab-cycle-switch";
const REPO_SWITCH_TARGET = "tab-cycle-switch-target";
const REPO_GROUPS = "tab-cycle-groups";
const WORKTREE_ALL = toWorktreeId(REPO_ALL, BRANCH, "local");
const WORKTREE_SPLIT = toWorktreeId(REPO_SPLIT, BRANCH, "local");
const WORKTREE_CLICK = toWorktreeId(REPO_CLICK, BRANCH, "local");
const WORKTREE_SWITCH = toWorktreeId(REPO_SWITCH, BRANCH, "local");
const WORKTREE_SWITCH_TARGET = toWorktreeId(REPO_SWITCH_TARGET, BRANCH, "local");
const WORKTREE_GROUPS = toWorktreeId(REPO_GROUPS, BRANCH, "local");

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
    repos: [REPO_ALL, REPO_SPLIT, REPO_CLICK, REPO_SWITCH, REPO_SWITCH_TARGET, REPO_GROUPS].map(
      makeRepo,
    ),
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
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const focus = new CenterTabFocus(page);
  const viewer = new FileViewerPage(page, worktreePage.fileLeafVisibilityMarker(true));
  await worktreePage.goto(WORKTREE_ALL);
  await worktreePage.waitForReady();

  // The default layout is one terminal. Each tab opened below lands after the
  // active one, so the strip reads in the order they're opened.
  await worktreePage.openChat(WORKTREE_ALL);
  await worktreePage.openFileViaQuickOpen(CODE_FILE);
  await worktreePage.openFileViaQuickOpen(MARKDOWN_FILE);
  await worktreePage.openFileViaQuickOpen(CHANGED_FILE);
  await worktreePage.openChangesOfActiveFile(CHANGED_FILE);

  const cycle: { tab: Locator; surface: FocusedSurface }[] = [
    { tab: worktreePage.tabContainer("terminal"), surface: "terminal" },
    { tab: worktreePage.tabContainer("chat"), surface: "chat-composer" },
    { tab: worktreePage.fileTabContainer(CODE_FILE), surface: "editor" },
    {
      tab: worktreePage.fileTabContainer(MARKDOWN_FILE),
      surface: "markdown-preview",
    },
    { tab: worktreePage.fileTabContainer(CHANGED_FILE), surface: "editor" },
    { tab: worktreePage.diffTabContainer(CHANGED_FILE), surface: "diff" },
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
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const focus = new CenterTabFocus(page);
  await worktreePage.goto(WORKTREE_CLICK);
  await worktreePage.waitForReady();
  await worktreePage.openChat(WORKTREE_CLICK);
  await worktreePage.openFileViaQuickOpen(CODE_FILE);

  await worktreePage.tab("chat").click();
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("chat-composer");

  await worktreePage.fileTab(CODE_FILE).click();
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("editor");

  await worktreePage.tab("terminal").click();
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("terminal");
});

test("a split terminal gets focus back in the pane that had it", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const focus = new CenterTabFocus(page);
  await worktreePage.goto(WORKTREE_SPLIT);
  await worktreePage.waitForReady();

  await worktreePage.focusTerminal();
  await worktreePage.splitTerminalRight();
  await expect(worktreePage.terminalPanes()).toHaveCount(2);
  // The new pane focuses itself once its shell connects; let that happen
  // before moving focus back to the first pane.
  await worktreePage.waitForPanePrompt(1);
  await worktreePage.focusPane(0);
  await expect.poll(() => worktreePage.focusedPaneIndex()).toBe(0);

  await worktreePage.openFileViaQuickOpen(CODE_FILE);
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("editor");

  await focus.pressPreviousTab();
  await expect(worktreePage.tabContainer("terminal")).toHaveClass(/\bdv-active-tab\b/);
  await expect.poll(() => worktreePage.focusedPaneIndex(), { timeout: 10_000 }).toBe(0);

  // The same with the second pane, which is also the split's active pane and
  // not the first xterm in the leaf.
  await focus.pressNextTab();
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("editor");
  await focus.pressPreviousTab();
  await expect.poll(() => worktreePage.focusedPaneIndex(), { timeout: 10_000 }).toBe(0);
  await worktreePage.focusPane(1);
  await expect.poll(() => worktreePage.focusedPaneIndex()).toBe(1);
  await focus.pressNextTab();
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("editor");
  await focus.pressPreviousTab();
  await expect.poll(() => worktreePage.focusedPaneIndex(), { timeout: 10_000 }).toBe(1);
});

test("⌘[ moves focus into the other group's tab", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const focus = new CenterTabFocus(page);
  await worktreePage.goto(WORKTREE_GROUPS);
  await worktreePage.waitForReady();

  // Left group: the terminal (shown) and a chat. Right group: a second chat.
  await worktreePage.openChat(WORKTREE_GROUPS);
  await worktreePage.clickChatSplitRight(WORKTREE_GROUPS);
  await expect(worktreePage.chatTabs()).toHaveCount(2);
  await worktreePage.focusTerminal();
  await worktreePage.chatTabs().nth(1).click();
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("chat-composer");

  // The chat stays visible in its group, and focus must still leave it. (A
  // focused terminal keeps ⌘[ / ⌘] for its own panes.)
  await focus.pressCyclePane("previous");
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("terminal");
});

test("switching worktree focuses the active tab of the one shown", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const focus = new CenterTabFocus(page);
  await worktreePage.goto(WORKTREE_SWITCH);
  await worktreePage.waitForReady();
  await worktreePage.openFileViaQuickOpen(CODE_FILE);
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("editor");

  await worktreePage.switchWorktree(WORKTREE_SWITCH_TARGET);
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("terminal");

  await worktreePage.switchWorktree(WORKTREE_SWITCH);
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("editor");
  await focus.pressPreviousTab();
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("terminal");
});
