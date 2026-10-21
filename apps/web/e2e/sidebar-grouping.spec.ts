/**
 * The sidebar's Group by switch (Repo | Origin | Host) and the manual Set parent / Remove parent items.
 *
 * Real production binary and a real `band-worker`. Origins are recorded the way an agent records
 * them: `worktrees.create` called with the caller's worktree and chat headers. Everything runs in
 * temp dirs, never the real `~/.band`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { expect, test } from "@playwright/test";
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
import { startWorker, type WorkerHandle } from "./helpers/worker";
import { SidebarGroupingPage } from "./pages/SidebarGroupingPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-sidebar-grouping-token";
const ORIGIN_CHAT = "chat_origin1";

test.use({ viewport: { width: 1280, height: 800 } });
test.describe.configure({ mode: "serial" });

let server: ServerHandle;
let tmpHome: string;
let worker: WorkerHandle | undefined;
let hostId = "";
// The worktree on the worker is named after its host.
let remote1 = "";
const dirs: string[] = [];

const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  writeFileSync(join(dir, "README.md"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env });
}

/** `worktrees.create` as an agent in `caller` makes it: the headers name the caller's worktree and chat. */
async function createFrom(
  input: Record<string, unknown>,
  caller?: { worktreeId: string; chatId?: string },
): Promise<void> {
  const res = await fetch(`${server.url}/trpc/worktrees.create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `band_token=${TOKEN}`,
      ...(caller
        ? {
            "x-band-worktree-id": caller.worktreeId,
            ...(caller.chatId ? { "x-band-chat-id": caller.chatId } : {}),
          }
        : {}),
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`worktrees.create failed: ${res.status} ${await res.text()}`);
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const root = tmpDir("band-e2e-grouping-");
  const repos = ["borko", "svc", "lib"].map((name) => {
    const path = join(root, name);
    makeRepo(path);
    const groupId = name === "svc" ? "team-a" : name === "lib" ? "team-b" : undefined;
    return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path, groupId }] };
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  seedState(tmpHome, {
    repos,
    groups: [
      { id: "team-a", name: "Team A", color: "#8b5cf6" },
      { id: "team-b", name: "Team B", color: "#3b82f6" },
    ],
  });
  server = await startServer({ tmpHome });

  await createFrom({ repo: "svc", branch: "alpha", origin: "borko-main" });
  await createFrom({ repo: "svc", branch: "beta", origin: "borko-main" });
  await trpcMutate(server.url, TOKEN, "chats.create", {
    worktreeId: "svc-alpha",
    id: ORIGIN_CHAT,
    name: "Origin chat",
  });
  await createFrom(
    { repo: "lib", branch: "gamma" },
    { worktreeId: "svc-alpha", chatId: ORIGIN_CHAT },
  );
  await createFrom({ repo: "lib", branch: "orphan", origin: "svc-beta" });
  // Worktrees with no origin: the Origin view lists them under their repo's main.
  await createFrom({ repo: "svc", branch: "solo", noOrigin: true });
  await createFrom({ repo: "lib", branch: "solo2", noOrigin: true });

  // A worker with a clone of svc, and one worktree on it.
  const res = await fetch(`${server.url}/trpc/tokens.issueWorkerBootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
    body: JSON.stringify({ hostName: "e2e-box", labels: [] }),
  });
  expect(res.ok).toBe(true);
  const { result } = (await res.json()) as { result: { data: { token: string; hostId: string } } };
  hostId = result.data.hostId;
  const workerRoot = tmpDir("band-e2e-grouping-wroot-");
  makeRepo(join(workerRoot, "svc"));
  worker = startWorker({
    env: {
      BAND_HUB_URL: server.url,
      BAND_BOOTSTRAP_TOKEN: result.data.token,
      BAND_WORKER_ID: hostId,
    },
    root: workerRoot,
    stateDir: tmpDir("band-e2e-grouping-state-"),
    home: tmpDir("band-e2e-grouping-whome-"),
  });
  await expect
    .poll(
      async () => {
        const { hosts } = await trpcQuery<{ hosts: Array<{ id: string; status: string }> }>(
          server.url,
          TOKEN,
          "hosts.list",
        );
        return hosts.find((h) => h.id === hostId)?.status;
      },
      { timeout: 20_000 },
    )
    .toBe("online");
  remote1 = toWorktreeId("svc", "remote1", hostId);
  await createFrom({
    repo: "svc",
    branch: "remote1",
    hostId,
    hostRepoPath: join(workerRoot, "svc"),
    noOrigin: true,
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await worker?.kill();
  await server.close();
  cleanupTmpHome(tmpHome);
  for (const dir of dirs) cleanupTmpHome(dir);
});

async function open(page: import("@playwright/test").Page, worktreeId: string) {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(worktreeId);
  await worktreePage.waitForReady();
  return new SidebarGroupingPage(page);
}

test("Origin mode nests what started what across repos, with the repo name on every row (S1)", async ({
  page,
}) => {
  const sidebar = await open(page, "borko-main");
  await sidebar.selectMode("origin");

  // The tree comes first, in repo order. Parentless worktrees nest under their repo's main.
  await expect
    .poll(async () => (await sidebar.rowOrder()).slice(0, 5).map((r) => `${r.depth}:${r.id}`))
    .toEqual(["0:borko-main", "1:svc-alpha", "2:lib-gamma", "1:svc-beta", "2:lib-orphan"]);
  const rest = (await sidebar.rowOrder()).slice(5).map((r) => `${r.depth}:${r.id}`);
  // remote1 is on a host with no svc main, so it stays at the top level.
  expect(rest).toEqual(["0:svc-main", "1:svc-solo", `0:${remote1}`, "0:lib-main", "1:lib-solo2"]);
  await expect(sidebar.row("lib-gamma")).toContainText("lib");
  await expect(sidebar.row("svc-alpha")).toContainText("svc");
  await expect(sidebar.row("borko-main")).toContainText("borko");

  // Every row has the repo avatar (a folder here, the repos have no GitHub owner) and a gray host tag.
  await expect(sidebar.repoAvatar(sidebar.row("svc-solo"), "svc")).toBeVisible();
  await expect(sidebar.hostTag(sidebar.row("svc-solo"))).toHaveText("This hub");
  await expect(sidebar.hostTag(sidebar.row(remote1))).toHaveText("e2e-box");

  // Collapsing a parent hides its subtree.
  await sidebar.originToggle("svc-alpha").click();
  await expect(sidebar.row("lib-gamma")).toHaveCount(0);
  await sidebar.originToggle("svc-alpha").click();
  await expect(sidebar.row("lib-gamma")).toBeVisible();

  // Collapsing a main hides its parentless worktrees, and the choice survives a reload.
  await sidebar.originToggle("svc-main").click();
  await expect(sidebar.row("svc-solo")).toHaveCount(0);
  await sidebar.reload();
  await expect(sidebar.row("lib-main")).toBeVisible();
  await expect(sidebar.row("svc-solo")).toHaveCount(0);
  await sidebar.originToggle("svc-main").click();
  await expect(sidebar.row("svc-solo")).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`the host tag is muted next to the repo name in ${scheme} mode (S3)`, async ({
    page,
  }, testInfo) => {
    // The app takes its theme from the saved setting, not from the browser's color scheme.
    await trpcMutate(server.url, TOKEN, "settings.update", { theme: scheme });
    const sidebar = await open(page, "borko-main");
    await sidebar.selectMode("origin");
    const tag = sidebar.hostTag(sidebar.row("svc-solo"));
    await expect(tag).toBeVisible();
    await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^(?!.*dark)/);
    // Gray like the repo line, not the foreground of the branch name.
    const colors = await sidebar.row("svc-solo").evaluate((el) => {
      const read = (id: string) => {
        const node = el.querySelector(`[data-testid="${id}"]`);
        return node ? getComputedStyle(node).color : "";
      };
      return { name: read("worktree-label__name"), tag: read("worktree-label__host") };
    });
    expect(colors.tag).not.toBe("");
    expect(colors.tag).not.toBe(colors.name);
    await testInfo.attach(`origin-view-${scheme}.png`, {
      body: await page.getByTestId("repo-list__grouped--origin").screenshot(),
      contentType: "image/png",
    });
  });
}

test("Repo mode lists each worktree under its repo, and Host mode groups by worker (S2)", async ({
  page,
}) => {
  const sidebar = await open(page, "borko-main");
  await sidebar.selectMode("repo");
  await expect(sidebar.repoModeCard("svc-alpha")).toBeVisible();
  await expect(sidebar.repoModeCard("lib-gamma")).toBeVisible();
  // The hub has more than one host, so every card carries its host's name.
  await expect(sidebar.hostTag(sidebar.repoModeCard("svc-alpha"))).toHaveText("This hub");
  await expect(sidebar.hostTag(sidebar.repoModeCard(remote1))).toHaveText("e2e-box");
  await expect(sidebar.hostTag(sidebar.repoModeCard("lib-gamma"))).toHaveText("This hub");

  await sidebar.selectMode("host");
  await expect(sidebar.hostHeader("local")).toBeVisible();
  await expect(sidebar.hostHeader(hostId)).toContainText("e2e-box");
  await expect(sidebar.hostHeader(hostId)).toHaveAttribute("data-status", "online");
  await expect(sidebar.hostRepoHeader(hostId, "svc")).toBeVisible();
  await expect(sidebar.row(remote1)).toBeVisible();
  await expect(sidebar.row("svc-alpha")).toBeVisible();
  const order = (await sidebar.rowOrder()).map((r) => r.id);
  expect(order.indexOf(remote1)).toBeGreaterThan(order.indexOf("svc-alpha"));
});

test("the switch survives a reload (S3)", async ({ page }) => {
  const sidebar = await open(page, "borko-main");
  await sidebar.selectMode("origin");
  await sidebar.reload();
  await expect(sidebar.groupByTrigger).toHaveAccessibleName(/Group by: Origin/);
  await expect(sidebar.row("svc-alpha")).toBeVisible();
});

test("the header has the group filter and the Group by dropdown, and no switch row (S1, S2)", async ({
  page,
}) => {
  const sidebar = await open(page, "borko-main");
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await expect(worktreePage.groupFilterTrigger()).toBeVisible();
  await expect(sidebar.groupByTrigger).toBeVisible();
  await sidebar.expectHeaderFits();
  // The old always-visible switch row is gone: the modes exist only inside the open menu.
  await expect(page.getByTestId("repos-panel__group-by--repo")).toHaveCount(0);
  await sidebar.groupByTrigger.click();
  await expect(sidebar.modeItem("host")).toBeVisible();
  await page.keyboard.press("Escape");
});

for (const mode of ["groups", "repo", "origin", "host"] as const) {
  test(`the group filter hides worktrees of other groups in ${mode} mode (S1)`, async ({
    page,
  }) => {
    const sidebar = await open(page, "borko-main");
    const worktreePage = new WorktreePage(page, server.url, TOKEN);
    await sidebar.selectMode(mode);
    await worktreePage.selectGroupFilter("team-b");
    if (mode === "repo") {
      await expect(sidebar.repoModeCard("lib-main")).toBeVisible();
      await expect(sidebar.repoModeCard("svc-main")).toHaveCount(0);
    } else {
      await expect(sidebar.row("lib-main")).toBeVisible();
      await expect(sidebar.row("svc-main")).toHaveCount(0);
    }
    await worktreePage.selectGroupFilter(null);
  });
}

test("keyboard navigation steps through the rows of the Origin view", async ({ page }) => {
  const sidebar = await open(page, "borko-main");
  await sidebar.selectMode("origin");
  await sidebar.row("borko-main").click();
  await sidebar.openNextRowWithKeyboard();
  await expect(page).toHaveURL(/\/worktree\/svc-alpha/);
});

test("a worktree started from another shows no Started from bar (S1)", async ({ page }) => {
  const sidebar = await open(page, "lib-gamma");
  await sidebar.selectMode("origin");
  await expect(sidebar.row("lib-gamma")).toHaveAttribute("data-depth", "2");
  await expect(sidebar.startedFrom).toHaveCount(0);
});

test("Set parent nests a worktree under the chosen one, and Remove parent undoes it (S3, S4)", async ({
  page,
}) => {
  const sidebar = await open(page, "borko-main");
  await sidebar.selectMode("origin");
  // A second tab on the same hub follows without a reload.
  const other = await page.context().newPage();
  const otherSidebar = await open(other, "borko-main");
  await otherSidebar.selectMode("origin");
  await expect(otherSidebar.row("svc-solo")).toHaveAttribute("data-depth", "1");

  // svc-solo has no parent: the menu offers Set parent only.
  await sidebar.openMenu(sidebar.row("svc-solo"));
  await expect(sidebar.removeParentItem).toHaveCount(0);
  await page.keyboard.press("Escape");

  await sidebar.openSetParent(sidebar.row("svc-solo"));
  await sidebar.chooseParent("gamma", "lib-gamma");
  await expect(sidebar.row("svc-solo")).toHaveAttribute("data-depth", "3");
  await expect(otherSidebar.row("svc-solo")).toHaveAttribute("data-depth", "3");

  await sidebar.removeParent(sidebar.row("svc-solo"));
  await expect(sidebar.row("svc-solo")).toHaveAttribute("data-depth", "1");
  await expect(otherSidebar.row("svc-solo")).toHaveAttribute("data-depth", "1");
  await other.close();
});

test("Set parent does not offer the worktree or its descendants, and the hub refuses them (S5)", async ({
  page,
}) => {
  const sidebar = await open(page, "borko-main");
  await sidebar.selectMode("origin");
  // svc-alpha is the parent of lib-gamma.
  await sidebar.openSetParent(sidebar.row("svc-alpha"));
  await expect(sidebar.setParentItem("svc-alpha")).toHaveCount(0);
  await expect(sidebar.setParentItem("lib-gamma")).toHaveCount(0);
  await expect(sidebar.setParentItem("svc-beta")).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(
    trpcMutate(server.url, TOKEN, "worktrees.setOrigin", {
      repo: "svc",
      name: "alpha",
      origin: "lib-gamma",
    }),
  ).rejects.toThrow(/descendant/);
  await expect(
    trpcMutate(server.url, TOKEN, "worktrees.setOrigin", {
      repo: "svc",
      name: "alpha",
      origin: "svc-alpha",
    }),
  ).rejects.toThrow(/own parent/);
});

test("a worktree whose parent was deleted shows under its repo's main with a hint (S4)", async ({
  page,
}) => {
  await trpcMutate(server.url, TOKEN, "worktrees.remove", { repo: "svc", name: "beta" });
  const sidebar = await open(page, "borko-main");
  await sidebar.selectMode("origin");
  await expect(sidebar.row("svc-beta")).toHaveCount(0);
  await expect(sidebar.row("lib-orphan")).toHaveAttribute("data-depth", "1");
  await expect(sidebar.rowOrder()).resolves.toContainEqual({ id: "lib-main", depth: 0 });
  await expect(sidebar.parentRemovedHint("lib-orphan")).toBeVisible();
});
