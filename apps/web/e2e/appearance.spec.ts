/**
 * Settings > Appearance: mode cards, theme preset, accent / background /
 * foreground, fonts and sizes. Every surface follows the choice through CSS
 * variables on <html>, with no reload.
 *
 * The real production server boots against a fresh tmp $HOME with a git
 * worktree that has one modified and one new file, so the Explorer, the
 * Changes tree and a terminal are real. Assertions read computed styles and
 * the terminal's live xterm options.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Browser, expect, test } from "@playwright/test";

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
import { AppearancePage } from "./pages/AppearancePage";
import { FileTreesPage } from "./pages/FileTreesPage";
import { TerminalSurface } from "./pages/TerminalSurface";
import { WorktreePage } from "./pages/WorktreePage";

test.use({ viewport: { width: 1500, height: 900 } });

const TOKEN = "e2e-appearance-token";
const REPO = "appearance-repo";
const BRANCH = "main";
const worktreeId = toWorktreeId(REPO, BRANCH, "local");

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repoPath = join(tmpHome, REPO);
  mkdirSync(join(repoPath, "src"), { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, "src", "kept.ts"), "export const kept = 1;\n");
  writeFileSync(join(repoPath, "src", "edited.ts"), "export const edited = 1;\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  writeFileSync(join(repoPath, "src", "edited.ts"), "export const edited = 2;\n");

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
  seedSettings(tmpHome, { tokenSecret: TOKEN, theme: "dark", useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("S1: the page has the mode cards, theme, colors, fonts, sizes and reset", async ({
  page,
}, testInfo) => {
  const appearance = new AppearancePage(page, server.url, TOKEN);
  await appearance.open();

  for (const mode of ["system", "light", "dark"] as const) {
    await expect(appearance.modeCard(mode)).toBeVisible();
  }
  await expect(appearance.presetSelect()).toContainText("Band");
  for (const key of ["accent", "background", "foreground"] as const) {
    await expect(appearance.colorHex(key)).toBeVisible();
    await expect(appearance.colorPicker(key)).toBeAttached();
  }
  await expect(appearance.uiFontSelect()).toBeVisible();
  await expect(appearance.codeFontSelect()).toBeVisible();
  await expect(appearance.uiSizeInput()).toHaveValue("16");
  await expect(appearance.codeSizeInput()).toHaveValue("13");
  await expect(appearance.resetButton()).toBeVisible();

  await appearance.chooseMode("dark");
  await testInfo.attach("appearance-dark", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await appearance.chooseMode("light");
  await testInfo.attach("appearance-light", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("choosing a mode flips the page and stays on this device", async ({ page }) => {
  const appearance = new AppearancePage(page, server.url, TOKEN);
  await appearance.open();
  await appearance.chooseMode("light");
  expect(await appearance.isDark()).toBe(false);
  await appearance.chooseMode("dark");
  expect(await appearance.isDark()).toBe(true);
  // The mode is not part of the synced appearance.
  expect(await appearance.storedAppearance()).toBeNull();
});

test("Band with nothing changed leaves the stylesheet's values in charge", async ({ page }) => {
  const appearance = new AppearancePage(page, server.url, TOKEN);
  await appearance.open();
  expect(await appearance.inlineVar("--background")).toBe("");
  expect(await appearance.inlineVar("--font-ui")).toBe("");
  expect(await appearance.cssVar("--background")).toBe("#1e1e1e");
});

test("S3: a preset restyles the app without a reload, terminal included", async ({ page }) => {
  const appearance = new AppearancePage(page, server.url, TOKEN);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const trees = new FileTreesPage(page, worktree);
  const terminal = new TerminalSurface(page, worktreeId);

  await worktree.goto(worktreeId);
  await worktree.waitForReady();
  await worktree.openTerminalTab();
  await worktree.waitForTerminalReady(20_000);
  await expect.poll(async () => (await terminal.readOptions())?.background).toBe("#1e1e1e");

  await trees.openFilesTab("src");
  await trees.expandFileTreeFolder("src", "src/kept.ts");
  await trees.clickFile("src/kept.ts");
  const selectedBefore = await appearance.computed(
    trees.fileTreeRow("src/kept.ts"),
    "background-color",
  );
  await trees.openChangesTab("src/edited.ts");
  const letter = trees.changesTreeRow("src/edited.ts").getByTestId("changes-tree__status");
  const letterBefore = await appearance.computed(letter, "color");

  await appearance.settings.goto();
  await appearance.settings.openDialog("appearance");
  await appearance.choosePreset("Nord");
  await appearance.settings.backToApp();

  await expect.poll(() => appearance.cssVar("--background")).toBe("#2e3440");
  // The terminal repainted in place: same xterm instance, new colors.
  await expect.poll(async () => (await terminal.readOptions())?.background).toBe("#2e3440");
  await worktree.selectRightPanelTab("explorer");
  await expect(trees.fileTreeRow("src/kept.ts")).toBeVisible();
  const selectedAfter = await appearance.computed(
    trees.fileTreeRow("src/kept.ts"),
    "background-color",
  );
  expect(selectedAfter).not.toBe(selectedBefore);
  await trees.openChangesTab("src/edited.ts");
  const letterAfter = await appearance.computed(letter, "color");
  expect(letterAfter).not.toBe(letterBefore);
  expect(letterAfter).toBe(await appearance.resolvedColor("--git-modified"));
});

test("an accent change recolors the selection", async ({ page }) => {
  const appearance = new AppearancePage(page, server.url, TOKEN);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const trees = new FileTreesPage(page, worktree);
  await worktree.goto(worktreeId);
  await worktree.waitForReady();
  await trees.openFilesTab("src");
  await trees.expandFileTreeFolder("src", "src/kept.ts");
  await trees.clickFile("src/kept.ts");
  const before = await appearance.computed(trees.fileTreeRow("src/kept.ts"), "background-color");

  await appearance.settings.openDialog("appearance");
  await appearance.setColor("accent", "#ff0066");
  await expect(appearance.presetSelect()).toContainText("Custom");
  await appearance.settings.backToApp();

  await expect
    .poll(() => appearance.computed(trees.fileTreeRow("src/kept.ts"), "background-color"))
    .not.toBe(before);
  await expect.poll(() => appearance.cssVar("--primary")).toBe("#ff0066");
});

test("S5: font sizes apply to the UI and to code, and the terminal refits", async ({ page }) => {
  const appearance = new AppearancePage(page, server.url, TOKEN);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const terminal = new TerminalSurface(page, worktreeId);

  await worktree.goto(worktreeId);
  await worktree.waitForReady();
  await worktree.openTerminalTab();
  await worktree.waitForTerminalReady(20_000);
  await expect.poll(() => terminal.readSize()).not.toBeNull();
  const before = await terminal.readSize();

  await appearance.settings.openDialog("appearance");
  await appearance.setSize("ui", 18);
  await appearance.setSize("code", 14);
  await expect.poll(() => appearance.rootFontSizePx()).toBe(18);
  await expect.poll(() => appearance.cssVar("--code-font-size")).toBe("14px");
  await appearance.settings.backToApp();

  await expect.poll(async () => (await terminal.readOptions())?.fontSize).toBe(14);
  await expect.poll(async () => (await terminal.readSize())?.cols).not.toBe(before?.cols);

  // Code in the editor uses the code size.
  const trees = new FileTreesPage(page, worktree);
  await trees.openFilesTab("src");
  await trees.expandFileTreeFolder("src", "src/kept.ts");
  await trees.openFile("src/kept.ts");
  expect(await appearance.codeEditorFontSize()).toBe("14px");
});

test("a code font choice reaches the terminal", async ({ page }) => {
  const appearance = new AppearancePage(page, server.url, TOKEN);
  const worktree = new WorktreePage(page, server.url, TOKEN);
  const terminal = new TerminalSurface(page, worktreeId);
  await worktree.goto(worktreeId);
  await worktree.waitForReady();
  await worktree.openTerminalTab();
  await worktree.waitForTerminalReady(20_000);

  await appearance.settings.openDialog("appearance");
  await appearance.chooseFont("code", "Menlo");
  await appearance.settings.backToApp();
  await expect.poll(async () => (await terminal.readOptions())?.fontFamily).toContain("Menlo");
});

test("S6: the theme follows the hub to a second browser, the mode stays per device", async ({
  browser,
}) => {
  const first = await signedInPage(browser);
  const appearanceA = new AppearancePage(first.page, server.url, TOKEN);
  await appearanceA.open();
  await appearanceA.choosePreset("Solarized");
  await appearanceA.chooseMode("light");

  const second = await signedInPage(browser);
  const appearanceB = new AppearancePage(second.page, server.url, TOKEN);
  await appearanceB.openUntilPreset("Solarized");
  // B never chose a mode: it keeps its own default (dark), while A is light.
  expect(await appearanceB.isDark()).toBe(true);
  expect(await appearanceA.isDark()).toBe(false);
  expect(await appearanceB.cssVar("--background")).toBe("#002b36");

  await first.context.close();
  await second.context.close();
});

test("S6: a reload paints the theme before the app loads", async ({ page }) => {
  const appearance = new AppearancePage(page, server.url, TOKEN);
  await appearance.open();
  await appearance.choosePreset("Nord");

  expect(await appearance.backgroundAtFirstPaint()).toBe("#2e3440");
  expect(await appearance.isDark()).toBe(true);
});

test("S7: Reset to default returns the Band look and keeps the mode", async ({ page }) => {
  const appearance = new AppearancePage(page, server.url, TOKEN);
  await appearance.open();
  await appearance.chooseMode("light");
  await appearance.choosePreset("GitHub");
  await appearance.setSize("ui", 20);
  await appearance.chooseFont("code", "Menlo");
  await expect(appearance.resetButton()).toBeEnabled();

  await appearance.reset();

  await expect(appearance.presetSelect()).toContainText("Band");
  await expect(appearance.uiSizeInput()).toHaveValue("16");
  await expect.poll(() => appearance.inlineVar("--background")).toBe("");
  await expect.poll(() => appearance.inlineVar("--font-code")).toBe("");
  await expect.poll(() => appearance.rootFontSizePx()).toBe(16);
  // The device's mode is not reset.
  expect(await appearance.isDark()).toBe(false);
  await expect(appearance.resetButton()).toBeDisabled();
});

async function signedInPage(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await context.newPage();
  return { context, page };
}
