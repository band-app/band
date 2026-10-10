/**
 * The sidebar's Group by switch (Repo | Origin | Host) and the "Started from" link (plan step O.3).
 *
 * Real production binary and a real `band-worker`. Origins are recorded the way an agent records
 * them: `worktrees.create` called with the caller's worktree and chat headers. Everything runs in
 * temp dirs, never the real `~/.band`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  seedState(tmpHome, { repos });
  server = await startServer({ tmpHome });

  await trpcMutate(server.url, TOKEN, "repos.update", { name: "borko", meta: true });
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

  // The tree comes first, in repo order. The remaining top-level rows follow the repo order.
  await expect
    .poll(async () => (await sidebar.rowOrder()).slice(0, 5).map((r) => `${r.depth}:${r.id}`))
    .toEqual(["0:borko-main", "1:svc-alpha", "2:lib-gamma", "1:svc-beta", "2:lib-orphan"]);
  const rest = (await sidebar.rowOrder()).slice(5);
  expect(rest.every((r) => r.depth === 0)).toBe(true);
  expect(rest.map((r) => r.id).sort()).toEqual(["lib-main", "svc-main", "svc-remote1"]);
  await expect(sidebar.row("lib-gamma")).toContainText("lib");
  await expect(sidebar.row("svc-alpha")).toContainText("svc");
  await expect(sidebar.row("borko-main")).toContainText("borko");
  await expect(sidebar.metaBadge("borko")).toBeVisible();

  // Collapsing a parent hides its subtree.
  await sidebar.originToggle("svc-alpha").click();
  await expect(sidebar.row("lib-gamma")).toHaveCount(0);
  await sidebar.originToggle("svc-alpha").click();
  await expect(sidebar.row("lib-gamma")).toBeVisible();
});

test("Repo mode lists each worktree under its repo, and Host mode groups by worker (S2)", async ({
  page,
}) => {
  const sidebar = await open(page, "borko-main");
  await expect(sidebar.repoModeCard("svc-alpha")).toBeVisible();
  await expect(sidebar.repoModeCard("lib-gamma")).toBeVisible();
  await expect(sidebar.metaBadge("borko")).toBeVisible();

  await sidebar.selectMode("host");
  await expect(sidebar.hostHeader("local")).toBeVisible();
  await expect(sidebar.hostHeader(hostId)).toContainText("e2e-box");
  await expect(sidebar.hostHeader(hostId)).toHaveAttribute("data-status", "online");
  await expect(sidebar.hostRepoHeader(hostId, "svc")).toBeVisible();
  await expect(sidebar.row("svc-remote1")).toBeVisible();
  await expect(sidebar.row("svc-alpha")).toBeVisible();
  const order = (await sidebar.rowOrder()).map((r) => r.id);
  expect(order.indexOf("svc-remote1")).toBeGreaterThan(order.indexOf("svc-alpha"));
});

test("the switch survives a reload (S3)", async ({ page }) => {
  const sidebar = await open(page, "borko-main");
  await sidebar.selectMode("origin");
  await sidebar.reload();
  await expect(sidebar.modeButton("origin")).toHaveAttribute("aria-pressed", "true");
  await expect(sidebar.row("svc-alpha")).toBeVisible();
});

test("keyboard navigation steps through the rows of the Origin view", async ({ page }) => {
  const sidebar = await open(page, "borko-main");
  await sidebar.selectMode("origin");
  await sidebar.row("borko-main").click();
  await sidebar.openNextRowWithKeyboard();
  await expect(page).toHaveURL(/\/worktree\/svc-alpha/);
});

test("the Started from link opens the origin chat (S4)", async ({ page }) => {
  // Visit the origin first so its dockview lists the chat as a tab.
  const sidebar = await open(page, "svc-alpha");
  await expect(sidebar.centerChatTab(ORIGIN_CHAT)).toBeVisible();
  await sidebar.waitForSavedTabs("svc-alpha", ORIGIN_CHAT);

  await sidebar.repoModeCard("lib-gamma").click();
  await expect(page).toHaveURL(/\/worktree\/lib-gamma/);
  await expect(sidebar.startedFromLink).toHaveAttribute("data-origin-worktree", "svc-alpha");
  await sidebar.startedFromLink.click();
  await expect(page).toHaveURL(/\/worktree\/svc-alpha/);
  await expect(sidebar.visibleChatComposer).toBeVisible();

  // Top-level work has no link.
  await sidebar.repoModeCard("borko-main").click();
  await expect(page).toHaveURL(/\/worktree\/borko-main/);
  await expect(sidebar.startedFrom).toHaveCount(0);
});

test("a worktree whose parent was deleted shows at top level with a hint (S4)", async ({
  page,
}) => {
  await trpcMutate(server.url, TOKEN, "worktrees.remove", { repo: "svc", name: "beta" });
  const sidebar = await open(page, "borko-main");
  await sidebar.selectMode("origin");
  await expect(sidebar.row("svc-beta")).toHaveCount(0);
  await expect(sidebar.row("lib-orphan")).toHaveAttribute("data-depth", "0");
  await expect(sidebar.parentRemovedHint("lib-orphan")).toBeVisible();

  await sidebar.row("lib-orphan").click();
  await expect(sidebar.startedFrom).toHaveAttribute("data-removed", "true");
});
