/**
 * End-to-end coverage for **nested terminal panes** — splitting a terminal INTO
 * resizable panes inside a single terminal tab (tmux-style), rather than
 * spawning a sibling terminal tab (issue #643 follow-up).
 *
 * Contract under test:
 *   - ⌘D / ⌘⇧D split the focused pane right / below → N `.term-pane__*` panes
 *     inside ONE outer terminal tab (no new terminal tab appears).
 *   - ⌘] cycles panes.
 *   - The panes survive a reload (client-side `band:term-split:*` persistence).
 *   - Ctrl+D closes the focused pane (down to a single pane); the lone pane is
 *     closed via the outer tab, not from within.
 *   - The outer terminal tab title tracks the last-focused pane.
 *   - Panes can be dragged (via their header) to reorder, without ever merging
 *     into a tab strip.
 *
 * Architecture (repo integration doctrine): boots the real production server
 * against a fresh tmp home, drives a real Chromium via a `WorktreePage` page
 * object — no tRPC mocking, no `page.route()` on own routes, no direct
 * `page.getByTestId` in the test body. Real PTYs back each pane.
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
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-terminal-nested-panes-token";
const BRANCH = "main";

// One dedicated worktree per test. The server keeps PTYs alive across tests in
// a file (only localStorage is per-test), so a shared worktree would let one
// test's leftover terminals reconcile into the next test as stray tabs/panes —
// giving the pane-count assertions the wrong baseline. Separate repos keep
// each test hermetic.
const REPO_SPLIT = "term-panes-split";
const REPO_TITLE = "term-panes-title";
const REPO_DRAG = "term-panes-drag";
const REPO_ICON = "term-panes-icon";
const REPO_CHAT = "term-panes-chat";
const WS_SPLIT = toWorktreeId(REPO_SPLIT, BRANCH, "local");
const WS_TITLE = toWorktreeId(REPO_TITLE, BRANCH, "local");
const WS_DRAG = toWorktreeId(REPO_DRAG, BRANCH, "local");
const WS_ICON = toWorktreeId(REPO_ICON, BRANCH, "local");
const WS_CHAT = toWorktreeId(REPO_CHAT, BRANCH, "local");

// Wide viewport so `useIsDesktop()` reports true and the split-capable center
// dockview renders (mobile is single-pane / no split).
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const makeRepo = (name: string) => {
    const repoPath = join(tmpHome, name);
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, ["init", "-b", BRANCH]);
    writeFileSync(join(repoPath, "README.md"), "# term panes\n");
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-m", "initial"]);
    return {
      name,
      path: repoPath,
      defaultBranch: BRANCH,
      worktrees: [{ branch: BRANCH, path: repoPath }],
    };
  };

  seedState(tmpHome, {
    repos: [REPO_SPLIT, REPO_TITLE, REPO_DRAG, REPO_ICON, REPO_CHAT].map(makeRepo),
  });
  // `useWebGLTerminalRenderer: false` forces xterm's DOM renderer so the shell
  // prompt lands in `.xterm-rows` where `waitForPanePrompt` can read it — CI's
  // Chromium has WebGL, which otherwise renders to a canvas and leaves the rows
  // permanently empty (the same pin `terminal-parking-dispose.spec.ts` uses).
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

test("split creates nested panes in one tab, cycles, persists, and closes", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WS_SPLIT);
  await worktreePage.waitForReady();

  // The default layout seeds one terminal (one pane) in one terminal tab.
  await worktreePage.focusTerminal();
  await expect(worktreePage.terminalPanes()).toHaveCount(1);
  await expect(worktreePage.terminalTabs()).toHaveCount(1);

  // ⌘D → a second pane appears IN THE SAME terminal tab (no new tab).
  await worktreePage.splitTerminalRight();
  await expect(worktreePage.terminalPanes()).toHaveCount(2);
  await expect(worktreePage.terminalTabs()).toHaveCount(1);

  // ⌘⇧D on the (now-focused) new pane → a third pane, still one tab.
  await worktreePage.splitTerminalBelow();
  await expect(worktreePage.terminalPanes()).toHaveCount(3);
  await expect(worktreePage.terminalTabs()).toHaveCount(1);

  // ⌘] cycles the ACTIVE pane — verify focus actually MOVES to a DIFFERENT
  // pane, not just that the panes survive. Uses focus detection
  // (document.activeElement → owning pane) rather than shell titles (which zsh's
  // prompt resets). The just-split pane autofocuses, so a pane is already
  // focused; capture which, cycle, and assert it changed.
  await expect
    .poll(() => worktreePage.focusedPaneIndex(), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(0);
  const beforeCycle = await worktreePage.focusedPaneIndex();
  await worktreePage.cyclePaneForward();
  // Poll a composite predicate: a bare `.not.toBe(beforeCycle)` is satisfied by
  // -1 (no pane holds focus), which is exactly the transient state a cycle that
  // moves the active group but never restores DOM focus would leave behind.
  await expect
    .poll(
      async () => {
        const i = await worktreePage.focusedPaneIndex();
        return i >= 0 && i !== beforeCycle;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await expect(worktreePage.terminalPanes()).toHaveCount(3);

  // Reload → the nested split geometry is restored from localStorage.
  await page.reload();
  await worktreePage.waitForReady();
  await expect(worktreePage.terminalPanes()).toHaveCount(3);
  await expect(worktreePage.terminalTabs()).toHaveCount(1);

  // Ctrl+D closes the focused pane while >1 exist.
  await worktreePage.focusTerminal();
  await worktreePage.closeFocusedPane();
  await expect(worktreePage.terminalPanes()).toHaveCount(2);
  await expect(worktreePage.terminalTabs()).toHaveCount(1);
});

test("the outer terminal tab title tracks the last-focused pane", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WS_TITLE);
  await worktreePage.waitForReady();

  // Two panes; give each a distinct shell window title via an OSC escape. Wait
  // for each pane's shell prompt first so the escape isn't typed into a
  // not-yet-ready shell (which would drop it).
  await worktreePage.focusTerminal();
  await worktreePage.splitTerminalRight();
  await expect(worktreePage.terminalPanes()).toHaveCount(2);

  await worktreePage.waitForPanePrompt(0);
  await worktreePage.waitForPanePrompt(1);
  await worktreePage.typeInPane(0, "printf '\\033]0;PANEZERO\\007'");
  await worktreePage.typeInPane(1, "printf '\\033]0;PANEONE\\007'");

  // Pane 1 was focused last → the outer tab shows its title.
  await expect
    .poll(() => worktreePage.activeTerminalTabTitle(), { timeout: 20_000 })
    .toContain("PANEONE");

  // Focus pane 0 → the outer tab title follows to pane 0's title.
  await worktreePage.focusPane(0);
  await expect
    .poll(() => worktreePage.activeTerminalTabTitle(), { timeout: 20_000 })
    .toContain("PANEZERO");
});

test("panes can be dragged to reorder within the terminal tab", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WS_DRAG);
  await worktreePage.waitForReady();

  // Two panes. Each pane's terminalId is distinct, so a reorder is observable
  // via the DOM order of the `term-pane__<id>` wrappers (the header carries no
  // title text to key off).
  await worktreePage.focusTerminal();
  await worktreePage.splitTerminalRight();
  await expect(worktreePage.terminalPanes()).toHaveCount(2);
  const before = await worktreePage.paneOrder();
  expect(before).toHaveLength(2);

  // Drag the second pane's header onto the first pane's left edge → order swaps.
  await worktreePage.dragPaneHeaderOnto(1, 0);

  await expect
    .poll(() => worktreePage.paneOrder(), { timeout: 10_000 })
    .toEqual([before[1], before[0]]);
  // Still two panes in ONE terminal tab — a drag reorders, it never merges panes
  // into a tab strip.
  await expect(worktreePage.terminalPanes()).toHaveCount(2);
  await expect(worktreePage.terminalTabs()).toHaveCount(1);
});

test("a pane header split icon splits that pane into another pane", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WS_ICON);
  await worktreePage.waitForReady();

  // Split once (⌘D) so the panes gain headers (a lone pane hides its header),
  // then use the second pane's split-down icon to add a third pane.
  await worktreePage.focusTerminal();
  await worktreePage.splitTerminalRight();
  await expect(worktreePage.terminalPanes()).toHaveCount(2);

  await worktreePage.clickPaneSplit(1, "down");
  await expect(worktreePage.terminalPanes()).toHaveCount(3);
  // Still one outer terminal tab — the split stays nested.
  await expect(worktreePage.terminalTabs()).toHaveCount(1);
});

test("⌘D in a chat leaf still splits chat into a sibling group (regression)", async ({ page }) => {
  // Prove the outer split branch survives for non-terminal leaves — terminals
  // were removed from it (they split into nested panes instead).
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WS_CHAT);
  await worktreePage.waitForReady();

  const chatTabs = () => page.getByTestId(/^center-chat-tab--/).filter({ visible: true });
  // The default layout is a single terminal — no chat. Create one via the "+"
  // menu (chat leaves still split into sibling groups, unlike terminals).
  await expect(chatTabs()).toHaveCount(0);
  await worktreePage.clickChatAddTab(WS_CHAT);
  await expect(chatTabs()).toHaveCount(1);

  // Focus the chat pane via its prompt input (in the content area — clicking the
  // tab strip can be intercepted by a dockview sash), then ⌘D → a second chat
  // leaf in a SIBLING group (terminals nest instead; chat/browser still split).
  await page.getByPlaceholder("Type a message...").first().click();
  await worktreePage.pressSplitRight();
  await expect(chatTabs()).toHaveCount(2);
});
