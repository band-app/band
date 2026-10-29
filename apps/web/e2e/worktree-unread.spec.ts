/**
 * Marking a worktree unread (the manual half of the sidebar's unread dot).
 *
 * Real production hub against a temp `~/.band/` with one repo and two worktrees, A (open) and B.
 * The tests use the card's context menu and its status dot, and read the result back from the
 * sidebar and from `repos.list`.
 *
 * Covers: the mark survives a reload, opening a worktree clears it, marking
 * the open worktree keeps it until the user leaves, the dot toggles without selecting the card,
 * a finished worktree offers "Mark as read", and a second browser sees the mark without reloading.
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
import { WorktreePage } from "./pages/WorktreePage";
import { WorktreeUnreadPage } from "./pages/WorktreeUnreadPage";

const TOKEN = "e2e-worktree-unread-token";
const A = "app-main";
const B = "app-other";

test.use({ viewport: { width: 1280, height: 800 } });
test.describe.configure({ mode: "serial" });

let server: ServerHandle;
let tmpHome: string;

async function unreadOf(worktreeId: string): Promise<boolean> {
  const { repos } = await trpcQuery<{
    repos: { worktrees: { worktreeId: string; unread: boolean }[] }[];
  }>(server.url, TOKEN, "repos.list");
  const wt = repos.flatMap((r) => r.worktrees).find((w) => w.worktreeId === worktreeId);
  return wt?.unread ?? false;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const app = join(tmpHome, "app");
  mkdirSync(app, { recursive: true });
  gitInHome(app, ["init", "-b", "main"], tmpHome);
  writeFileSync(join(app, "README.md"), "# app\n");
  gitInHome(app, ["add", "."], tmpHome);
  gitInHome(app, ["commit", "-m", "initial"], tmpHome);
  const other = join(tmpHome, "other-checkout");
  gitInHome(app, ["worktree", "add", "-b", "other", other], tmpHome);
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  seedState(tmpHome, {
    repos: [
      {
        name: "app",
        path: app,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: app },
          { branch: "other", path: other },
        ],
      },
    ],
  });
  server = await startServer({ tmpHome });
});

test.beforeEach(async () => {
  resetClientState(tmpHome);
  for (const worktreeId of [A, B]) {
    await trpcMutate(server.url, TOKEN, "worktrees.setUnread", { worktreeId, unread: false });
    await trpcMutate(server.url, TOKEN, "statuses.update", {
      worktreeId,
      agent: { status: "idle" },
    });
  }
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

async function open(page: import("@playwright/test").Page, worktreeId = A) {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(worktreeId);
  await worktreePage.waitForReady();
  return new WorktreeUnreadPage(page);
}

test("a worktree marked unread shows the dot, also after a reload", async ({ page }) => {
  const unread = await open(page);
  await expect(unread.statusSlot(B)).toHaveAttribute("data-status", "idle");
  await unread.markViaMenu(B);
  await expect(unread.statusSlot(B)).toHaveAttribute("data-status", "unread");
  await expect.poll(() => unreadOf(B)).toBe(true);
  await page.reload();
  await expect(unread.statusSlot(B)).toHaveAttribute("data-status", "unread");
  await expect(unread.statusSlot(A)).toHaveAttribute("data-status", "idle");
});

test("selecting the worktree clears the mark for good", async ({ page }) => {
  await trpcMutate(server.url, TOKEN, "worktrees.setUnread", { worktreeId: B, unread: true });
  const unread = await open(page);
  await expect(unread.statusSlot(B)).toHaveAttribute("data-status", "unread");
  await unread.select(B);
  await expect(unread.statusSlot(B)).toHaveAttribute("data-status", "idle");
  await expect.poll(() => unreadOf(B)).toBe(false);
  await page.reload();
  await expect(unread.statusSlot(B)).toHaveAttribute("data-status", "idle");
});

test("marking the open worktree keeps the dot until the user leaves and returns", async ({
  page,
}) => {
  const unread = await open(page);
  await unread.markViaMenu(A);
  await expect(unread.statusSlot(A)).toHaveAttribute("data-status", "unread");
  // Clicking the open card again does not count as leaving it.
  await unread.card(A).click();
  await expect.poll(() => unreadOf(A)).toBe(true);
  await unread.select(B);
  await unread.select(A);
  await expect(unread.statusSlot(A)).toHaveAttribute("data-status", "idle");
  await expect.poll(() => unreadOf(A)).toBe(false);
});

test("the status dot toggles the mark without selecting the card", async ({ page }) => {
  await trpcMutate(server.url, TOKEN, "worktrees.setUnread", { worktreeId: B, unread: true });
  const unread = await open(page);
  await expect(unread.dotButton(B)).toHaveAccessibleName("Mark as read");
  await unread.dotButton(B).click();
  await expect(unread.statusSlot(B)).toHaveAttribute("data-status", "idle");
  await expect(unread.dotButton(B)).toHaveAccessibleName("Mark as unread");
  await expect(unread.card(B)).not.toHaveAttribute("aria-current", "page");
  await expect(unread.card(A)).toHaveAttribute("aria-current", "page");

  await unread.dotButton(B).click();
  await expect(unread.statusSlot(B)).toHaveAttribute("data-status", "unread");
  await expect(unread.card(A)).toHaveAttribute("aria-current", "page");
});

test("a finished worktree offers Mark as read, which clears its dot", async ({ page }) => {
  await trpcMutate(server.url, TOKEN, "statuses.update", {
    worktreeId: B,
    agent: { status: "done" },
  });
  const unread = await open(page);
  await expect(unread.statusSlot(B)).toHaveAttribute("data-status", "done");
  const item = await unread.openMenu(B);
  await expect(item).toHaveText("Mark as read");
  await item.click();
  await expect(unread.statusSlot(B)).toHaveAttribute("data-status", "idle");
  const menuItem = await unread.openMenu(B);
  await expect(menuItem).toHaveText("Mark as unread");
});

test("another browser sees the mark without reloading", async ({ page, browser }) => {
  const unread = await open(page);
  const second = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const other = await open(await second.newPage());
    await expect(other.statusSlot(B)).toHaveAttribute("data-status", "idle");
    await unread.markViaMenu(B);
    await expect(other.statusSlot(B)).toHaveAttribute("data-status", "unread");
  } finally {
    await second.close();
  }
});
