/**
 * Holding Ctrl and pressing Tab lists the active group's tabs, most recently
 * used first. Tab / Shift+Tab move the highlight, releasing Ctrl opens the
 * highlighted tab, Escape closes the list without switching.
 *
 * Browser tabs are not covered: they are `<webview>` guests only the desktop
 * build renders, and this harness boots the web build in plain Chromium.
 *
 * Boots the real production server against a fresh tmp home, with the ACP stub
 * agent behind the chat, and drives a real Chromium through page objects.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
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
import { CenterTabFocus } from "./pages/CenterTabFocus";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-center-tab-switcher-token";
const BRANCH = "main";
const REPOS = {
  order: "switcher-order",
  steps: "switcher-steps",
  split: "switcher-split",
  focus: "switcher-focus",
  single: "switcher-single",
} as const;
const wt = (repo: string) => toWorktreeId(repo, BRANCH, "local");

const FILE_A = "a.ts";
const FILE_B = "b.ts";
const FILE_C = "c.ts";

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const makeRepo = (name: string) => {
    const repoPath = join(tmpHome, name);
    mkdirSync(repoPath, { recursive: true });
    git(repoPath, ["init", "-b", BRANCH]);
    for (const file of [FILE_A, FILE_B, FILE_C]) {
      writeFileSync(join(repoPath, file), `export const name = "${file}";\n`);
    }
    git(repoPath, ["add", "."]);
    git(repoPath, ["commit", "-m", "initial"]);
    return {
      name,
      path: repoPath,
      defaultBranch: BRANCH,
      worktrees: [{ branch: BRANCH, path: repoPath }],
    };
  };
  seedState(tmpHome, { repos: Object.values(REPOS).map(makeRepo) });
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

async function openABC(worktreePage: WorktreePage): Promise<void> {
  await worktreePage.openFileViaQuickOpen(FILE_A);
  await worktreePage.openFileViaQuickOpen(FILE_B);
  await worktreePage.openFileViaQuickOpen(FILE_C);
  await expect(worktreePage.fileTabContainer(FILE_C)).toHaveClass(/\bdv-active-tab\b/);
}

test("holding Ctrl+Tab lists tabs by recency and releasing opens the highlighted one, a tap toggles", async ({
  page,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const focus = new CenterTabFocus(page);
  await worktreePage.goto(wt(REPOS.order));
  await worktreePage.waitForReady();
  await openABC(worktreePage);

  await focus.openSwitcher();
  await expect(focus.switcher()).toBeVisible();
  await expect
    .poll(async () => (await focus.switcherTitles()).slice(0, 3))
    .toEqual([FILE_C, FILE_B, FILE_A]);
  await expect(focus.switcherItems().nth(1)).toHaveAttribute("aria-current", "true");
  await expect(focus.switcherItems().nth(0)).toHaveAttribute("aria-current", "false");

  await focus.releaseControl();
  await expect(focus.switcher()).toBeHidden();
  await expect(worktreePage.fileTabContainer(FILE_B)).toHaveClass(/\bdv-active-tab\b/);

  // B is active and C was active before it: a quick tap goes back to C.
  await focus.pressNextTab();
  await expect(worktreePage.fileTabContainer(FILE_C)).toHaveClass(/\bdv-active-tab\b/);
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("editor");
});

test("Tab and Shift+Tab move the highlight and wrap, Escape cancels", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const focus = new CenterTabFocus(page);
  await worktreePage.goto(wt(REPOS.steps));
  await worktreePage.waitForReady();
  await openABC(worktreePage);
  // Recency: C, B, A, Terminal.
  const highlighted = async () =>
    focus
      .switcherItems()
      .evaluateAll((els) => els.findIndex((el) => el.getAttribute("aria-current") === "true"));

  await focus.openSwitcher();
  await expect.poll(highlighted).toBe(1);
  await focus.pressTabWhileHeld();
  await expect.poll(highlighted).toBe(2);
  await focus.pressTabWhileHeld({ shift: true });
  await focus.pressTabWhileHeld({ shift: true });
  await expect.poll(highlighted).toBe(0);
  await focus.pressTabWhileHeld({ shift: true });
  await expect.poll(highlighted).toBe(3);
  await focus.pressTabWhileHeld();
  await expect.poll(highlighted).toBe(0);
  await focus.pressTabWhileHeld();
  await focus.pressTabWhileHeld();
  await expect.poll(highlighted).toBe(2);
  await focus.releaseControl();
  await expect(worktreePage.fileTabContainer(FILE_A)).toHaveClass(/\bdv-active-tab\b/);

  // Escape closes the list and leaves the active tab alone.
  await focus.openSwitcher();
  await expect(focus.switcher()).toBeVisible();
  await focus.pressEscapeWhileHeld();
  await expect(focus.switcher()).toBeHidden();
  await focus.releaseControl();
  await expect(worktreePage.fileTabContainer(FILE_A)).toHaveClass(/\bdv-active-tab\b/);

  // Shift opens on the least recently used tab, the terminal.
  await focus.openSwitcher({ shift: true });
  await expect(focus.switcher()).toBeVisible();
  await focus.releaseControl();
  await expect(worktreePage.tabContainer("terminal")).toHaveClass(/\bdv-active-tab\b/);
});

test("the list shows only the active split group's tabs", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const focus = new CenterTabFocus(page);
  await worktreePage.goto(wt(REPOS.split));
  await worktreePage.waitForReady();

  // Left group: terminal and a chat. Right group: a second chat, then a file.
  await worktreePage.openChat(wt(REPOS.split));
  await worktreePage.clickChatSplitRight(wt(REPOS.split));
  await expect(worktreePage.chatTabs()).toHaveCount(2);
  await worktreePage.chatTabs().nth(1).click();
  await worktreePage.openFileViaQuickOpen(FILE_A);
  await expect(worktreePage.fileTabContainer(FILE_A)).toHaveClass(/\bdv-active-tab\b/);

  await focus.openSwitcher();
  await expect(focus.switcherItems()).toHaveCount(2);
  const titles = await focus.switcherTitles();
  expect(titles[0]).toBe(FILE_A);
  await focus.releaseControl();
});

test("the list opens with focus in a terminal or a chat composer", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const focus = new CenterTabFocus(page);
  await worktreePage.goto(wt(REPOS.focus));
  await worktreePage.waitForReady();
  await worktreePage.openChat(wt(REPOS.focus));
  await worktreePage.focusTerminal();
  await worktreePage.tab("chat").click();
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("chat-composer");

  await focus.openSwitcher();
  await expect(focus.switcher()).toBeVisible();
  await focus.releaseControl();
  await expect(worktreePage.tabContainer("terminal")).toHaveClass(/\bdv-active-tab\b/);
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("terminal");

  // From the terminal, the Tab does not reach the shell and the list opens.
  await focus.openSwitcher();
  await expect(focus.switcher()).toBeVisible();
  await focus.releaseControl();
  await expect(worktreePage.tabContainer("chat")).toHaveClass(/\bdv-active-tab\b/);
  await expect.poll(() => focus.focusedSurface(), { timeout: 10_000 }).toBe("chat-composer");
});

test("a group with one tab shows no list", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const focus = new CenterTabFocus(page);
  await worktreePage.goto(wt(REPOS.single));
  await worktreePage.waitForReady();

  await focus.openSwitcher();
  await expect(focus.switcher()).toBeHidden();
  await focus.releaseControl();
  await expect(worktreePage.tabContainer("terminal")).toHaveClass(/\bdv-active-tab\b/);

  // The handler was live all along: with a second tab the list does open.
  await worktreePage.openFileViaQuickOpen(FILE_A);
  await focus.openSwitcher();
  await expect(focus.switcherItems()).toHaveCount(2);
  await focus.releaseControl();
});
