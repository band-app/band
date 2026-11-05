/**
 * Switching worktrees with the mouse: the side buttons step worktree history,
 * and holding Cmd while scrolling opens the switcher, steps its highlight, and
 * opens the highlighted worktree when Cmd is released.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
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
import { TerminalSurface } from "./pages/TerminalSurface";
import { WorktreePage } from "./pages/WorktreePage";
import { WorktreePicker } from "./pages/WorktreePicker";

const TOKEN = "e2e-worktree-mouse-switching-token";
const BRANCH = "main";
const REPOS = ["mouse-nav-a", "mouse-nav-b", "mouse-nav-c"];
const [WT_A, WT_B, WT_C] = REPOS.map((r) => toWorktreeId(r, BRANCH, "local"));

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    repos: REPOS.map((name) => {
      const repoPath = join(tmpHome, name);
      mkdirSync(repoPath, { recursive: true });
      git(repoPath, ["init", "-b", BRANCH]);
      writeFileSync(join(repoPath, "README.md"), "# mouse switching\n");
      writeFileSync(
        join(repoPath, "long.txt"),
        `${Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n")}\n`,
      );
      git(repoPath, ["add", "."]);
      git(repoPath, ["commit", "-m", "initial"]);
      return {
        name,
        path: repoPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repoPath }],
      };
    }),
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

const urlFor = (id: string) => new RegExp(encodeURIComponent(id));

test("mouse back and forward buttons step worktree history", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WT_A);
  await worktreePage.waitForReady();
  await worktreePage.switchWorktree(WT_B);
  await expect(page).toHaveURL(urlFor(WT_B));

  await worktreePage.pressMouseSideButton("back");
  await expect(page).toHaveURL(urlFor(WT_A));
  await worktreePage.pressMouseSideButton("forward");
  await expect(page).toHaveURL(urlFor(WT_B));
});

type Platform = "mac" | "other";
const PLATFORMS: Array<[string, Platform]> = [
  ["Cmd (macOS)", "mac"],
  ["Alt (Windows and Linux)", "other"],
];

/** Make the page report macOS or another OS, so both modifier paths run on any CI machine. */
async function spoofPlatform(page: Page, platform: Platform): Promise<void> {
  await page.addInitScript((mac) => {
    Object.defineProperty(navigator, "userAgentData", { value: undefined, configurable: true });
    Object.defineProperty(navigator, "platform", {
      value: mac ? "MacIntel" : "Linux x86_64",
      configurable: true,
    });
  }, platform === "mac");
}

for (const [name, platform] of PLATFORMS) {
  test(`${name}: scroll opens the switcher, steps the highlight, and releasing the key opens it`, async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const picker = new WorktreePicker(page);
    await spoofPlatform(page, platform);
    await worktreePage.goto(WT_C);
    await worktreePage.waitForReady();

    await picker.holdModifier();
    await picker.wheel(100);
    await picker.waitVisible();
    await picker.expectOptionCount(3);
    const order = await picker.orderedWorktreeIds();
    await expect(picker.highlightedOption).toHaveAttribute(
      "data-testid",
      `worktree-picker__item--${order[1]}`,
    );

    await picker.wheel(100);
    await expect(picker.highlightedOption).toHaveAttribute(
      "data-testid",
      `worktree-picker__item--${order[2]}`,
    );
    // Clamped at the end of the list.
    await picker.wheel(300);
    await expect(picker.highlightedOption).toHaveAttribute(
      "data-testid",
      `worktree-picker__item--${order[2]}`,
    );

    await picker.releaseModifier();
    await expect(picker.dialog).toBeHidden();
    await expect(page).toHaveURL(urlFor(order[2]));
  });

  test(`${name}: Esc while holding the key cancels, and a keyboard-opened picker ignores the release`, async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const picker = new WorktreePicker(page);
    await spoofPlatform(page, platform);
    await worktreePage.goto(WT_C);
    await worktreePage.waitForReady();

    await picker.holdModifier();
    await picker.wheel(100);
    await picker.waitVisible();
    await page.keyboard.press("Escape");
    await expect(picker.dialog).toBeHidden();
    await picker.releaseModifier();
    await expect(page).toHaveURL(urlFor(WT_C));

    if (platform === "mac") await worktreePage.openWorktreePickerViaShortcut();
    else await worktreePage.openWorktreePickerViaCtrlShortcut();
    await picker.waitVisible();
    await picker.releaseModifier();
    await expect(picker.dialog).toBeVisible();
    await picker.typeQuery("mouse-nav-a");
    await expect(picker.input).toHaveValue("mouse-nav-a");
    await expect(page).toHaveURL(urlFor(WT_C));
  });

  test(`${name}: small trackpad deltas step once per threshold`, async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const picker = new WorktreePicker(page);
    await spoofPlatform(page, platform);
    await worktreePage.goto(WT_C);
    await worktreePage.waitForReady();

    await picker.holdModifier();
    await picker.wheel(100);
    await picker.waitVisible();
    const order = await picker.orderedWorktreeIds();

    // 4 x 10px is under the 50px step, so the highlight has not moved.
    for (let i = 0; i < 4; i++) await picker.wheel(10);
    await expect(picker.highlightedOption).toHaveAttribute(
      "data-testid",
      `worktree-picker__item--${order[1]}`,
    );
    // The fifth reaches 50px and steps exactly once.
    await picker.wheel(10);
    await expect(picker.highlightedOption).toHaveAttribute(
      "data-testid",
      `worktree-picker__item--${order[2]}`,
    );
    await picker.releaseModifier();
  });

  test(`${name}: over a terminal and an editor the switcher steps and the content stays put`, async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const picker = new WorktreePicker(page);
    const terminal = new TerminalSurface(page, WT_C);
    await spoofPlatform(page, platform);
    await worktreePage.goto(WT_C);
    await worktreePage.waitForReady();

    // Terminal with scrollback, viewport at the bottom.
    await worktreePage.focusTerminal();
    await page.keyboard.type("seq 1 300\n");
    await expect
      .poll(async () => (await terminal.readScrollPosition())?.baseY ?? 0)
      .toBeGreaterThan(50);
    const atBottom = async () => {
      const pos = await terminal.readScrollPosition();
      return pos !== null && pos.viewportY === pos.baseY;
    };
    expect(await atBottom()).toBe(true);
    await picker.holdModifier();
    // An upward wheel would scroll the scrollback if it reached the terminal.
    await picker.wheelOver(terminal.wrapper, -100);
    await picker.waitVisible();
    await picker.wheel(100);
    await expect(picker.highlightedOption).not.toHaveCount(0);
    expect(await atBottom()).toBe(true);
    await page.keyboard.press("Escape");
    await picker.releaseModifier();
    await expect(page).toHaveURL(urlFor(WT_C));

    // The editor, scrolled to the top of a long file.
    await worktreePage.goto(WT_C);
    await worktreePage.waitForReady();
    await worktreePage.openFileLeaf("long.txt", WT_C);
    expect(await worktreePage.editorScrollTop()).toBe(0);
    await picker.holdModifier();
    await picker.wheelOver(worktreePage.fileEditor(), 100);
    await picker.waitVisible();
    await picker.wheel(100);
    expect(await worktreePage.editorScrollTop()).toBe(0);
    await picker.releaseModifier();
  });

  test(`${name}: hover moves the highlight, click opens, and a window blur opens the highlighted row`, async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const picker = new WorktreePicker(page);
    await spoofPlatform(page, platform);
    await worktreePage.goto(WT_C);
    await worktreePage.waitForReady();

    await picker.holdModifier();
    await picker.wheel(100);
    await picker.waitVisible();
    const order = await picker.orderedWorktreeIds();
    await picker.item(order[2]).hover();
    await expect(picker.highlightedOption).toHaveAttribute(
      "data-testid",
      `worktree-picker__item--${order[2]}`,
    );
    await picker.blurWindow();
    await expect(picker.dialog).toBeHidden();
    await expect(page).toHaveURL(urlFor(order[2]));
    await picker.releaseModifier();

    // Click on a row opens it while the key is still held.
    await worktreePage.goto(WT_C);
    await worktreePage.waitForReady();
    await picker.holdModifier();
    await picker.wheel(100);
    await picker.waitVisible();
    const second = await picker.orderedWorktreeIds();
    await picker.item(second[1]).click();
    await expect(picker.dialog).toBeHidden();
    await expect(page).toHaveURL(urlFor(second[1]));
    await picker.releaseModifier();
  });
}
