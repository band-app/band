/**
 * The sidebar's group list (worktree groups replaced repo labels).
 *
 * Real production hub against a temp `~/.band/`, with two real git repos. Three groups are seeded
 * (Alpha, Beta, and none for Ungrouped), and Alpha holds a parent worktree with two children. The
 * tests drag cards onto group headers with the mouse, use the header menus and the "+" on a header,
 * and read the result back from the sidebar itself and from `repos.list`.
 *
 * Covers: the view's order and tree (S6), moving a worktree with its children and alone, the
 * "from <parent>" chip, moving to Ungrouped, renaming, recoloring and deleting from a header,
 * creating a group, and a new worktree landing in the filtered group (S7).
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
import { trpcMutate, trpcMutateData, trpcQuery } from "./helpers/trpc";
import { SidebarGroupsPage, UNGROUPED } from "./pages/SidebarGroupsPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-sidebar-groups-token";
const ALPHA = "g-alpha";
const BETA = "g-beta";

// The initial layout: every worktree id with its group.
const LAYOUT: Record<string, string | null> = {
  "app-main": ALPHA,
  "app-parent": ALPHA,
  "app-kidone": ALPHA,
  "app-kidtwo": ALPHA,
  "lib-main": BETA,
  "lib-loose": null,
};

test.use({ viewport: { width: 1280, height: 800 } });
test.describe.configure({ mode: "serial" });

let server: ServerHandle;
let tmpHome: string;

async function groupsOf(): Promise<Record<string, string | null>> {
  const { repos } = await trpcQuery<{
    repos: { worktrees: { worktreeId: string; groupId: string | null }[] }[];
  }>(server.url, TOKEN, "repos.list");
  return Object.fromEntries(
    repos.flatMap((r) => r.worktrees.map((w) => [w.worktreeId, w.groupId])),
  );
}

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
      { id: ALPHA, name: "Alpha", color: "#8b5cf6" },
      { id: BETA, name: "Beta", color: "#3b82f6" },
    ],
    repos: [
      {
        name: "app",
        path: app,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: app, groupId: ALPHA },
          { branch: "parent", path: extra(app, "parent"), groupId: ALPHA },
          {
            branch: "kidone",
            path: extra(app, "kidone"),
            groupId: ALPHA,
            origin: "app-parent",
          },
          {
            branch: "kidtwo",
            path: extra(app, "kidtwo"),
            groupId: ALPHA,
            origin: "app-parent",
          },
        ],
      },
      {
        name: "lib",
        path: lib,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: lib, groupId: BETA },
          { branch: "loose", path: extra(lib, "loose") },
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
    if (group.id !== ALPHA && group.id !== BETA) {
      await trpcMutate(server.url, TOKEN, "groups.remove", { id: group.id });
    }
  }
  await trpcMutate(server.url, TOKEN, "groups.reorder", { ids: [ALPHA, BETA] });
  await trpcMutate(server.url, TOKEN, "groups.update", {
    id: ALPHA,
    name: "Alpha",
    color: "#8b5cf6",
  });
  for (const [worktreeId, groupId] of Object.entries(LAYOUT)) {
    await trpcMutate(server.url, TOKEN, "worktrees.setGroup", { worktreeId, groupId });
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

test("the default view lists plain top-level rows, then each group's worktrees as an origin tree (S6, S12)", async ({
  page,
}) => {
  const { sidebar } = await open(page);
  await expect.poll(() => sidebar.headerOrder()).toEqual([ALPHA, BETA]);
  await expect(sidebar.groupHeader(UNGROUPED)).toHaveCount(0);
  await expect
    .poll(() => sidebar.sections())
    .toEqual({
      [ALPHA]: ["0:app-main", "1:app-parent", "2:app-kidone", "2:app-kidtwo"],
      [BETA]: ["0:lib-main"],
      [UNGROUPED]: ["0:lib-loose"],
    });
  await expect(sidebar.groupHeader(ALPHA)).toContainText("Alpha");
  await expect(sidebar.groupCount(ALPHA)).toHaveText("4");
  await expect(sidebar.groupDot(ALPHA)).toHaveCSS("background-color", "rgb(139, 92, 246)");
  // A group mixes repos, so every card names its repo.
  await expect(sidebar.row("lib-main")).toContainText("lib");
  await expect(sidebar.row("app-parent")).toContainText("app");
});

test("a group header collapses its worktrees, and the choice survives a reload", async ({
  page,
}) => {
  // The open worktree is in Beta: opening a worktree expands its own group.
  const { sidebar } = await open(page, "lib-main");
  await expect(sidebar.row("app-kidone")).toBeVisible();
  await sidebar.groupHeader(ALPHA).click();
  await expect(sidebar.row("app-kidone")).toHaveCount(0);
  await expect(sidebar.row("lib-main")).toBeVisible();
  await sidebar.reload();
  await expect(sidebar.groupHeader(ALPHA)).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.row("app-kidone")).toHaveCount(0);
  await sidebar.groupHeader(ALPHA).click();
  await expect(sidebar.row("app-kidone")).toBeVisible();
});

test("Collapse all folds every group header", async ({ page }) => {
  const { sidebar } = await open(page);
  await sidebar.collapseAll();
  for (const id of [ALPHA, BETA]) {
    await expect(sidebar.groupHeader(id)).toHaveAttribute("aria-expanded", "false");
  }
  await expect(sidebar.row("app-main")).toHaveCount(0);
});

test("dragging a parent onto another group's header moves its children too by default (S6)", async ({
  page,
}) => {
  const { sidebar } = await open(page);
  await sidebar.dragToGroup("app-parent", BETA);
  // The dialog asks about the 2 children, and moving them is the default button.
  await expect(sidebar.moveChildrenDialog).toContainText("2");
  await expect(sidebar.moveWithChildrenButton).toBeFocused();
  await sidebar.moveWithChildren();

  const expected = {
    [ALPHA]: ["0:app-main"],
    [BETA]: ["0:app-parent", "1:app-kidone", "1:app-kidtwo", "0:lib-main"],
    [UNGROUPED]: ["0:lib-loose"],
  };
  await expect.poll(() => sidebar.sections()).toEqual(expected);
  await expect(sidebar.fromParentChip("app-kidone")).toHaveCount(0);
  expect(await groupsOf()).toEqual({
    ...LAYOUT,
    "app-parent": BETA,
    "app-kidone": BETA,
    "app-kidtwo": BETA,
  });

  await sidebar.reload();
  await expect.poll(() => sidebar.sections()).toEqual(expected);
});

test("moving only the parent leaves its children in place with a from-parent chip that selects it (S6)", async ({
  page,
}) => {
  const { sidebar } = await open(page);
  await sidebar.dragToGroup("app-parent", BETA);
  await sidebar.moveOnly();

  // The children stay in Alpha as top-level rows, and each says where it came from.
  const expected = {
    [ALPHA]: ["0:app-main", "0:app-kidone", "0:app-kidtwo"],
    [BETA]: ["0:app-parent", "0:lib-main"],
    [UNGROUPED]: ["0:lib-loose"],
  };
  await expect.poll(() => sidebar.sections()).toEqual(expected);
  await expect(sidebar.fromParentChip("app-kidone")).toBeVisible();
  await expect(sidebar.fromParentChip("app-kidtwo")).toBeVisible();
  await expect(sidebar.fromParentChip("app-parent")).toHaveCount(0);
  expect((await groupsOf())["app-kidone"]).toBe(ALPHA);
  expect((await groupsOf())["app-parent"]).toBe(BETA);

  await sidebar.reload();
  await expect.poll(() => sidebar.sections()).toEqual(expected);
  await expect(sidebar.fromParentChip("app-kidone")).toBeVisible();

  // The chip opens the parent, which is in another group.
  await sidebar.fromParentChip("app-kidone").click();
  await expect(page).toHaveURL(/\/worktree\/app-parent/);
});

test("a worktree with no children moves to the top level without a question (S6, S12)", async ({
  page,
}) => {
  const { sidebar } = await open(page);
  await sidebar.dragToTopLevel("lib-main", "lib-loose");
  await expect
    .poll(() => sidebar.sections())
    .toMatchObject({
      [BETA]: [],
      // lib-loose has no origin, so it nests under its repo's main.
      [UNGROUPED]: ["0:lib-main", "1:lib-loose"],
    });
  await expect(sidebar.moveChildrenDialog).toHaveCount(0);
  expect((await groupsOf())["lib-main"]).toBeNull();
});

test("a group header's menu renames, recolors and deletes the group, and deleting ungroups its worktrees", async ({
  page,
}) => {
  // A group of its own, so deleting it leaves the seeded ones for the next test.
  const { group } = await trpcMutateData<{ group: { id: string } }>(
    server.url,
    TOKEN,
    "groups.create",
    { name: "Temp", color: "#22c55e" },
  );
  await trpcMutate(server.url, TOKEN, "worktrees.setGroup", {
    worktreeId: "lib-loose",
    groupId: group.id,
  });
  const { sidebar } = await open(page);
  await expect(sidebar.groupHeader(group.id)).toContainText("Temp");

  await sidebar.renameFromMenu(group.id, "Gamma team");
  await expect(sidebar.groupHeader(group.id)).toContainText("Gamma team");

  await sidebar.recolorFromMenu(group.id, "red");
  await expect(sidebar.groupDot(group.id)).toHaveCSS("background-color", "rgb(239, 68, 68)");

  await sidebar.deleteFromMenu(group.id);
  await expect(sidebar.groupHeader(group.id)).toHaveCount(0);
  await expect
    .poll(() => sidebar.sections())
    .toEqual({
      [ALPHA]: ["0:app-main", "1:app-parent", "2:app-kidone", "2:app-kidtwo"],
      [BETA]: ["0:lib-main"],
      [UNGROUPED]: ["0:lib-loose"],
    });
  expect((await groupsOf())["lib-loose"]).toBeNull();
});

test("New group in the group filter adds an empty group that takes drops", async ({ page }) => {
  const { sidebar } = await open(page);
  await sidebar.createGroup("Fresh");
  await expect.poll(async () => (await sidebar.headerOrder()).length).toBe(3);
  const order = await sidebar.headerOrder();
  const fresh = order[2];
  await expect(sidebar.groupHeader(fresh)).toContainText("Fresh");
  await expect(sidebar.groupCount(fresh)).toHaveText("0");
  await sidebar.dragToGroup("lib-loose", fresh);
  await expect
    .poll(() => sidebar.sections())
    .toMatchObject({
      [fresh]: ["0:lib-loose"],
      [UNGROUPED]: [],
    });
});

test("a group header's + starts a worktree in that group, filtered or not (S7)", async ({
  page,
}) => {
  const { sidebar, worktreePage } = await open(page);
  await sidebar.addWorktreeInGroup(ALPHA, "lib", "fromheader");
  await expect.poll(async () => (await groupsOf())["lib-fromheader"]).toBe(ALPHA);
  await expect.poll(async () => (await sidebar.sections())[ALPHA]).toContain("0:lib-fromheader");

  // With the filter on Beta the view shows Beta alone, under its own header.
  await worktreePage.selectGroupFilter(BETA);
  await expect.poll(() => sidebar.headerOrder()).toEqual([BETA]);
  await expect(sidebar.groupHeader(BETA)).toHaveAttribute("aria-expanded", "true");
  await sidebar.addWorktreeInGroup(BETA, "app", "filtered");
  await expect.poll(async () => (await groupsOf())["app-filtered"]).toBe(BETA);
});
