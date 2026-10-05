/**
 * The center tab strip scrolls sideways instead of offering a hidden-tabs
 * dropdown, and on a touch screen a finger drag scrolls it rather than
 * switching tabs.
 *
 *  1. Desktop: with more tabs than fit, dockview's "N hidden tabs" dropdown is
 *     gone and a horizontal trackpad swipe scrolls the strip. dockview's own
 *     scroller hid the list's overflow and read only vertical wheel deltas, so
 *     the swipe used to do nothing.
 *  2. Phone (touch emulation): a finger drag that starts on a tab scrolls the
 *     strip and leaves the active tab alone; a tap still switches tabs.
 *     dockview activates a tab on pointerdown, so the drag used to switch to
 *     the tab under the finger and never scrolled.
 *  3. Size: on a phone each tab, the "+" and the ⋮ button is at least 44px tall,
 *     iOS's minimum tap target; the desktop strip stays 38px, the height of
 *     the window's title bar row.
 *
 * Each file holds its own name, so the editor line that is visible tells which
 * tab is active. Real production binary, no tRPC mocks, page objects only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { gitInHome as git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { CenterTabStrip } from "./pages/CenterTabStrip";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-center-tab-strip-scroll-token";
const REPO = "tab-strip-scroll-repo";
const BRANCH = "main";
const WORKTREE = toWorktreeId(REPO, BRANCH);
const FILES = Array.from({ length: 10 }, (_, i) => `tab-strip-file-number-${i}.txt`);

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repo = join(tmpHome, REPO);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", BRANCH]);
  for (const file of FILES) writeFileSync(join(repo, file), `${file}\n`);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repo,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repo }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

// UI state lives on the server now: start each test from none, like the
// fresh localStorage each test's browser context used to give it.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("an overflowing tab strip has no hidden-tabs dropdown and scrolls with a trackpad swipe", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const strip = new CenterTabStrip(page);
    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForReady();
    for (const file of FILES) await worktreePage.openFileViaQuickOpen(file);

    // Anchor: the tabs really overflow the strip, so dockview would have shown
    // its dropdown here.
    await expect.poll(async () => (await strip.readScroll()).maxScrollLeft).toBeGreaterThan(200);
    await expect(strip.overflowDropdown).toHaveCount(0);

    // Every tab is reachable by swiping: the first file at the left end, the
    // last at the right end.
    await strip.trackpadSwipe(-5000);
    await expect.poll(() => strip.isTabFullyShown(worktreePage.fileTab(FILES[0]))).toBe(true);
    await strip.trackpadSwipe(5000);
    await expect
      .poll(() => strip.isTabFullyShown(worktreePage.fileTab(FILES[FILES.length - 1])))
      .toBe(true);
    await expect.poll(() => strip.isTabFullyShown(worktreePage.fileTab(FILES[0]))).toBe(false);
  });

  test("the tab strip keeps the window's 38px title bar height", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const strip = new CenterTabStrip(page);
    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForReady();
    await worktreePage.openFileViaQuickOpen(FILES[0]);
    await expect(worktreePage.fileTab(FILES[0])).toBeVisible();

    expect((await strip.strip.boundingBox())?.height).toBe(38);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a finger drag on the tab strip scrolls it without switching tabs, and a tap switches", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const strip = new CenterTabStrip(page);
    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForMobileReady();
    for (const file of FILES.slice(0, 5)) await worktreePage.openFileViaQuickOpen(file);

    // The first file is the active tab, and the strip has room to scroll right.
    await strip.tap(worktreePage.fileTab(FILES[0]));
    await expect(worktreePage.fileLeafLine(FILES[0])).toBeVisible();
    await expect
      .poll(async () => {
        const { scrollLeft, maxScrollLeft } = await strip.readScroll();
        return maxScrollLeft - scrollLeft;
      })
      .toBeGreaterThan(100);
    const before = (await strip.readScroll()).scrollLeft;

    // Start the drag on a different, inactive tab: before the fix that tab
    // became active on touch-down.
    await strip.touchSwipe(worktreePage.fileTab(FILES[1]), 200);

    await expect
      .poll(async () => (await strip.readScroll()).scrollLeft)
      .toBeGreaterThan(before + 50);
    await expect(worktreePage.fileLeafLine(FILES[0])).toBeVisible();
    await expect(worktreePage.fileLeafLine(FILES[1])).toHaveCount(0);

    await strip.tap(worktreePage.fileTab(FILES[2]));
    await expect(worktreePage.fileLeafLine(FILES[2])).toBeVisible();
  });

  test("each tab and the strip's buttons are at least 44px tall", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const strip = new CenterTabStrip(page);
    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForMobileReady();
    await worktreePage.openFileViaQuickOpen(FILES[0]);
    await worktreePage.openFileViaQuickOpen(FILES[1]);
    await expect(worktreePage.fileLeafLine(FILES[1])).toBeVisible();

    // The active and an inactive tab.
    for (const file of FILES.slice(0, 2)) {
      expect(await strip.readTabTapHeight(worktreePage.fileTab(file))).toBeGreaterThanOrEqual(44);
    }
    for (const button of [strip.newTabButton, strip.tabActionsButton]) {
      const box = await button.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
    }
  });

  test("tapping a tab's close button closes that tab", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const strip = new CenterTabStrip(page);
    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForMobileReady();
    await worktreePage.openFileViaQuickOpen(FILES[0]);
    await worktreePage.openFileViaQuickOpen(FILES[1]);
    await expect(worktreePage.fileLeafLine(FILES[1])).toBeVisible();

    await strip.tap(worktreePage.fileTabCloseButton(FILES[1]));

    await expect(worktreePage.fileLeafLine(FILES[0])).toBeVisible();
    await expect(worktreePage.fileTab(FILES[1])).toHaveCount(0);
  });
});
