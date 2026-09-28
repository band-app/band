/**
 * End-to-end coverage for Band's keyboard shortcuts:
 *   - ⌘T opens a new terminal tab (it used to duplicate the active tab's kind).
 *   - ⌥⌘T (Ctrl+Shift+N off macOS) opens a new chat with the default agent.
 *   - ⌥⌘← / ⌥⌘→ (Ctrl+Alt+← / → off macOS) step workspace history. The
 *     title-bar tooltip used to advertise ⌘[ / ⌘], which only cycle panes.
 *   - ⌃⌘I (Ctrl+Alt+I off macOS) shows the chat, even from a focused terminal.
 *   - The command palette lists every bound shortcut and runs them.
 *
 * ⇧⌘B (new browser tab) is not covered: browser tabs are `<webview>` guests
 * that only the desktop build renders, and this harness boots the web build in
 * plain Chromium (same gap as `browser-guest-retention.test.ts`).
 *
 * Boots the real production server against a fresh tmp home and drives a real
 * Chromium through page objects. No tRPC mocking.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
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
import { CommandPalette } from "./pages/CommandPalette";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-keyboard-shortcuts-token";
const BRANCH = "main";

// Separate projects per test: the server keeps terminals and chats alive
// across tests in a file, which would skew the tab-count baselines.
const PROJECT = "shortcuts-new-tabs";
const PROJECT_A = "shortcuts-history-a";
const PROJECT_B = "shortcuts-history-b";
const PROJECT_CHAT = "shortcuts-show-chat";
const PROJECT_SPLIT = "shortcuts-palette-split";
const LABEL = "label-shortcuts";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);
const WORKSPACE_A = toWorkspaceId(PROJECT_A, BRANCH);
const WORKSPACE_B = toWorkspaceId(PROJECT_B, BRANCH);
const WORKSPACE_CHAT = toWorkspaceId(PROJECT_CHAT, BRANCH);
const WORKSPACE_SPLIT = toWorkspaceId(PROJECT_SPLIT, BRANCH);

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
    writeFileSync(join(repoPath, "README.md"), "# keyboard shortcuts\n");
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-m", "initial"]);
    return {
      name,
      path: repoPath,
      defaultBranch: BRANCH,
      worktrees: [{ branch: BRANCH, path: repoPath }],
    };
  };
  const projects = [PROJECT, PROJECT_A, PROJECT_B, PROJECT_CHAT, PROJECT_SPLIT].map(makeRepo);
  // Only project A carries the label, so filtering by it hides project B.
  seedState(tmpHome, {
    projects: projects.map((p) => (p.name === PROJECT_A ? { ...p, label: LABEL } : p)),
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    useWebGLTerminalRenderer: false,
    labels: [{ id: LABEL, name: "Shortcuts", color: "#8b5cf6" }],
  });
  server = await startServer({ tmpHome });
});

// UI state lives on the server now: start each test from none, like the
// fresh localStorage each test's browser context used to give it.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("the new-chat chord opens a chat tab and ⌘T a terminal tab, whatever tab is active", async ({
  page,
}) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();

  // The default layout seeds one terminal tab and no chat.
  await expect(workspacePage.terminalTabs()).toHaveCount(1);
  await expect(workspacePage.chatTabs()).toHaveCount(0);
  await workspacePage.focusTerminal();

  await workspacePage.pressNewChatShortcut();
  await expect(workspacePage.chatTabs()).toHaveCount(1);
  await expect(workspacePage.terminalTabs()).toHaveCount(1);
  await expect(workspacePage.tabContainer("chat")).toHaveClass(/\bdv-active-tab\b/);

  // The new chat is now the active tab. ⌘T used to duplicate the active tab's
  // kind and would have opened a second chat here. Clicking its tab moves focus
  // out of the terminal, which would otherwise keep Ctrl+T for the shell.
  await workspacePage.activateTab("chat");
  await workspacePage.pressNewTerminalShortcut();
  await expect(workspacePage.terminalTabs()).toHaveCount(2);
  await expect(workspacePage.chatTabs()).toHaveCount(1);
});

test("the show-chat chord activates the chat tab from a focused terminal", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WORKSPACE_CHAT);
  await workspacePage.waitForReady();
  await workspacePage.clickChatAddTab(WORKSPACE_CHAT);
  await expect(workspacePage.chatTabs()).toHaveCount(1);

  await workspacePage.focusTerminal();
  await expect(workspacePage.tabContainer("terminal")).toHaveClass(/\bdv-active-tab\b/);

  await workspacePage.pressShowChatShortcut();
  await expect(workspacePage.tabContainer("chat")).toHaveClass(/\bdv-active-tab\b/);
});

test("⌥⌘← / ⌥⌘→ step back and forward through visited workspaces", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WORKSPACE_A);
  await workspacePage.waitForReady();
  await workspacePage.switchWorkspace(WORKSPACE_B);
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(WORKSPACE_B)));

  // With a terminal focused, which owns ⌘[ / ⌘] for its panes.
  await workspacePage.focusTerminal();
  await workspacePage.pressWorkspaceHistory("back");
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(WORKSPACE_A)));

  await workspacePage.focusTerminal();
  await workspacePage.pressWorkspaceHistory("forward");
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(WORKSPACE_B)));
});

test("the command palette lists the shortcuts and runs them", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const palette = new CommandPalette(page);
  await workspacePage.goto(WORKSPACE_A);
  await workspacePage.waitForReady();
  await workspacePage.switchWorkspace(WORKSPACE_B);
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(WORKSPACE_B)));

  await palette.open();
  await expect(palette.dialog).toBeVisible();
  const mac = process.platform === "darwin";
  const expected: Record<string, string> = {
    "new-terminal": mac ? "⌘T" : "Ctrl+T",
    "new-chat": mac ? "⌘⌥T" : "Ctrl+Shift+N",
    "split-right": mac ? "⌘D" : "Ctrl+Shift+D",
    "split-down": mac ? "⌘⇧D" : "Alt+Shift+D",
    "close-tab": mac ? "⌘W" : "Ctrl+W",
    "next-tab": mac ? "⌘⇧]" : "Ctrl+Shift+]",
    "previous-tab": mac ? "⌘⇧[" : "Ctrl+Shift+[",
    "next-pane": mac ? "⌘]" : "Ctrl+]",
    "previous-pane": mac ? "⌘[" : "Ctrl+[",
    "toggle-maximize": mac ? "⌘⇧M" : "Ctrl+Shift+M",
    "toggle-sidebar": mac ? "⌘B" : "Ctrl+B",
    "toggle-right-panel": mac ? "⌘⌥B" : "Ctrl+Alt+B",
    "switch-workspace": mac ? "⌘K" : "Ctrl+K",
    "workspace-go-back": mac ? "⌘⌥←" : "Ctrl+Alt+←",
    "workspace-go-forward": mac ? "⌘⌥→" : "Ctrl+Alt+→",
    "show-all-projects": mac ? "⌘0" : "Ctrl+0",
    "show-chat": mac ? "⌃⌘I" : "Ctrl+Alt+I",
    "open-file-external": mac ? "⌘O" : "Ctrl+O",
    "zoom-in": mac ? "⌘=" : "Ctrl+=",
    "zoom-out": mac ? "⌘-" : "Ctrl+-",
    "zoom-reset": mac ? "⌘⇧0" : "Ctrl+Shift+0",
  };
  for (const [id, shortcut] of Object.entries(expected)) {
    await expect(palette.shortcut(id)).toHaveText(shortcut);
  }

  await palette.run("workspace-go-back");
  await expect(palette.dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(WORKSPACE_A)));
});

test("the palette's Split Right splits a terminal tab into nested panes", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const palette = new CommandPalette(page);
  await workspacePage.goto(WORKSPACE_SPLIT);
  await workspacePage.waitForReady();
  await workspacePage.focusTerminal();
  await expect(workspacePage.terminalPanes()).toHaveCount(1);

  await palette.open();
  await palette.run("split-right");

  await expect(workspacePage.terminalPanes()).toHaveCount(2);
  await expect(workspacePage.terminalTabs()).toHaveCount(1);
});

test("the palette's Show All Projects clears the label filter", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const palette = new CommandPalette(page);
  await workspacePage.goto(WORKSPACE_A);
  await workspacePage.waitForReady();

  await workspacePage.selectLabelFilter(LABEL);
  await expect(workspacePage.projectHeader(PROJECT_A)).toBeVisible();
  await expect(workspacePage.projectHeader(PROJECT_B)).toBeHidden();

  await palette.open();
  await palette.run("show-all-projects");

  await expect(workspacePage.projectHeader(PROJECT_B)).toBeVisible();
});
