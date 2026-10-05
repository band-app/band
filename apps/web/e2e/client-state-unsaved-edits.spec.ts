/**
 * Unsaved file edits and untitled buffers are kept on the Band server
 * (`band-unsaved:<ws>:<path>`), so the phone and the desktop see the same
 * text. Last save wins, and a device that typed its own edits is warned when
 * another device's copy arrives instead of having its text replaced.
 *
 * Each test opens a desktop-width and a phone-width browser context against
 * one real server, in a worktree no other test uses; the contexts share
 * nothing but the server. No tRPC mocking.
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

const TOKEN = "e2e-client-state-unsaved-token";
const REPO = "unsaved-repo";
const FILE = "notes.txt";
// One worktree per test, so no test sees another's unsaved text on the server.
const TEST_BRANCHES = ["one", "two", "three", "four", "five"];

let server: ServerHandle;
let tmpHome: string;
let nextWorktree = 0;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repo = join(tmpHome, REPO);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, FILE), "first line\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  const worktrees = [{ branch: "main", path: repo }];
  for (const name of TEST_BRANCHES) {
    const path = join(tmpHome, `${REPO}-${name}`);
    git(repo, ["worktree", "add", "-b", name, path]);
    worktrees.push({ branch: name, path });
  }
  seedState(tmpHome, {
    repos: [{ name: REPO, path: repo, defaultBranch: "main", worktrees }],
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
  return toWorktreeId(REPO, branch);
}

const unsavedKey = (worktree: string, path: string) => `band-unsaved:${worktree}:${path}`;

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

/** Both devices show `FILE`; the phone typed "typed on the phone", the desktop
 *  took that copy and then typed " and the desktop" (the last save), and the
 *  phone is asked what to do. */
async function editOnBothDevices(
  worktree: string,
  desktop: WorktreePage,
  phone: WorktreePage,
  phoneStrip: CenterTabStrip,
): Promise<void> {
  const key = unsavedKey(worktree, FILE);
  await desktop.goto(worktree);
  await desktop.waitForReady();
  await desktop.openFileViaQuickOpen(FILE);
  await expect.poll(() => desktop.readSharedActiveTab(worktree)).toBe(`file:${FILE}`);

  await phone.goto(worktree);
  await phone.waitForMobileReady();
  await phoneStrip.tap(phone.fileTab(FILE));
  await phone.appendToActiveFileEditor("typed on the phone");
  await expect
    .poll(() => desktop.readServerClientState(worktree, key))
    .toBe("first line\ntyped on the phone");

  // The desktop hadn't typed, so it just shows the phone's text; the phone
  // isn't asked about its own write coming back.
  await expect(desktop.fileLeafLine("typed on the phone")).toBeVisible();
  await expect(desktop.remoteEditBanner).toHaveCount(0);
  await expect(phone.fileLeafLine("typed on the phone")).toBeVisible();
  await expect(phone.remoteEditBanner).toHaveCount(0);

  await desktop.appendToActiveFileEditor(" and the desktop");
  await expect
    .poll(() => desktop.readServerClientState(worktree, key))
    .toBe("first line\ntyped on the phone and the desktop");
  // The phone has the final copy, keeps its own text on screen and asks.
  await expect
    .poll(() => phone.readLocalStorageItem(key))
    .toBe("first line\ntyped on the phone and the desktop");
  await expect(phone.remoteEditBanner).toBeVisible();
  await expect(phone.fileLeafLine("typed on the phone")).toBeVisible();
}

test.describe("unsaved edits shared between desktop and phone", () => {
  test("an unsaved edit made on the desktop is in the phone's editor", async ({ browser }) => {
    const worktree = freshWorktree();
    const { contexts, desktop, phone, phoneStrip } = await openDevices(browser);
    try {
      await desktop.goto(worktree);
      await desktop.waitForReady();
      await desktop.openFileViaQuickOpen(FILE);
      await desktop.appendToActiveFileEditor("typed on the desktop");
      await expect
        .poll(() => desktop.readServerClientState(worktree, unsavedKey(worktree, FILE)))
        .toBe("first line\ntyped on the desktop");

      await phone.goto(worktree);
      await phone.waitForMobileReady();
      await phoneStrip.tap(phone.fileTab(FILE));
      await expect(phone.fileLeafLine("typed on the desktop")).toBeVisible();
    } finally {
      for (const context of contexts) await context.close();
    }
  });

  test("unsaved edits kept before the upgrade move to the server", async ({ browser }) => {
    const worktree = freshWorktree();
    const { contexts, desktop, phone, phoneStrip } = await openDevices(browser);
    try {
      // A browser that used Band before unsaved edits moved out of the tab state.
      await desktop.seedFileLeaves(worktree, [FILE]);
      await desktop.seedLocalStorageBeforeLoad({
        [`band-tab-state:${worktree}`]: JSON.stringify({
          [FILE]: { editedContent: "first line\nedited before the upgrade" },
        }),
      });
      await desktop.goto(worktree);
      await desktop.waitForReady();
      await expect(desktop.fileLeafLine("edited before the upgrade")).toBeVisible();
      await expect
        .poll(() => desktop.readServerClientState(worktree, unsavedKey(worktree, FILE)))
        .toBe("first line\nedited before the upgrade");

      await phone.goto(worktree);
      await phone.waitForMobileReady();
      await phoneStrip.tap(phone.fileTab(FILE));
      await expect(phone.fileLeafLine("edited before the upgrade")).toBeVisible();
    } finally {
      for (const context of contexts) await context.close();
    }
  });

  test("a device with its own edits is warned and can load the other device's copy", async ({
    browser,
  }) => {
    const worktree = freshWorktree();
    const { contexts, desktop, phone, phoneStrip } = await openDevices(browser);
    try {
      await editOnBothDevices(worktree, desktop, phone, phoneStrip);
      await phone.loadRemoteEdit();
      await expect(phone.fileLeafLine("typed on the phone and the desktop")).toBeVisible();
      await expect(phone.remoteEditBanner).toHaveCount(0);
    } finally {
      for (const context of contexts) await context.close();
    }
  });

  test("keeping this device's edits makes them the last save", async ({ browser }) => {
    const worktree = freshWorktree();
    const { contexts, desktop, phone, phoneStrip } = await openDevices(browser);
    try {
      await editOnBothDevices(worktree, desktop, phone, phoneStrip);
      await phone.keepOwnEdit();
      await expect(phone.remoteEditBanner).toHaveCount(0);
      await expect(phone.fileLeafLine("typed on the phone")).toBeVisible();
      await expect
        .poll(() => phone.readServerClientState(worktree, unsavedKey(worktree, FILE)))
        .toBe("first line\ntyped on the phone");
      // Now the desktop, which typed too, is the one asked.
      await expect(desktop.remoteEditBanner).toBeVisible();
    } finally {
      for (const context of contexts) await context.close();
    }
  });

  test("an untitled buffer written on the desktop opens with its text on the phone", async ({
    browser,
  }) => {
    const worktree = freshWorktree();
    const { contexts, desktop, phone, phoneStrip } = await openDevices(browser);
    try {
      await desktop.goto(worktree);
      await desktop.waitForReady();
      await desktop.openUntitledTab();
      await expect(desktop.fileTab("untitled:1")).toBeAttached();
      await desktop.appendToActiveFileEditor("scratch from the desktop");
      await expect
        .poll(() => desktop.readServerClientState(worktree, unsavedKey(worktree, "untitled:1")))
        .toBe("scratch from the desktop");
      await expect.poll(() => desktop.readSharedActiveTab(worktree)).toBe("file:untitled:1");

      await phone.goto(worktree);
      await phone.waitForMobileReady();
      await phoneStrip.tap(phone.fileTab("untitled:1"));
      await expect(phone.fileLeafLine("scratch from the desktop")).toBeVisible();

      // A new buffer in another desktop window takes the next number instead
      // of reusing 1 and sharing its text.
      const secondContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      contexts.push(secondContext);
      const secondDesktop = new WorktreePage(await secondContext.newPage(), server.url, TOKEN);
      await secondDesktop.goto(worktree);
      await secondDesktop.waitForReady();
      await expect(secondDesktop.fileTab("untitled:1")).toBeAttached();
      await secondDesktop.openUntitledTab();
      await expect(secondDesktop.fileTab("untitled:2")).toBeAttached();
    } finally {
      for (const context of contexts) await context.close();
    }
  });
});
