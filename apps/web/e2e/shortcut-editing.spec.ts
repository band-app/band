/**
 * Every Band command, including the worktree right-click actions, is in one shortcut registry.
 * Settings > Keyboard lists them and lets the user rebind, clear and reset a chord; the override
 * is stored in the synced client-state key `band:shortcut-overrides` (scope `all`); the command
 * palette and the context menu show the chord in force; the palette lists the worktree actions.
 *
 * Real production server and Chromium. The pull runs against a real git repo whose origin is one
 * commit ahead and whose worktree has a local edit, so git refuses and the app shows a notice.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { gitInHome } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  readClientStateValue,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { CenterTabFocus } from "./pages/CenterTabFocus";
import { CommandPalette } from "./pages/CommandPalette";
import { KeyboardSettingsPage } from "./pages/KeyboardSettingsPage";
import { ToastHostPage } from "./pages/ToastHostPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-shortcut-editing-token";
const BRANCH = "main";
const REPO = "shortcut-repo";
const WORKTREE = toWorktreeId(REPO, BRANCH, "local");
const OVERRIDES_KEY = "band:shortcut-overrides";
const PULL_NOTICE = "Pull skipped: commit or stash your local changes first (README.md).";

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const originPath = join(tmpHome, "origin.git");
  const repoPath = join(tmpHome, REPO);
  const seederPath = join(tmpHome, "seeder");
  mkdirSync(originPath, { recursive: true });
  gitInHome(originPath, ["init", "--bare", "-b", BRANCH], tmpHome);
  mkdirSync(repoPath, { recursive: true });
  gitInHome(repoPath, ["init", "-b", BRANCH], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# Shortcut test\n");
  gitInHome(repoPath, ["add", "."], tmpHome);
  gitInHome(repoPath, ["commit", "-m", "initial commit"], tmpHome);
  gitInHome(repoPath, ["remote", "add", "origin", originPath], tmpHome);
  gitInHome(repoPath, ["push", "-u", "origin", BRANCH], tmpHome);
  gitInHome(tmpHome, ["clone", originPath, seederPath], tmpHome);
  writeFileSync(join(seederPath, "upstream.md"), "# From upstream\n");
  gitInHome(seederPath, ["add", "."], tmpHome);
  gitInHome(seederPath, ["commit", "-m", "upstream change"], tmpHome);
  gitInHome(seederPath, ["push", "origin", BRANCH], tmpHome);
  rmSync(seederPath, { recursive: true, force: true });
  writeFileSync(join(repoPath, "README.md"), "# Edited locally\n");

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
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  if (server) await server.close();
  cleanupTmpHome(tmpHome);
});

const mac = process.platform === "darwin";

test("S1: the tab chords that used to do nothing cycle tabs in the focused group", async ({
  page,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const focus = new CenterTabFocus(page);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await worktreePage.pressNewChatShortcut();
  await expect(worktreePage.chatTabs()).toHaveCount(1);
  await expect(worktreePage.tabContainer("chat")).toHaveAttribute("data-selected", "true");
  // The tab handler acts on focus inside the layout; wait until the new chat holds it.
  await expect.poll(() => focus.focusedSurface()).toBe("chat-composer");

  await worktreePage.pressChord("Mod+Shift+BracketLeft");
  await expect(worktreePage.tabContainer("terminal")).toHaveAttribute("data-selected", "true");
  // The switch moves focus into the tab; wait for it before the next chord.
  await expect.poll(() => focus.focusedSurface()).toBe("terminal");
  await worktreePage.pressChord("Mod+Shift+BracketRight");
  await expect(worktreePage.tabContainer("chat")).toHaveAttribute("data-selected", "true");
});

test("S2: Settings > Keyboard lists palette commands and right-click actions with their chords", async ({
  page,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const keyboard = new KeyboardSettingsPage(page, server.url, TOKEN);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await keyboard.open();

  const ids = await keyboard.commandIds();
  for (const id of ["quick-open", "next-tab", "worktree-git-pull", "worktree-git-push"]) {
    expect(ids).toContain(id);
  }
  await expect(keyboard.chord("quick-open")).toHaveText(mac ? "⌘P" : "Ctrl+P");
  await expect(keyboard.chord("worktree-git-pull")).toHaveText("none");

  // Clear, then reset one; change two, then reset all.
  await keyboard.clear("quick-open");
  await expect(keyboard.chord("quick-open")).toHaveText("none");
  await keyboard.reset("quick-open");
  await expect(keyboard.chord("quick-open")).toHaveText(mac ? "⌘P" : "Ctrl+P");

  await keyboard.record("worktree-git-pull", "Mod+Shift+KeyL");
  await expect(keyboard.chord("worktree-git-pull")).toHaveText(mac ? "⌘⇧L" : "Ctrl+Shift+L");
  await keyboard.clear("find-in-file");
  await keyboard.resetAll();
  await expect(keyboard.chord("worktree-git-pull")).toHaveText("none");
  await expect(keyboard.chord("find-in-file")).toHaveText(mac ? "⌘F" : "Ctrl+F");
});

test("S3: a rebound chord runs the command, the old chord stops, and the override is synced and survives a reload", async ({
  page,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const keyboard = new KeyboardSettingsPage(page, server.url, TOKEN);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await expect(worktreePage.terminalTabs()).toHaveCount(1);

  await keyboard.open();
  await keyboard.record("new-terminal", "Mod+Shift+KeyY");
  await keyboard.close();

  await worktreePage.pressChord("Mod+Shift+KeyY");
  await expect(worktreePage.terminalTabs()).toHaveCount(2);
  await worktreePage.pressChord("Mod+KeyT");
  // The old chord is free: nothing opens (a positive wait, then the count is still two).
  await expect(worktreePage.terminalTabs()).toHaveCount(2);

  await expect
    .poll(() => readClientStateValue(tmpHome, OVERRIDES_KEY))
    .toBe(JSON.stringify({ "new-terminal": "Cmd+Shift+Y" }));

  await page.reload();
  await worktreePage.waitForReady();
  const before = await worktreePage.terminalTabs().count();
  await worktreePage.pressChord("Mod+Shift+KeyY");
  await expect(worktreePage.terminalTabs()).toHaveCount(before + 1);
});

test("S4: assigning a chord another command holds shows the conflict and changes nothing until confirmed", async ({
  page,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const keyboard = new KeyboardSettingsPage(page, server.url, TOKEN);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await keyboard.open();

  await keyboard.record("worktree-git-push", "Mod+KeyP");
  await expect(keyboard.conflict).toBeVisible();
  await expect(keyboard.conflict).toContainText("Quick Open");
  await expect(keyboard.chord("worktree-git-push")).toHaveText("none");
  await expect(keyboard.chord("quick-open")).toHaveText(mac ? "⌘P" : "Ctrl+P");

  await keyboard.cancelConflict();
  await expect(keyboard.conflict).toBeHidden();
  await expect(keyboard.chord("quick-open")).toHaveText(mac ? "⌘P" : "Ctrl+P");

  await keyboard.record("worktree-git-push", "Mod+KeyP");
  await keyboard.confirmConflict();
  await expect(keyboard.chord("worktree-git-push")).toHaveText(mac ? "⌘P" : "Ctrl+P");
  await expect(keyboard.chord("quick-open")).toHaveText("none");
});

test("S5: a chord assigned to Git pull runs it on the current worktree and the menu shows it", async ({
  page,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const keyboard = new KeyboardSettingsPage(page, server.url, TOKEN);
  const toasts = new ToastHostPage(page);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();

  await keyboard.open();
  await keyboard.record("worktree-git-pull", "Mod+Shift+KeyL");
  await keyboard.close();

  await worktreePage.pressChord("Mod+Shift+KeyL");
  await expect(toasts.infoNotices.first()).toContainText(PULL_NOTICE);

  await worktreePage.openWorktreeMenu(WORKTREE);
  await expect(worktreePage.menuChord("worktree-git-pull")).toHaveText(
    mac ? "⌘⇧L" : "Ctrl+Shift+L",
  );
});

test("S6: the command palette lists the worktree's Git pull and Git push and runs them", async ({
  page,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const keyboard = new KeyboardSettingsPage(page, server.url, TOKEN);
  const palette = new CommandPalette(page);
  const toasts = new ToastHostPage(page);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();

  await keyboard.open();
  await keyboard.record("worktree-git-push", "Mod+Shift+KeyU");
  await keyboard.close();

  await palette.open();
  await palette.type("pull");
  await expect(palette.item("worktree-git-pull")).toBeVisible();
  await palette.type("");
  await palette.type("push");
  await expect(palette.item("worktree-git-push")).toBeVisible();
  await expect(palette.shortcut("worktree-git-push")).toHaveText(mac ? "⌘⇧U" : "Ctrl+Shift+U");

  await palette.type("");
  await palette.type("pull");
  await palette.run("worktree-git-pull");
  await expect(toasts.infoNotices.first()).toContainText(PULL_NOTICE);
});
