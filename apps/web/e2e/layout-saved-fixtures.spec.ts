/**
 * Saved layouts written by the library the layout replaced still open
 * unchanged: the same groups, tabs, order, active tab and sizes, the
 * maximized group, and a terminal tab's nested split.
 *
 * Each shape is the `toJSON()` output captured from dockview 6.0.6 (the same
 * trees as `tests/fixtures/layouts/`, with `file` panels so the test needs no
 * server records), seeded into `band:dockview-layout-v9:<worktreeId>` or
 * `band:term-split:<worktreeId>:<leafId>` before the app mounts. Unit tests
 * on the parser and writer cover the round trip (`tests/layout-model.test.ts`).
 * Real production binary, no tRPC mocks, page objects only.
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

const TOKEN = "e2e-layout-saved-fixtures-token";
const REPO = "layout-fixtures-repo";
const BRANCH = "main";
const NESTED = toWorktreeId(REPO, "nested", "local");
const MAXIMIZED = toWorktreeId(REPO, "maximized", "local");
const SPLIT = toWorktreeId(REPO, "split", "local");
const BRANCHES = ["nested", "maximized", "split"];
const FILES = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"];

test.use({ viewport: { width: 1400, height: 800 } });

function filePanel(name: string) {
  return {
    id: `file:${name}`,
    contentComponent: "file",
    tabComponent: "file",
    title: name,
    params: {},
  };
}

function leaf(id: string, views: string[], activeView: string, size: number) {
  return {
    type: "leaf",
    data: { views: views.map((v) => `file:${v}`), activeView: `file:${activeView}`, id },
    size,
  };
}

/** Three groups: a column of two beside one, 700 px against 500, the column split 550 / 250. */
const NESTED_LAYOUT = {
  grid: {
    root: {
      type: "branch",
      data: [
        leaf("1", ["a.txt", "b.txt"], "b.txt", 700),
        {
          type: "branch",
          data: [leaf("2", ["c.txt", "d.txt"], "d.txt", 550), leaf("3", ["e.txt"], "e.txt", 250)],
          size: 500,
        },
      ],
      size: 800,
    },
    width: 1200,
    height: 800,
    orientation: "HORIZONTAL",
  },
  panels: Object.fromEntries(FILES.map((f) => [`file:${f}`, filePanel(f)])),
  activeGroup: "1",
};

const MAXIMIZED_LAYOUT = {
  grid: {
    root: {
      type: "branch",
      data: [leaf("1", ["a.txt"], "a.txt", 600), leaf("2", ["b.txt"], "b.txt", 600)],
      size: 800,
    },
    width: 1200,
    height: 800,
    orientation: "HORIZONTAL",
    maximizedNode: { location: [1] },
  },
  panels: Object.fromEntries(["a.txt", "b.txt"].map((f) => [`file:${f}`, filePanel(f)])),
  activeGroup: "2",
  maximizedGroup: "2",
};

// The nested split of a terminal tab: pane 1 beside a column of panes 2 and 3.
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const T3 = "33333333-3333-4333-8333-333333333333";
const termPanel = (id: string) => ({
  id,
  contentComponent: "pane",
  tabComponent: "pane",
  title: "Terminal",
  params: {},
});
const SPLIT_OUTER = {
  grid: {
    root: {
      type: "branch",
      data: [
        {
          type: "leaf",
          data: { views: [T1], activeView: T1, id: "1" },
          size: 1200,
        },
      ],
      size: 800,
    },
    width: 1200,
    height: 800,
    orientation: "HORIZONTAL",
  },
  panels: {
    [T1]: { id: T1, contentComponent: "term", tabComponent: "term", title: "Terminal", params: {} },
  },
  activeGroup: "1",
};
const SPLIT_NESTED = {
  grid: {
    root: {
      type: "branch",
      data: [
        { type: "leaf", data: { views: [T1], activeView: T1, id: "1" }, size: 500 },
        {
          type: "branch",
          data: [
            { type: "leaf", data: { views: [T2], activeView: T2, id: "2" }, size: 600 },
            { type: "leaf", data: { views: [T3], activeView: T3, id: "3" }, size: 200 },
          ],
          size: 250,
        },
      ],
      size: 800,
    },
    width: 750,
    height: 800,
    orientation: "HORIZONTAL",
  },
  panels: { [T1]: termPanel(T1), [T2]: termPanel(T2), [T3]: termPanel(T3) },
  activeGroup: "1",
};

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
  const worktrees = [{ branch: BRANCH, path: repo }];
  for (const name of BRANCHES) {
    const path = join(tmpHome, `${REPO}-${name}`);
    git(repo, ["worktree", "add", "-b", name, path]);
    worktrees.push({ branch: name, path });
  }
  seedState(tmpHome, { repos: [{ name: REPO, path: repo, defaultBranch: BRANCH, worktrees }] });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("three groups in nested splits open with their tabs, order, active tab and sizes", async ({
  page,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const layout = new CenterLayout(page);
  await worktreePage.seedGlobalLayout(NESTED, NESTED_LAYOUT);
  await worktreePage.goto(NESTED);
  await worktreePage.waitForReady();

  await expect(layout.groups).toHaveCount(3);
  expect(await layout.tabIds(0)).toEqual(["file:a.txt", "file:b.txt"]);
  expect(await layout.tabIds(1)).toEqual(["file:c.txt", "file:d.txt"]);
  expect(await layout.tabIds(2)).toEqual(["file:e.txt"]);
  // The selected tab of each group.
  await expect(layout.tab("file:b.txt")).toHaveAttribute("data-selected", "true");
  await expect(layout.tab("file:a.txt")).toHaveAttribute("data-selected", "false");
  await expect(layout.tab("file:d.txt")).toHaveAttribute("data-selected", "true");
  await expect(layout.tab("file:e.txt")).toHaveAttribute("data-selected", "true");

  // The saved sizes are proportions of the area: 700 / 500 across, 550 / 250 down.
  const [g0, g1, g2] = await Promise.all([0, 1, 2].map((i) => layout.groups.nth(i).boundingBox()));
  if (!g0 || !g1 || !g2) throw new Error("groups are not laid out");
  const across = g0.width / (g0.width + g1.width);
  expect(Math.abs(across - 700 / 1200)).toBeLessThan(0.005);
  const down = g1.height / (g1.height + g2.height);
  expect(Math.abs(down - 550 / 800)).toBeLessThan(0.005);
  // The two stacked groups share the right column.
  expect(Math.abs(g1.x - g2.x)).toBeLessThan(2);
  expect(g2.y).toBeGreaterThan(g1.y);
});

test("a saved maximized group opens maximized", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const layout = new CenterLayout(page);
  await worktreePage.seedGlobalLayout(MAXIMIZED, MAXIMIZED_LAYOUT);
  await worktreePage.goto(MAXIMIZED);
  await worktreePage.waitForReady();

  await expect(layout.groups).toHaveCount(2);
  await expect(layout.groups.nth(0)).toHaveAttribute("data-hidden", "");
  await expect(layout.groups.nth(1)).not.toHaveAttribute("data-hidden", "");
  const [shownWidth, areaWidth] = await Promise.all([layout.groupWidth(1), layout.rootWidth()]);
  expect(Math.abs(shownWidth - areaWidth)).toBeLessThan(2);
  await worktreePage.expectMaximized(MAXIMIZED);
});

test("a terminal tab opens with its saved nested split", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  for (const id of [T1, T2, T3]) await worktreePage.createTerminal(SPLIT, id);
  await worktreePage.seedGlobalLayout(SPLIT, SPLIT_OUTER);
  await worktreePage.seedTerminalSplit(SPLIT, T1, SPLIT_NESTED);
  await worktreePage.goto(SPLIT);
  await worktreePage.waitForReady();

  await expect(worktreePage.terminalPanes()).toHaveCount(3);
  expect(await worktreePage.paneOrder()).toEqual([T1, T2, T3]);
  const boxes = await Promise.all(
    [0, 1, 2].map((i) => worktreePage.terminalPanes().nth(i).boundingBox()),
  );
  const [p1, p2, p3] = boxes;
  if (!p1 || !p2 || !p3) throw new Error("panes are not laid out");
  // 500 against 250 across, and the column split 600 / 200 down.
  const across = p1.width / (p1.width + p2.width);
  expect(Math.abs(across - 500 / 750)).toBeLessThan(0.01);
  expect(Math.abs(p2.x - p3.x)).toBeLessThan(2);
  const down = p2.height / (p2.height + p3.height);
  expect(Math.abs(down - 600 / 800)).toBeLessThan(0.01);
});
