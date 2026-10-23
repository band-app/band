/**
 * The sidebar's Pinned section and drag and drop while the hub defines no group, so worktrees sit
 * under their repos. Dropping onto a worktree or a group header is covered by sidebar-grouping.spec.ts.
 *
 * Real production binary. Local repos and worktrees are
 * created through `worktrees.create`; pins and parents through the same tRPC calls the UI makes.
 * Everything runs in temp dirs, never the real `~/.band`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
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
import { SidebarPinsDragPage } from "./pages/SidebarPinsDragPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-sidebar-pins-drag-token";

test.use({ viewport: { width: 1280, height: 900 } });
test.describe.configure({ mode: "serial" });

let server: ServerHandle;
let tmpHome: string;
const dirs: string[] = [];

const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
}

interface Listed {
  repos: Array<{
    name: string;
    worktrees: Array<{
      worktreeId: string;
      name: string;
      hostId?: string;
      sortIndex?: number;
      origin: { worktreeId: string } | null;
    }>;
  }>;
}
const listed = () => trpcQuery<Listed>(server.url, TOKEN, "repos.list");
const worktreeRow = async (id: string) =>
  (await listed()).repos.flatMap((r) => r.worktrees).find((w) => w.worktreeId === id);

const create = (input: Record<string, unknown>) =>
  trpcMutate(server.url, TOKEN, "worktrees.create", { noOrigin: true, ...input });
const pin = (repo: string, name: string) =>
  trpcMutate(server.url, TOKEN, "worktrees.setPinned", { repo, name, pinned: true });

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const root = tmpDir("band-e2e-pins-");
  const repos = ["alpha", "beta"].map((name) => {
    const path = join(root, name);
    makeRepo(path);
    return {
      name,
      path,
      defaultBranch: "main",
      worktrees: [{ branch: "main", path }],
    };
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  seedState(tmpHome, { repos });
  server = await startServer({ tmpHome });

  // Plain worktrees to reorder and reparent.
  for (const branch of ["a", "b", "c", "d"]) await create({ repo: "alpha", branch });
  // A pin with a child, a grandchild and a child from another repo, and a pin in the other repo.
  await create({ repo: "alpha", branch: "pin" });
  await pin("alpha", "pin");
  await trpcMutate(server.url, TOKEN, "worktrees.create", {
    repo: "alpha",
    branch: "pin-child",
    origin: "alpha-pin",
  });
  await trpcMutate(server.url, TOKEN, "worktrees.create", {
    repo: "alpha",
    branch: "pin-grand",
    origin: "alpha-pin-child",
  });
  await trpcMutate(server.url, TOKEN, "worktrees.create", {
    repo: "beta",
    branch: "pin-other",
    origin: "alpha-pin",
  });
  await create({ repo: "beta", branch: "pinned-beta" });
  await pin("beta", "pinned-beta");
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server?.close();
  cleanupTmpHome(tmpHome);
  for (const dir of dirs) cleanupTmpHome(dir);
});

async function open(page: Page, worktreeId = "alpha-main", mobile = false) {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(worktreeId);
  const sidebar = new SidebarPinsDragPage(page);
  if (mobile) await worktreePage.waitForMobileReady();
  else await worktreePage.waitForReady();
  return { sidebar, worktreePage };
}

test("the Pinned section holds the pins with their children, once (S1, S2)", async ({ page }) => {
  const { sidebar } = await open(page);
  await expect(sidebar.pinnedHeader).toBeVisible();
  await expect(sidebar.pinnedRow("alpha-pin")).toBeVisible();
  await expect
    .poll(async () => (await sidebar.pinnedOrder()).map((r) => `${r.depth}:${r.id}`))
    .toEqual([
      "0:alpha-pin",
      "1:alpha-pin-child",
      "2:alpha-pin-grand",
      "1:beta-pin-other",
      "0:beta-pinned-beta",
    ]);
  // Nothing is listed twice: the pin and its subtree leave the normal tree.
  for (const id of ["alpha-pin", "alpha-pin-child", "alpha-pin-grand", "beta-pin-other"]) {
    await expect(sidebar.card(id)).toHaveCount(1);
    await expect(sidebar.pinnedCard(id)).toHaveCount(1);
  }
});

test("Collapse all folds the repos, the Pinned section and the pins (S4)", async ({ page }) => {
  const { sidebar } = await open(page);
  await expect(sidebar.pinnedRow("alpha-pin-child")).toBeVisible();
  await sidebar.collapseAll();
  await expect(sidebar.pinnedHeader).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.pinnedRow("alpha-pin")).toHaveCount(0);

  await sidebar.pinnedHeader.click();
  await expect(sidebar.pinnedRow("alpha-pin")).toBeVisible();
  // The pin with children is folded too.
  await expect(sidebar.pinnedRow("alpha-pin-child")).toHaveCount(0);
  await sidebar.originToggle("alpha-pin").click();
  await expect(sidebar.pinnedRow("alpha-pin-child")).toBeVisible();

  // The state survives a reload.
  await sidebar.reload();
  await expect(sidebar.pinnedRow("alpha-pin-child")).toBeVisible();
  await sidebar.originToggle("alpha-pin").click();
  await sidebar.pinnedHeader.click();
  await expect(sidebar.pinnedHeader).toHaveAttribute("aria-expanded", "false");
  await sidebar.pinnedHeader.click();
  // Leave everything expanded for the next test.
  await sidebar.originToggle("alpha-pin").click();
});

test("dragging a worktree above another reorders it, on every device, and after a reload (S5)", async ({
  page,
  browser,
}) => {
  const { sidebar } = await open(page);
  const before = await sidebar.treeCardOrder("alpha-");
  expect(before.indexOf("alpha-a")).toBeLessThan(before.indexOf("alpha-b"));

  await sidebar.drag(sidebar.card("alpha-b"), sidebar.card("alpha-a"), "top");
  const expectBAboveA = (reader: SidebarPinsDragPage) =>
    expect
      .poll(async () => {
        const order = await reader.treeCardOrder("alpha-");
        return order.includes("alpha-b") && order.indexOf("alpha-b") < order.indexOf("alpha-a");
      })
      .toBe(true);
  await expect
    .poll(async () => {
      const order = await sidebar.treeCardOrder("alpha-");
      return order.indexOf("alpha-b") < order.indexOf("alpha-a");
    })
    .toBe(true);

  // Server side: both worktrees carry an index.
  await expect.poll(async () => (await worktreeRow("alpha-b"))?.sortIndex).toBeDefined();

  await sidebar.reload();
  await expectBAboveA(sidebar);

  // A second browser context stands for another device.
  const other = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const otherPage = await other.newPage();
  const { sidebar: otherSidebar } = await open(otherPage);
  await expectBAboveA(otherSidebar);
  await other.close();
});

test("dragging a pin reorders the Pinned section", async ({ page }) => {
  const { sidebar } = await open(page);
  const [first, second] = ["alpha-pin", "beta-pinned-beta"];
  await sidebar.drag(sidebar.card(second), sidebar.card(first), "top");
  await expect
    .poll(async () => {
      const ids = (await sidebar.pinnedOrder()).filter((r) => r.depth === 0).map((r) => r.id);
      return ids.indexOf(second) < ids.indexOf(first);
    })
    .toBe(true);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a long press drags a worktree, a tap opens it and the chevrons toggle (S8)", async ({
    page,
  }) => {
    const { sidebar, worktreePage } = await open(page, "alpha-main", true);
    await worktreePage.openRepoListFlyout();
    const order = () => sidebar.treeCardOrder("alpha-");
    const [first, second] = (await order())
      .filter((id) => ["alpha-a", "alpha-b"].includes(id))
      .slice(0, 2);
    expect(first).toBeDefined();

    await sidebar.touchDrag(sidebar.card(second), sidebar.card(first), "top");
    await expect
      .poll(async () => {
        const ids = await order();
        return ids.indexOf(second) < ids.indexOf(first);
      })
      .toBe(true);

    // The chevron of a pin with children still toggles.
    await expect(sidebar.pinnedRow("alpha-pin-child")).toBeVisible();
    await sidebar.originToggle("alpha-pin").tap();
    await expect(sidebar.pinnedRow("alpha-pin-child")).toHaveCount(0);
    await sidebar.originToggle("alpha-pin").tap();
    await expect(sidebar.pinnedRow("alpha-pin-child")).toBeVisible();

    // A tap still opens the worktree.
    await sidebar.card("alpha-c").tap();
    await expect(page).toHaveURL(/\/worktree\/alpha-c/);
  });
});
