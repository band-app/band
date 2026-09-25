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
 * against a fresh tmp home, drives a real Chromium via a `WorkspacePage` page
 * object — no tRPC mocking, no `page.route()` on own routes, no direct
 * `page.getByTestId` in the test body. Real PTYs back each pane.
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

const TOKEN = "e2e-terminal-nested-panes-token";
const BRANCH = "main";

// One dedicated workspace per test. The server keeps PTYs alive across tests in
// a file (only localStorage is per-test), so a shared workspace would let one
// test's leftover terminals reconcile into the next test as stray tabs/panes —
// giving the pane-count assertions the wrong baseline. Separate projects keep
// each test hermetic.
const PROJECT_SPLIT = "term-panes-split";
const PROJECT_TITLE = "term-panes-title";
const PROJECT_DRAG = "term-panes-drag";
const PROJECT_ICON = "term-panes-icon";
const PROJECT_CHAT = "term-panes-chat";
const WS_SPLIT = toWorkspaceId(PROJECT_SPLIT, BRANCH);
const WS_TITLE = toWorkspaceId(PROJECT_TITLE, BRANCH);
const WS_DRAG = toWorkspaceId(PROJECT_DRAG, BRANCH);
const WS_ICON = toWorkspaceId(PROJECT_ICON, BRANCH);
const WS_CHAT = toWorkspaceId(PROJECT_CHAT, BRANCH);

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
    projects: [PROJECT_SPLIT, PROJECT_TITLE, PROJECT_DRAG, PROJECT_ICON, PROJECT_CHAT].map(
      makeRepo,
    ),
  });
  // `useWebGLTerminalRenderer: false` forces xterm's DOM renderer so the shell
  // prompt lands in `.xterm-rows` where `waitForPanePrompt` can read it — CI's
  // Chromium has WebGL, which otherwise renders to a canvas and leaves the rows
  // permanently empty (the same pin `terminal-parking-dispose.spec.ts` uses).
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("split creates nested panes in one tab, cycles, persists, and closes", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WS_SPLIT);
  await workspacePage.waitForReady();

  // The default layout seeds one terminal (one pane) in one terminal tab.
  await workspacePage.focusTerminal();
  await expect(workspacePage.terminalPanes()).toHaveCount(1);
  await expect(workspacePage.terminalTabs()).toHaveCount(1);

  // ⌘D → a second pane appears IN THE SAME terminal tab (no new tab).
  await workspacePage.splitTerminalRight();
  await expect(workspacePage.terminalPanes()).toHaveCount(2);
  await expect(workspacePage.terminalTabs()).toHaveCount(1);

  // ⌘⇧D on the (now-focused) new pane → a third pane, still one tab.
  await workspacePage.splitTerminalBelow();
  await expect(workspacePage.terminalPanes()).toHaveCount(3);
  await expect(workspacePage.terminalTabs()).toHaveCount(1);

  // ⌘] cycles the ACTIVE pane — verify focus actually MOVES to a DIFFERENT
  // pane, not just that the panes survive. Uses focus detection
  // (document.activeElement → owning pane) rather than shell titles (which zsh's
  // prompt resets). The just-split pane autofocuses, so a pane is already
  // focused; capture which, cycle, and assert it changed.
  await expect
    .poll(() => workspacePage.focusedPaneIndex(), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(0);
  const beforeCycle = await workspacePage.focusedPaneIndex();
  await workspacePage.cyclePaneForward();
  // Poll a composite predicate: a bare `.not.toBe(beforeCycle)` is satisfied by
  // -1 (no pane holds focus), which is exactly the transient state a cycle that
  // moves the active group but never restores DOM focus would leave behind.
  await expect
    .poll(
      async () => {
        const i = await workspacePage.focusedPaneIndex();
        return i >= 0 && i !== beforeCycle;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await expect(workspacePage.terminalPanes()).toHaveCount(3);

  // Reload → the nested split geometry is restored from localStorage.
  await page.reload();
  await workspacePage.waitForReady();
  await expect(workspacePage.terminalPanes()).toHaveCount(3);
  await expect(workspacePage.terminalTabs()).toHaveCount(1);

  // Ctrl+D closes the focused pane while >1 exist.
  await workspacePage.focusTerminal();
  await workspacePage.closeFocusedPane();
  await expect(workspacePage.terminalPanes()).toHaveCount(2);
  await expect(workspacePage.terminalTabs()).toHaveCount(1);
});

test("the outer terminal tab title tracks the last-focused pane", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WS_TITLE);
  await workspacePage.waitForReady();

  // Two panes; give each a distinct shell window title via an OSC escape. Wait
  // for each pane's shell prompt first so the escape isn't typed into a
  // not-yet-ready shell (which would drop it).
  await workspacePage.focusTerminal();
  await workspacePage.splitTerminalRight();
  await expect(workspacePage.terminalPanes()).toHaveCount(2);

  await workspacePage.waitForPanePrompt(0);
  await workspacePage.waitForPanePrompt(1);
  await workspacePage.typeInPane(0, "printf '\\033]0;PANEZERO\\007'");
  await workspacePage.typeInPane(1, "printf '\\033]0;PANEONE\\007'");

  // Pane 1 was focused last → the outer tab shows its title.
  await expect
    .poll(() => workspacePage.activeTerminalTabTitle(), { timeout: 20_000 })
    .toContain("PANEONE");

  // Focus pane 0 → the outer tab title follows to pane 0's title.
  await workspacePage.focusPane(0);
  await expect
    .poll(() => workspacePage.activeTerminalTabTitle(), { timeout: 20_000 })
    .toContain("PANEZERO");
});

test("panes can be dragged to reorder within the terminal tab", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WS_DRAG);
  await workspacePage.waitForReady();

  // Two panes. Each pane's terminalId is distinct, so a reorder is observable
  // via the DOM order of the `term-pane__<id>` wrappers (the header carries no
  // title text to key off).
  await workspacePage.focusTerminal();
  await workspacePage.splitTerminalRight();
  await expect(workspacePage.terminalPanes()).toHaveCount(2);
  const before = await workspacePage.paneOrder();
  expect(before).toHaveLength(2);

  // Drag the second pane's header onto the first pane's left edge → order swaps.
  await workspacePage.dragPaneHeaderOnto(1, 0);

  await expect
    .poll(() => workspacePage.paneOrder(), { timeout: 10_000 })
    .toEqual([before[1], before[0]]);
  // Still two panes in ONE terminal tab — a drag reorders, it never merges panes
  // into a tab strip.
  await expect(workspacePage.terminalPanes()).toHaveCount(2);
  await expect(workspacePage.terminalTabs()).toHaveCount(1);
});

test("a pane header split icon splits that pane into another pane", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WS_ICON);
  await workspacePage.waitForReady();

  // Split once (⌘D) so the panes gain headers (a lone pane hides its header),
  // then use the second pane's split-down icon to add a third pane.
  await workspacePage.focusTerminal();
  await workspacePage.splitTerminalRight();
  await expect(workspacePage.terminalPanes()).toHaveCount(2);

  await workspacePage.clickPaneSplit(1, "down");
  await expect(workspacePage.terminalPanes()).toHaveCount(3);
  // Still one outer terminal tab — the split stays nested.
  await expect(workspacePage.terminalTabs()).toHaveCount(1);
});

test("⌘D in a chat leaf still splits chat into a sibling group (regression)", async ({ page }) => {
  // Prove the outer split branch survives for non-terminal leaves — terminals
  // were removed from it (they split into nested panes instead).
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WS_CHAT);
  await workspacePage.waitForReady();

  const chatTabs = () => page.getByTestId(/^center-chat-tab--/).filter({ visible: true });
  // The default layout is a single terminal — no chat. Create one via the "+"
  // menu (chat leaves still split into sibling groups, unlike terminals).
  await expect(chatTabs()).toHaveCount(0);
  await workspacePage.clickChatAddTab(WS_CHAT);
  await expect(chatTabs()).toHaveCount(1);

  // Focus the chat pane via its prompt input (in the content area — clicking the
  // tab strip can be intercepted by a dockview sash), then ⌘D → a second chat
  // leaf in a SIBLING group (terminals nest instead; chat/browser still split).
  await page.getByPlaceholder("Type a message...").first().click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+d" : "Control+d");
  await expect(chatTabs()).toHaveCount(2);
});
