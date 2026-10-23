/**
 * The sidebar's one list: groups with worktrees nested under the worktree they were started from.
 *
 * Real production hub against a temp `~/.band/`, with two real git repos. Team A holds app's main,
 * a parent with a child, and two lib worktrees (lib's main is in Team B, so they are top-level rows
 * of Team A). Tests read the layout from the sidebar and the stored result from `repos.list`.
 *
 * Covers: no group-by choice (S1), the collapse-all button (S9), aligned headers (S10), group
 * order (S11), top-level rows for worktrees with no group after the last group (S12), the row indent,
 * chevron and section gaps (S13), the group filter leaving the layout alone (S2), "New group…" in
 * the filter (S3), dropping a worktree on another (S4), the refusals and the top-level gap (S5) and
 * the drag preview being the row's own card (S6).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gitInHome } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcMutate, trpcQuery } from "./helpers/trpc";
import { SidebarGroupsPage } from "./pages/SidebarGroupsPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-sidebar-grouping-token";
const TEAM_A = "team-a";
const TEAM_B = "team-b";

test.use({ viewport: { width: 1280, height: 900 } });
test.describe.configure({ mode: "serial" });

let server: ServerHandle;
let tmpHome: string;

interface Placement {
  origin: string | null;
  groupId: string | null;
}

async function placements(): Promise<Record<string, Placement>> {
  const { repos } = await trpcQuery<{
    repos: {
      worktrees: {
        worktreeId: string;
        groupId: string | null;
        origin: { worktreeId: string } | null;
      }[];
    }[];
  }>(server.url, TOKEN, "repos.list");
  return Object.fromEntries(
    repos.flatMap((r) =>
      r.worktrees.map((w) => [
        w.worktreeId,
        { origin: w.origin?.worktreeId ?? null, groupId: w.groupId },
      ]),
    ),
  );
}

const LAYOUT: Record<string, Placement> = {
  "app-main": { origin: null, groupId: TEAM_A },
  "app-parent": { origin: null, groupId: TEAM_A },
  "app-kid": { origin: "app-parent", groupId: TEAM_A },
  "lib-main": { origin: null, groupId: TEAM_B },
  "lib-x": { origin: null, groupId: TEAM_A },
  "lib-y": { origin: null, groupId: TEAM_A },
};

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const makeRepo = (name: string) => {
    const path = join(tmpHome, name);
    mkdirSync(path, { recursive: true });
    gitInHome(path, ["init", "-b", "main"], tmpHome);
    writeFileSync(join(path, "README.md"), `# ${name}\n`);
    gitInHome(path, ["add", "."], tmpHome);
    gitInHome(path, ["commit", "-m", "initial"], tmpHome);
    return path;
  };
  const extra = (repoPath: string, branch: string) => {
    const path = join(tmpHome, `${branch}-checkout`);
    gitInHome(repoPath, ["worktree", "add", "-b", branch, path], tmpHome);
    return path;
  };
  const app = makeRepo("app");
  const lib = makeRepo("lib");
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  seedState(tmpHome, {
    groups: [
      { id: TEAM_A, name: "Team A", color: "#8b5cf6" },
      { id: TEAM_B, name: "Team B", color: "#3b82f6" },
    ],
    repos: [
      {
        name: "app",
        path: app,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: app, groupId: TEAM_A },
          { branch: "parent", path: extra(app, "parent"), groupId: TEAM_A },
          { branch: "kid", path: extra(app, "kid"), groupId: TEAM_A, origin: "app-parent" },
        ],
      },
      {
        name: "lib",
        path: lib,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: lib, groupId: TEAM_B },
          { branch: "x", path: extra(lib, "x"), groupId: TEAM_A },
          { branch: "y", path: extra(lib, "y"), groupId: TEAM_A },
        ],
      },
    ],
  });
  server = await startServer({ tmpHome });
});

test.beforeEach(async () => {
  resetClientState(tmpHome);
  // Put every worktree and group back, so a test does not depend on the one before it.
  const { groups } = await trpcQuery<{ groups: { id: string }[] }>(
    server.url,
    TOKEN,
    "groups.list",
  );
  for (const group of groups) {
    if (group.id !== TEAM_A && group.id !== TEAM_B) {
      await trpcMutate(server.url, TOKEN, "groups.remove", { id: group.id });
    }
  }
  await trpcMutate(server.url, TOKEN, "groups.reorder", { ids: [TEAM_A, TEAM_B] });
  for (const id of Object.keys(LAYOUT)) {
    const [repo, ...rest] = id.split("-");
    await trpcMutate(server.url, TOKEN, "worktrees.setPinned", {
      repo,
      name: rest.join("-"),
      pinned: false,
    });
  }
  const toWorktree = (id: string) => {
    const [repo, ...rest] = id.split("-");
    return { repo, name: rest.join("-") };
  };
  for (const [id, want] of Object.entries(LAYOUT)) {
    await trpcMutate(server.url, TOKEN, "worktrees.setOrigin", {
      ...toWorktree(id),
      origin: want.origin,
    });
    await trpcMutate(server.url, TOKEN, "worktrees.setGroup", {
      worktreeId: id,
      groupId: want.groupId,
    });
  }
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

async function open(page: import("@playwright/test").Page, worktreeId = "app-main") {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(worktreeId);
  await worktreePage.waitForReady();
  return { sidebar: new SidebarGroupsPage(page), worktreePage };
}

test("S1: groups are collapsible headers, children nest under their parent, and there is no group-by choice", async ({
  page,
}) => {
  const { sidebar } = await open(page);
  await expect(sidebar.groupByTrigger).toHaveCount(0);
  await expect
    .poll(() => sidebar.sections())
    .toMatchObject({
      [TEAM_A]: ["0:app-main", "1:app-parent", "2:app-kid", "0:lib-x", "0:lib-y"],
      [TEAM_B]: ["0:lib-main"],
    });
  await expect(sidebar.row("app-kid")).toContainText("app");
  await sidebar.groupHeader(TEAM_A).click();
  await expect(sidebar.groupHeader(TEAM_A)).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.row("app-kid")).toHaveCount(0);
  await sidebar.groupHeader(TEAM_A).click();
  await expect(sidebar.row("app-kid")).toBeVisible();
});

test("S2: filtering to one group keeps the header, the collapse control and the indent", async ({
  page,
}) => {
  const { sidebar, worktreePage } = await open(page);
  const indentOf = async (id: string) => (await sidebar.card(id).boundingBox())?.x ?? -1;
  const all = {
    kid: await indentOf("app-kid"),
    parent: await indentOf("app-parent"),
    header: (await sidebar.groupHeader(TEAM_A).boundingBox())?.x ?? -1,
  };
  const orderAll = (await sidebar.sections())[TEAM_A];

  await worktreePage.selectGroupFilter(TEAM_A);
  await expect(sidebar.groupHeader(TEAM_B)).toHaveCount(0);
  await expect(sidebar.row("lib-main")).toHaveCount(0);
  await expect(sidebar.groupHeader(TEAM_A)).toBeVisible();
  expect(await sidebar.sections()).toEqual({ __ungrouped: [], [TEAM_A]: orderAll });
  expect(await indentOf("app-kid")).toBe(all.kid);
  expect(await indentOf("app-parent")).toBe(all.parent);
  expect((await sidebar.groupHeader(TEAM_A).boundingBox())?.x).toBe(all.header);

  // The header collapses the filtered group too.
  await sidebar.groupHeader(TEAM_A).click();
  await expect(sidebar.groupHeader(TEAM_A)).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.row("app-kid")).toHaveCount(0);
  await sidebar.groupHeader(TEAM_A).click();
  await expect(sidebar.row("app-kid")).toBeVisible();
});

test("S3: the group filter lists All, the groups and New group…, which creates a group", async ({
  page,
}) => {
  const { sidebar, worktreePage } = await open(page);
  await worktreePage.openGroupFilter();
  await expect(worktreePage.groupFilterItem(null)).toBeVisible();
  await expect(worktreePage.groupFilterItem(TEAM_A)).toBeVisible();
  await expect(worktreePage.groupFilterItem(TEAM_B)).toBeVisible();
  await expect(sidebar.newGroupMenuItem).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(worktreePage.groupFilterMenu).toHaveCount(0);

  await sidebar.createGroup("Fresh");
  await expect.poll(async () => (await sidebar.headerOrder()).length).toBe(3);
  await worktreePage.openGroupFilter();
  await expect(worktreePage.groupFilterMenu.getByRole("menuitem", { name: /Fresh/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(worktreePage.groupFilterMenu).toHaveCount(0);
});

test("S4: dropping a worktree on another makes it a child in that worktree's group, and it stays after a reload", async ({
  page,
}) => {
  const { sidebar } = await open(page);
  await sidebar.dragToWorktree("lib-x", "lib-main", "middle");
  await expect
    .poll(async () => (await placements())["lib-x"])
    .toEqual({
      origin: "lib-main",
      groupId: TEAM_B,
    });
  await expect
    .poll(() => sidebar.sections())
    .toMatchObject({ [TEAM_B]: ["0:lib-main", "1:lib-x"] });
  await sidebar.reload();
  await expect.poll(() => sidebar.depthOf("lib-x")).toBe(1);
  await expect(sidebar.row("lib-x")).toBeVisible();
});

test("S5: a drop onto a descendant is refused, and the gap beside a top-level row clears the parent", async ({
  page,
}) => {
  const { sidebar } = await open(page);
  await sidebar.dragToWorktree("lib-x", "lib-main", "middle");
  await expect.poll(async () => (await placements())["lib-x"]?.origin).toBe("lib-main");
  await expect(sidebar.row("lib-x")).toHaveAttribute("data-depth", "1");

  // lib-main can't become a child of lib-x, which was started from it.
  await sidebar.dragToWorktree("lib-main", "lib-x", "middle");
  await expect(sidebar.dropRefusal).toBeVisible();
  expect((await placements())["lib-main"]).toEqual({ origin: null, groupId: TEAM_B });
  await sidebar.dismissRefusal();

  // A drop onto the dragged worktree itself changes nothing.
  await sidebar.dragToWorktree("lib-x", "lib-x", "middle");
  expect((await placements())["lib-x"]?.origin).toBe("lib-main");

  // The gap below a top-level row clears the parent.
  await sidebar.dragToWorktree("lib-x", "lib-main", "bottom");
  await expect.poll(async () => (await placements())["lib-x"]?.origin).toBeNull();
});

test("S6: the drag preview is the row's own card, and the target shows the drop", async ({
  page,
}, testInfo) => {
  const { sidebar } = await open(page);
  await sidebar.holdDrag(sidebar.row("lib-x"), sidebar.row("lib-main"));
  await expect(sidebar.dragPreview).toBeVisible();
  const previewCard = sidebar.previewCard("lib-x");
  await expect(previewCard).toBeVisible();
  const rowCard = sidebar.rowCard("lib-x");
  const [a, b] = await Promise.all([previewCard.boundingBox(), rowCard.boundingBox()]);
  expect(a?.height).toBeCloseTo(b?.height ?? -1, 0);
  expect(a?.width).toBeCloseTo(b?.width ?? -1, 0);
  await expect(sidebar.dropTarget("lib-main")).toHaveAttribute("data-drop-zone", "into");
  await testInfo.attach("drag-preview.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await sidebar.dropHeld();
  await expect.poll(async () => (await placements())["lib-x"]?.origin).toBe("lib-main");
});

const pin = (repo: string, name: string) =>
  trpcMutate(server.url, TOKEN, "worktrees.setPinned", { repo, name, pinned: true });

async function groupOrder(): Promise<string[]> {
  const { groups } = await trpcQuery<{ groups: { id: string }[] }>(
    server.url,
    TOKEN,
    "groups.list",
  );
  return groups.map((g) => g.id);
}

test("S9: the toggle folds every group and parent, then unfolds them, in All", async ({ page }) => {
  await pin("lib", "y");
  const { sidebar } = await open(page);
  await expect(sidebar.toggleAllButton).toHaveAttribute("aria-label", "Collapse all");

  await sidebar.clickToggleAll();
  await expect(sidebar.toggleAllButton).toHaveAttribute("aria-label", "Expand all");
  for (const id of [TEAM_A, TEAM_B]) {
    await expect(sidebar.groupHeader(id)).toHaveAttribute("aria-expanded", "false");
  }
  await expect(sidebar.pinnedHeader).toHaveAttribute("aria-expanded", "false");

  // Opening one group by hand shows its parents folded too, and leaves the button on "Collapse all".
  await sidebar.groupHeader(TEAM_A).click();
  await expect(sidebar.originToggle("app-main")).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.row("app-parent")).toHaveCount(0);
  await expect(sidebar.toggleAllButton).toHaveAttribute("aria-label", "Collapse all");

  // From that mixed state one click folds everything, the next unfolds everything.
  await sidebar.clickToggleAll();
  await expect(sidebar.toggleAllButton).toHaveAttribute("aria-label", "Expand all");
  await expect(sidebar.groupHeader(TEAM_A)).toHaveAttribute("aria-expanded", "false");
  await sidebar.clickToggleAll();
  await expect(sidebar.toggleAllButton).toHaveAttribute("aria-label", "Collapse all");
  for (const id of [TEAM_A, TEAM_B]) {
    await expect(sidebar.groupHeader(id)).toHaveAttribute("aria-expanded", "true");
  }
  await expect(sidebar.pinnedHeader).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar.originToggle("app-parent")).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar.row("app-kid")).toBeVisible();
});

test("S9: with one group filtered the toggle folds that group, and a hidden group keeps its state", async ({
  page,
}) => {
  const { sidebar, worktreePage } = await open(page);
  await worktreePage.selectGroupFilter(TEAM_A);
  await sidebar.clickToggleAll();
  await expect(sidebar.toggleAllButton).toHaveAttribute("aria-label", "Expand all");
  await expect(sidebar.groupHeader(TEAM_A)).toHaveAttribute("aria-expanded", "false");

  await worktreePage.selectGroupFilter(null);
  await expect(sidebar.groupHeader(TEAM_A)).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.groupHeader(TEAM_B)).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar.toggleAllButton).toHaveAttribute("aria-label", "Collapse all");

  await worktreePage.selectGroupFilter(TEAM_A);
  await sidebar.clickToggleAll();
  await expect(sidebar.groupHeader(TEAM_A)).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar.originToggle("app-parent")).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar.toggleAllButton).toHaveAttribute("aria-label", "Collapse all");
});

test("S10: every group header and the Pinned header share one left edge, and rows nest under their group", async ({
  page,
}) => {
  await pin("lib", "y");
  const { sidebar, worktreePage } = await open(page);
  const edge = await sidebar.leftEdge(sidebar.pinnedHeader);
  expect(await sidebar.leftEdge(sidebar.groupHeader(TEAM_A))).toBe(edge);
  expect(await sidebar.leftEdge(sidebar.groupHeader(TEAM_B))).toBe(edge);
  expect(await sidebar.leftEdge(sidebar.card("lib-main"))).toBeGreaterThan(edge);
  expect(await sidebar.leftEdge(sidebar.card("app-kid"))).toBeGreaterThan(
    await sidebar.leftEdge(sidebar.card("app-parent")),
  );

  await worktreePage.selectGroupFilter(TEAM_A);
  expect(await sidebar.leftEdge(sidebar.groupHeader(TEAM_A))).toBe(
    await sidebar.leftEdge(sidebar.pinnedHeader),
  );
});

test("S12: worktrees with no group are plain top-level rows below the groups, and dragging there ungroups", async ({
  page,
}) => {
  const { sidebar, worktreePage } = await open(page);
  await trpcMutate(server.url, TOKEN, "worktrees.setGroup", { worktreeId: "lib-y", groupId: null });
  await expect.poll(() => sidebar.sections()).toMatchObject({ __ungrouped: ["0:lib-y"] });
  await expect(sidebar.groupHeader("__ungrouped")).toHaveCount(0);
  expect(await sidebar.leftEdge(sidebar.row("lib-y"))).toBe(
    await sidebar.leftEdge(sidebar.groupHeader(TEAM_A)),
  );
  // After the last group's last row, with nothing between them.
  const row = await sidebar.box(sidebar.row("lib-y"));
  const lastGroupRow = await sidebar.box(sidebar.row("lib-main"));
  expect(row.y).toBeGreaterThan(lastGroupRow.y);
  const rowGap = row.y - (lastGroupRow.y + lastGroupRow.height);
  expect(rowGap).toBeGreaterThanOrEqual(-1);
  expect(rowGap).toBeLessThanOrEqual(4);

  await worktreePage.selectGroupFilter(TEAM_A);
  await expect(sidebar.row("lib-y")).toHaveCount(0);
  await worktreePage.selectGroupFilter(null);

  // A worktree dragged to the top level leaves its group, and a parent that is in a group.
  await sidebar.dragToTopLevel("app-kid", "lib-y");
  await expect
    .poll(async () => (await placements())["app-kid"])
    .toEqual({
      origin: null,
      groupId: null,
    });
  await expect(sidebar.row("app-kid")).toBeVisible();
});

test("S12: with every worktree in a group, the strip below the last group ungroups a dragged worktree", async ({
  page,
}) => {
  const { sidebar } = await open(page);
  await expect(sidebar.topLevelDrop).toBeVisible();
  const strip = await sidebar.box(sidebar.topLevelDrop);
  const lastGroupRow = await sidebar.box(sidebar.row("lib-main"));
  expect(strip.y).toBeGreaterThan(lastGroupRow.y);

  await sidebar.dragToTopLevel("app-kid");
  await expect
    .poll(async () => (await placements())["app-kid"])
    .toEqual({ origin: null, groupId: null });
  await expect.poll(() => sidebar.sections()).toMatchObject({ __ungrouped: ["0:app-kid"] });
  await expect(sidebar.topLevelDrop).toHaveCount(0);
});

test("S11: groups reorder by dragging a header and from the header menu, and the filter follows", async ({
  page,
}) => {
  const { sidebar, worktreePage } = await open(page);
  await sidebar.dragGroup(TEAM_B, TEAM_A, "top");
  await expect.poll(groupOrder).toEqual([TEAM_B, TEAM_A]);
  await expect.poll(() => sidebar.headerOrder()).toEqual([TEAM_B, TEAM_A]);
  await sidebar.reload();
  await expect.poll(() => sidebar.headerOrder()).toEqual([TEAM_B, TEAM_A]);
  await worktreePage.openGroupFilter();
  await expect(worktreePage.groupFilterMenu.getByRole("menuitem")).toHaveText([
    /All/,
    /Team B.*1/,
    /Team A.*2/,
    /New group/,
  ]);
  await page.keyboard.press("Escape");
  await expect(worktreePage.groupFilterMenu).toHaveCount(0);

  // The first group can't move up, and the menu moves the other one.
  await sidebar.openGroupMenu(TEAM_B);
  await expect(sidebar.moveMenuItem("up")).toBeDisabled();
  await page.keyboard.press("Escape");
  await sidebar.moveGroupFromMenu(TEAM_B, "down");
  await expect.poll(groupOrder).toEqual([TEAM_A, TEAM_B]);
  await sidebar.openGroupMenu(TEAM_B);
  await expect(sidebar.moveMenuItem("down")).toBeDisabled();
  await page.keyboard.press("Escape");
});

test("Set parent and Remove parent in the card menu nest and un-nest a worktree, and the list follows keys", async ({
  page,
}) => {
  const { sidebar } = await open(page);
  await sidebar.openSetParent(sidebar.row("lib-y"));
  await sidebar.chooseParent("lib-main", "lib-main");
  await expect.poll(async () => (await placements())["lib-y"]?.origin).toBe("lib-main");
  await sidebar.removeParent(sidebar.row("lib-y"));
  await expect.poll(async () => (await placements())["lib-y"]?.origin).toBeNull();

  // Arrow keys step through the rows in display order and Enter opens the highlighted one.
  await sidebar.row("app-main").click();
  await sidebar.openNextRowWithKeyboard();
  await expect(page).toHaveURL(/\/worktree\/app-parent/);
});

test("the group filter narrows the Pinned section to the selected group", async ({ page }) => {
  await pin("lib", "y");
  await pin("lib", "main");
  const { sidebar, worktreePage } = await open(page);
  await worktreePage.selectGroupFilter(TEAM_A);
  await expect(sidebar.pinnedRow("lib-y")).toBeVisible();
  await expect(sidebar.pinnedRow("lib-main")).toHaveCount(0);
});

test("S13: rows sit under the group name, the chevron is small and close, and Pinned is spaced like a group", async ({
  page,
}, testInfo) => {
  await pin("lib", "y");
  const { sidebar } = await open(page);
  await expect(sidebar.pinnedRow("lib-y")).toBeVisible();

  // A top-level row's dot starts where the group's name starts, and a child's under its parent's name.
  const name = await sidebar.box(sidebar.groupName(TEAM_A));
  const mainDot = await sidebar.box(sidebar.statusDot(sidebar.row("app-main")));
  expect(Math.abs(mainDot.x - name.x)).toBeLessThanOrEqual(2);
  const parentDot = await sidebar.box(sidebar.statusDot(sidebar.row("app-parent")));
  const kidDot = await sidebar.box(sidebar.statusDot(sidebar.row("app-kid")));
  expect(kidDot.x - parentDot.x).toBeCloseTo(parentDot.x - mainDot.x, 0);
  expect(parentDot.x - mainDot.x).toBeGreaterThanOrEqual(12);
  expect(parentDot.x - mainDot.x).toBeLessThanOrEqual(16);

  // The chevron icon is at most 12px, ends within 5px of the dot without covering it, and keeps a
  // 20px hit area.
  const icon = await sidebar.box(sidebar.originToggleIcon("app-parent"));
  const button = await sidebar.box(sidebar.originToggle("app-parent"));
  expect(icon.width).toBeLessThanOrEqual(12);
  const chevronGap = parentDot.x - (icon.x + icon.width);
  expect(chevronGap).toBeGreaterThanOrEqual(0);
  expect(chevronGap).toBeLessThanOrEqual(5);
  expect(button.width).toBeGreaterThanOrEqual(20);
  expect(button.height).toBeGreaterThanOrEqual(20);
  await sidebar.originToggle("app-parent").click();
  await expect(sidebar.row("app-kid")).toHaveCount(0);
  await expect(sidebar.originToggle("app-parent")).toHaveAttribute("aria-expanded", "false");
  await sidebar.originToggle("app-parent").click();
  await expect(sidebar.row("app-kid")).toBeVisible();

  // The gap from the last pin to the first group header is the gap between two groups.
  const lastPin = await sidebar.box(sidebar.pinnedRow("lib-y"));
  const headerA = await sidebar.box(sidebar.groupHeader(TEAM_A));
  const lastRowA = await sidebar.box(sidebar.row("lib-x"));
  const headerB = await sidebar.box(sidebar.groupHeader(TEAM_B));
  const pinnedGap = headerA.y - (lastPin.y + lastPin.height);
  const groupGap = headerB.y - (lastRowA.y + lastRowA.height);
  expect(Math.abs(pinnedGap - groupGap)).toBeLessThanOrEqual(2);

  await testInfo.attach("sidebar-spacing.png", {
    body: await sidebar.root.screenshot(),
    contentType: "image/png",
  });
});

test("S11: a second device sees the new group order", async ({ page, browser }) => {
  const { sidebar } = await open(page);
  await sidebar.dragGroup(TEAM_B, TEAM_A, "top");
  await expect.poll(groupOrder).toEqual([TEAM_B, TEAM_A]);
  const other = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const otherPage = await other.newPage();
  const { sidebar: otherSidebar } = await open(otherPage);
  await expect.poll(() => otherSidebar.headerOrder()).toEqual([TEAM_B, TEAM_A]);
  await other.close();
});
