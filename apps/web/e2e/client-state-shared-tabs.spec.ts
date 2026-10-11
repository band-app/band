/**
 * The phone and the desktop show the same center tabs for a worktree.
 *
 * The tab list lives on the Band server (`clientState.*`, key
 * `band:center-tabs:<ws>`) instead of each browser's localStorage. Each test
 * opens two browser contexts against one real server: a desktop-width one
 * and a phone-width touch one, so they share nothing but the server. A tab
 * opened on one must appear on the other, both on a fresh load and live while
 * the other is already showing the worktree, and a tab closed on the phone
 * must close on the desktop.
 *
 * No tRPC mocking: both pages drive the real server through Quick Open and
 * the tab close button.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type BrowserContext, expect, test } from "@playwright/test";
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

const TOKEN = "e2e-client-state-shared-tabs-token";
const REPO = "shared-tabs-repo";
const BRANCH = "main";
const FILES = ["shared-alpha.txt", "shared-beta.txt", "shared-gamma.txt"];
// One worktree per test, so no test sees another's tabs on the server.
const TEST_BRANCHES = ["one", "two", "three"];

let server: ServerHandle;
let tmpHome: string;
let repo: string;
let nextWorktree = 0;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repo = join(tmpHome, REPO);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", BRANCH]);
  for (const file of FILES) writeFileSync(join(repo, file), `${file}\n`);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  const worktrees = [{ branch: BRANCH, path: repo }];
  for (const name of TEST_BRANCHES) {
    const path = join(tmpHome, `${REPO}-${name}`);
    git(repo, ["worktree", "add", "-b", name, path]);
    worktrees.push({ branch: name, path });
  }
  seedState(tmpHome, {
    repos: [{ name: REPO, path: repo, defaultBranch: BRANCH, worktrees }],
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

/** A worktree no earlier test has touched. */
function freshWorktree(): string {
  const branch = TEST_BRANCHES[nextWorktree];
  if (!branch) throw new Error("add a branch to TEST_BRANCHES for the new test");
  nextWorktree += 1;
  return toWorktreeId(REPO, branch, "local");
}

async function openDevices(browser: Browser): Promise<{
  contexts: BrowserContext[];
  desktop: WorktreePage;
  phone: WorktreePage;
  phoneStrip: CenterTabStrip;
}> {
  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const phoneContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const phonePage = await phoneContext.newPage();
  return {
    contexts: [desktopContext, phoneContext],
    desktop: new WorktreePage(await desktopContext.newPage(), server.url, TOKEN),
    phone: new WorktreePage(phonePage, server.url, TOKEN),
    phoneStrip: new CenterTabStrip(phonePage),
  };
}

test.describe("center tabs shared between desktop and phone", () => {
  test("a file opened on the desktop is open and active on the phone", async ({ browser }) => {
    const worktree = freshWorktree();
    const { contexts, desktop, phone } = await openDevices(browser);
    try {
      await desktop.goto(worktree);
      await desktop.waitForReady();
      await desktop.openFileViaQuickOpen(FILES[0]);
      await desktop.openFileViaQuickOpen(FILES[1]);
      await expect(desktop.fileLeafLine(FILES[1])).toBeVisible();
      await expect.poll(() => desktop.readSharedActiveTab(worktree)).toBe(`file:${FILES[1]}`);

      await phone.goto(worktree);
      await phone.waitForMobileReady();
      await expect(phone.fileTab(FILES[0])).toBeAttached();
      await expect(phone.fileTab(FILES[1])).toBeAttached();
      // The desktop's active tab is the phone's active tab.
      await expect(phone.fileLeafLine(FILES[1])).toBeVisible();
    } finally {
      for (const context of contexts) await context.close();
    }
  });

  test("a file opened on the desktop appears live on a phone showing the worktree", async ({
    browser,
  }) => {
    const worktree = freshWorktree();
    const { contexts, desktop, phone } = await openDevices(browser);
    try {
      await desktop.goto(worktree);
      await desktop.waitForReady();
      await desktop.openFileViaQuickOpen(FILES[0]);
      await expect.poll(() => desktop.readSharedActiveTab(worktree)).toBe(`file:${FILES[0]}`);

      await phone.goto(worktree);
      await phone.waitForMobileReady();
      await expect(phone.fileLeafLine(FILES[0])).toBeVisible();

      await desktop.openFileViaQuickOpen(FILES[2]);
      await expect(phone.fileTab(FILES[2])).toBeAttached();
      // The desktop made the new tab active, and the server has that…
      await expect.poll(() => desktop.readSharedActiveTab(worktree)).toBe(`file:${FILES[2]}`);
      // …but the phone user stays on the tab they were looking at.
      await expect(phone.fileLeafLine(FILES[0])).toBeVisible();
      await expect(phone.fileLeafLine(FILES[2])).toHaveCount(0);
    } finally {
      for (const context of contexts) await context.close();
    }
  });

  test("a file tab closed on the phone closes on the desktop", async ({ browser }) => {
    const worktree = freshWorktree();
    const { contexts, desktop, phone, phoneStrip } = await openDevices(browser);
    try {
      await desktop.goto(worktree);
      await desktop.waitForReady();
      await desktop.openFileViaQuickOpen(FILES[0]);
      await desktop.openFileViaQuickOpen(FILES[1]);
      await expect.poll(() => desktop.readSharedActiveTab(worktree)).toBe(`file:${FILES[1]}`);

      await phone.goto(worktree);
      await phone.waitForMobileReady();
      await expect(phone.fileTab(FILES[0])).toBeAttached();
      await phoneStrip.tap(phone.fileTab(FILES[0]));
      await phoneStrip.tap(phone.fileTabCloseButton(FILES[0]));
      await expect(phone.fileTab(FILES[0])).toHaveCount(0);

      // Anchor: the other tab is still open on the desktop.
      await expect(desktop.fileTab(FILES[1])).toBeAttached();
      await expect(desktop.fileTab(FILES[0])).toHaveCount(0);
    } finally {
      for (const context of contexts) await context.close();
    }
  });
});
