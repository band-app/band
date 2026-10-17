/**
 * The sidebar's Pinned section and drag and drop in the Repo, Origin and Host views.
 *
 * Real production binary, real `band-worker`s for the move case. Local repos and worktrees are
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
import { trpcMutate, trpcMutateData, trpcQuery } from "./helpers/trpc";
import { startWorker, type WorkerHandle } from "./helpers/worker";
import { MoveWorktreePage } from "./pages/MoveWorktreePage";
import { SidebarPinsDragPage } from "./pages/SidebarPinsDragPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-sidebar-pins-drag-token";

test.use({ viewport: { width: 1280, height: 900 } });
test.describe.configure({ mode: "serial" });

let server: ServerHandle;
let tmpHome: string;
const dirs: string[] = [];
const workers: WorkerHandle[] = [];

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
const originOf = async (id: string) => (await worktreeRow(id))?.origin?.worktreeId ?? null;

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
      label: name === "alpha" ? "private" : "other",
      worktrees: [{ branch: "main", path }],
    };
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    labels: [
      { id: "private", name: "Private", color: "#3b82f6" },
      { id: "other", name: "Other", color: "#f97316" },
    ],
  });
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
  for (const w of workers) await w.kill();
  await server?.close();
  cleanupTmpHome(tmpHome);
  for (const dir of dirs) cleanupTmpHome(dir);
});

async function open(page: Page, worktreeId = "alpha-main", mobile = false) {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(worktreeId);
  if (mobile) await worktreePage.waitForMobileReady();
  else await worktreePage.waitForReady();
  return { sidebar: new SidebarPinsDragPage(page), worktreePage };
}

const MODES = ["repo", "origin", "host"] as const;

for (const mode of MODES) {
  test(`${mode} view: the Pinned section holds the pins with their children, once (S1, S2)`, async ({
    page,
  }) => {
    const { sidebar } = await open(page);
    await sidebar.selectMode(mode);
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
}

test("the label filter hides pins and children of other labels (S3)", async ({ page }) => {
  const { sidebar, worktreePage } = await open(page);
  for (const mode of MODES) {
    await sidebar.selectMode(mode);
    await worktreePage.selectLabelFilter("private");
    await expect
      .poll(async () => (await sidebar.pinnedOrder()).map((r) => r.id))
      .toEqual(["alpha-pin", "alpha-pin-child", "alpha-pin-grand"]);
    await expect(sidebar.card("beta-pin-other")).toHaveCount(0);
    await expect(sidebar.card("beta-pinned-beta")).toHaveCount(0);
    await worktreePage.selectLabelFilter(null);
    await expect(sidebar.pinnedRow("beta-pinned-beta")).toBeVisible();
    await expect(sidebar.pinnedRow("beta-pin-other")).toBeVisible();
  }
});

for (const mode of MODES) {
  test(`${mode} view: Collapse all folds the groups, the Pinned section and the pins (S4)`, async ({
    page,
  }) => {
    const { sidebar } = await open(page);
    await sidebar.selectMode(mode);
    await expect(sidebar.pinnedRow("alpha-pin-child")).toBeVisible();
    await sidebar.collapseAll();
    await expect(sidebar.pinnedHeader).toHaveAttribute("aria-expanded", "false");
    await expect(sidebar.pinnedRow("alpha-pin")).toHaveCount(0);
    if (mode === "origin") await expect(sidebar.row("alpha-main")).toBeVisible();
    if (mode === "host")
      await expect(sidebar.hostHeader("local")).toHaveAttribute("aria-expanded", "false");

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
    // Leave every view expanded for the next test.
    await sidebar.originToggle("alpha-pin").click();
    if (mode === "host") await sidebar.hostHeader("local").click();
  });
}

test("dragging a worktree above another reorders it in every view, on every device, and after a reload (S5)", async ({
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

  for (const mode of ["origin", "host"] as const) {
    await sidebar.selectMode(mode);
    await expect
      .poll(async () => {
        const ids = (await sidebar.rowOrder()).map((r) => r.id);
        return ids.indexOf("alpha-b") < ids.indexOf("alpha-a");
      })
      .toBe(true);
  }
  await sidebar.selectMode("repo");

  await sidebar.reload();
  await expectBAboveA(sidebar);

  // A second browser context stands for another device.
  const other = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const otherPage = await other.newPage();
  const { sidebar: otherSidebar } = await open(otherPage);
  await expectBAboveA(otherSidebar);
  await other.close();
});

test("dragging a pin reorders the Pinned section in every view", async ({ page }) => {
  const { sidebar } = await open(page);
  for (const mode of MODES) {
    await sidebar.selectMode(mode);
    const [first, second] =
      mode === "origin" ? ["beta-pinned-beta", "alpha-pin"] : ["alpha-pin", "beta-pinned-beta"];
    await sidebar.drag(sidebar.card(second), sidebar.card(first), "top");
    await expect
      .poll(async () => {
        const ids = (await sidebar.pinnedOrder()).filter((r) => r.depth === 0).map((r) => r.id);
        return ids.indexOf(second) < ids.indexOf(first);
      })
      .toBe(true);
  }
});

test("Origin view: dropping on a row makes a child, in the gap a sibling, and a descendant is refused (S6)", async ({
  page,
}) => {
  const { sidebar } = await open(page);
  await sidebar.selectMode("origin");

  await sidebar.drag(sidebar.row("alpha-c"), sidebar.row("alpha-a"), "middle");
  await expect.poll(() => originOf("alpha-c")).toBe("alpha-a");
  await expect(sidebar.row("alpha-c")).toHaveAttribute("data-depth", "2");

  await sidebar.drag(sidebar.row("alpha-b"), sidebar.row("alpha-a"), "middle");
  await expect.poll(() => originOf("alpha-b")).toBe("alpha-a");

  // Into the gap above b: d joins a's children at that position.
  await sidebar.drag(sidebar.row("alpha-d"), sidebar.row("alpha-b"), "top");
  await expect.poll(() => originOf("alpha-d")).toBe("alpha-a");
  await expect
    .poll(async () => {
      const ids = (await sidebar.rowOrder()).map((r) => r.id);
      return ids.indexOf("alpha-d") < ids.indexOf("alpha-b");
    })
    .toBe(true);

  // Into the gap among the main's children: the explicit parent goes.
  await sidebar.drag(sidebar.row("alpha-c"), sidebar.row("alpha-a"), "bottom");
  await expect.poll(() => originOf("alpha-c")).toBeNull();

  // Onto the main's own row: the main is named as the parent, and the row stays nested after a reload.
  await sidebar.drag(sidebar.row("alpha-d"), sidebar.row("alpha-main"), "middle");
  await expect.poll(() => originOf("alpha-d")).toBe("alpha-main");
  await expect(sidebar.row("alpha-d")).toHaveAttribute("data-depth", "1");
  await page.reload();
  await expect(sidebar.row("alpha-d")).toHaveAttribute("data-depth", "1");

  // A worktree can't become a child of its own descendant.
  await sidebar.drag(sidebar.row("alpha-a"), sidebar.row("alpha-b"), "middle");
  await expect(sidebar.dropRefusal).toBeVisible();
  expect(await originOf("alpha-a")).toBeNull();
});

test.describe("Host view", () => {
  let appIds: { onA: string; hostA: string; hostB: string };

  async function addWorker(name: string): Promise<{ hostId: string; root: string }> {
    const issued = await trpcMutateData<{ token: string; hostId: string }>(
      server.url,
      TOKEN,
      "tokens.issueWorkerBootstrap",
      { hostName: name, labels: [] },
    );
    const root = tmpDir(`band-e2e-pins-${name}-root-`);
    workers.push(
      startWorker({
        env: {
          BAND_HUB_URL: server.url,
          BAND_BOOTSTRAP_TOKEN: issued.token,
          BAND_WORKER_ID: issued.hostId,
        },
        root,
        stateDir: tmpDir(`band-e2e-pins-${name}-state-`),
        home: tmpDir(`band-e2e-pins-${name}-home-`),
      }),
    );
    await expect
      .poll(async () => {
        const { hosts } = await trpcQuery<{ hosts: Array<{ id: string; status: string }> }>(
          server.url,
          TOKEN,
          "hosts.list",
        );
        return hosts.find((h) => h.id === issued.hostId)?.status;
      })
      .toBe("online");
    return { hostId: issued.hostId, root };
  }

  test.beforeAll(async () => {
    const a = await addWorker("box-a");
    const b = await addWorker("box-b");
    const parent = tmpDir("band-e2e-pins-remote-");
    const seed = join(parent, "seed");
    makeRepo(seed);
    const bare = join(parent, "app.git");
    git(parent, "clone", "-q", "--bare", seed, bare);
    git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
    git(a.root, "clone", "-q", bare, "app");
    git(b.root, "clone", "-q", bare, "app");
    await trpcMutateData(server.url, TOKEN, "repos.addByUrl", {
      remoteUrl: bare,
      defaultBranch: "main",
    });
    await trpcMutateData(server.url, TOKEN, "worktrees.create", {
      repo: "app",
      branch: "feat-move",
      hostId: a.hostId,
      hostRepoPath: join(a.root, "app"),
      noOrigin: true,
    });
    await expect
      .poll(async () => (await worktreeRow(`app-feat-move@${a.hostId}`))?.name)
      .toBe("feat-move");
    // The Host view lists only hosts that hold a worktree, so B needs one to be a drop target.
    await trpcMutateData(server.url, TOKEN, "worktrees.create", {
      repo: "app",
      branch: "on-b",
      hostId: b.hostId,
      hostRepoPath: join(b.root, "app"),
      noOrigin: true,
    });
    await expect.poll(async () => (await worktreeRow(`app-on-b@${b.hostId}`))?.name).toBe("on-b");
    appIds = {
      onA: `app-feat-move@${a.hostId}`,
      hostA: a.hostId,
      hostB: b.hostId,
    };
  });

  test("dropping on another host's group opens the move dialog, and a refused drop says why (S7)", async ({
    page,
  }) => {
    const { sidebar } = await open(page);
    const move = new MoveWorktreePage(page);
    await sidebar.selectMode("host");
    await expect(sidebar.hostHeader(appIds.hostB)).toBeVisible();

    // A movable worktree: the dialog opens with the target selected, and cancel changes nothing.
    await sidebar.drag(sidebar.row(appIds.onA), sidebar.hostHeader(appIds.hostB), "middle");
    await expect(move.dialog).toBeVisible();
    await expect(move.selectedHost).toContainText("box-b");
    await move.dismiss();
    await expect(move.dialog).toBeHidden();
    expect((await worktreeRow(appIds.onA))?.hostId).toBe(appIds.hostA);

    // Confirming moves it.
    await sidebar.drag(sidebar.row(appIds.onA), sidebar.hostHeader(appIds.hostB), "middle");
    await move.submit();
    await expect
      .poll(async () => (await worktreeRow(`app-feat-move@${appIds.hostB}`))?.hostId, {
        timeout: 60_000,
      })
      .toBe(appIds.hostB);
    await move.dismiss();

    // A worktree on the hub's own machine can't move to a worker.
    await sidebar.drag(sidebar.row("alpha-b"), sidebar.hostHeader(appIds.hostB), "middle");
    await expect(sidebar.dropRefusal).toBeVisible();
    await expect(move.dialog).toBeHidden();
  });
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
