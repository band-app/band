/**
 * Dragging tabs and splits in the center layout.
 *
 *  - A tab dragged along its strip reorders.
 *  - A tab dropped on a group's edge splits it in that direction.
 *  - A tab dropped on another group's strip or center moves there.
 *  - Closing a group's last tab removes the group.
 *  - Dragging is off on a phone.
 *  - A sash resizes the groups next to it, within a minimum size, and the sizes
 *    survive a reload.
 *
 * File tabs are pure client views, so they need no server records. Real
 * production binary, no tRPC mocks, page objects only.
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
import { CenterLayout } from "./pages/CenterLayout";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-center-layout-drag-token";
const REPO = "layout-drag-repo";
const BRANCH = "main";
const WORKTREE = toWorktreeId(REPO, BRANCH, "local");
const FILES = ["drag-a.txt", "drag-b.txt", "drag-c.txt"];
const ID = (file: string) => `file:${file}`;

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

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

/** The file tabs of group `index`, in order. */
async function fileTabs(layout: CenterLayout, index: number): Promise<string[]> {
  return (await layout.tabIds(index)).filter((id) => id.startsWith("file:"));
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1400, height: 800 } });

  async function openThreeFiles(page: import("@playwright/test").Page) {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const layout = new CenterLayout(page);
    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForReady();
    for (const file of FILES) await worktreePage.openFileViaQuickOpen(file);
    await expect.poll(() => fileTabs(layout, 0)).toEqual(FILES.map(ID));
    return { worktreePage, layout };
  }

  test("dragging a tab along the strip reorders it", async ({ page }) => {
    const { layout } = await openThreeFiles(page);

    await layout.dragTab(ID(FILES[2]), 0, "tabs-start");

    await expect
      .poll(() => fileTabs(layout, 0))
      .toEqual([ID(FILES[2]), ID(FILES[0]), ID(FILES[1])]);
    await expect(layout.groups).toHaveCount(1);
    // The dragged tab is the selected one.
    await expect(layout.tab(ID(FILES[2]))).toHaveAttribute("data-selected", "true");
  });

  test("dropping a tab on a group's edge splits it in that direction", async ({ page }) => {
    const { layout } = await openThreeFiles(page);

    await layout.dragTab(ID(FILES[1]), 0, "right", { release: false });
    // The drop zone shows while the tab is over the edge.
    await expect(layout.dropIndicator).toHaveAttribute("data-zone", "right");
    await layout.releaseDrag();

    await expect(layout.groups).toHaveCount(2);
    expect(await fileTabs(layout, 0)).toEqual([ID(FILES[0]), ID(FILES[2])]);
    expect(await fileTabs(layout, 1)).toEqual([ID(FILES[1])]);
    // The new group is to the right of the first.
    const [left, right] = await Promise.all([
      layout.groups.nth(0).boundingBox(),
      layout.groups.nth(1).boundingBox(),
    ]);
    expect((right?.x ?? 0) > (left?.x ?? 0)).toBe(true);
    expect(Math.abs((right?.y ?? 0) - (left?.y ?? 1))).toBeLessThan(2);

    // Dropping on the bottom edge of the first group nests a stack under it.
    await layout.dragTab(ID(FILES[2]), 0, "bottom");
    await expect(layout.groups).toHaveCount(3);
    const [top, bottom] = await Promise.all([
      layout.groups.nth(0).boundingBox(),
      layout.groups.nth(1).boundingBox(),
    ]);
    expect((bottom?.y ?? 0) > (top?.y ?? 0)).toBe(true);
    expect(Math.abs((bottom?.x ?? 0) - (top?.x ?? 1))).toBeLessThan(2);
  });

  test("dropping a tab on another group's strip or center moves it there", async ({ page }) => {
    const { layout } = await openThreeFiles(page);
    await layout.dragTab(ID(FILES[1]), 0, "right");
    await expect(layout.groups).toHaveCount(2);

    // Group 0's strip: the tab joins it at the end, and its emptied group goes.
    await layout.dragTab(ID(FILES[1]), 0, "tabs-end");
    await expect(layout.groups).toHaveCount(1);
    expect(await fileTabs(layout, 0)).toEqual([ID(FILES[0]), ID(FILES[2]), ID(FILES[1])]);

    // Split again, then move a tab onto the other group's content (center).
    await layout.dragTab(ID(FILES[2]), 0, "right");
    await expect(layout.groups).toHaveCount(2);
    await layout.dragTab(ID(FILES[0]), 1, "center");
    await expect.poll(() => fileTabs(layout, 1)).toEqual([ID(FILES[2]), ID(FILES[0])]);
    expect(await fileTabs(layout, 0)).toEqual([ID(FILES[1])]);
  });

  test("closing the last tab of a group removes the group", async ({ page }) => {
    const { worktreePage, layout } = await openThreeFiles(page);
    await layout.whileSynced(() => layout.dragTab(ID(FILES[1]), 0, "right"));
    await expect(layout.groups).toHaveCount(2);

    await worktreePage.fileTabCloseButton(FILES[1]).click();

    await expect(layout.groups).toHaveCount(1);
    await expect(layout.sashes).toHaveCount(0);
    expect(await fileTabs(layout, 0)).toEqual([ID(FILES[0]), ID(FILES[2])]);
  });

  test("a sash resizes the groups beside it within a minimum size, and the size survives a reload", async ({
    page,
  }) => {
    const { worktreePage, layout } = await openThreeFiles(page);
    await layout.dragTab(ID(FILES[1]), 0, "right");
    await expect(layout.groups).toHaveCount(2);
    await expect(layout.sashes).toHaveCount(1);

    const before = await layout.groupWidth(0);
    const total = before + (await layout.groupWidth(1));
    await layout.dragSash(0, { dx: 150 });
    const after = await layout.groupWidth(0);
    expect(Math.abs(after - (before + 150))).toBeLessThan(3);

    // A sash can't push a group under its minimum width.
    await layout.dragSash(0, { dx: -5000 });
    const smallest = await layout.groupWidth(0);
    expect(smallest).toBeGreaterThanOrEqual(99);
    expect(smallest).toBeLessThan(110);
    expect(Math.abs(smallest + (await layout.groupWidth(1)) - total)).toBeLessThan(3);

    await layout.dragSash(0, { dx: 200 });
    const resized = await layout.groupWidth(0);
    // The write is debounced, and a page hide flushes it.
    await worktreePage.reload();
    await worktreePage.waitForReady();
    await expect(layout.groups).toHaveCount(2);
    await expect.poll(async () => Math.abs((await layout.groupWidth(0)) - resized)).toBeLessThan(3);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("tabs can't be dragged", async ({ page }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    const layout = new CenterLayout(page);
    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForMobileReady();
    for (const file of FILES) await worktreePage.openFileViaQuickOpen(file);
    await expect.poll(() => fileTabs(layout, 0)).toEqual(FILES.map(ID));

    await layout.dragTab(ID(FILES[2]), 0, "left", { release: false });
    await expect(layout.dropIndicator).toHaveCount(0);
    await layout.releaseDrag();

    await expect(layout.groups).toHaveCount(1);
    expect(await fileTabs(layout, 0)).toEqual(FILES.map(ID));
  });
});
