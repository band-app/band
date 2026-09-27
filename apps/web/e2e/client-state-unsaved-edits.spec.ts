/**
 * Unsaved file edits and untitled buffers are kept on the Band server
 * (`band-unsaved:<ws>:<path>`), so the phone and the desktop see the same
 * text. Last save wins, and a device editing a file when another device's
 * copy arrives is warned instead of having its text replaced silently.
 *
 * Each test opens a desktop-width and a phone-width browser context against
 * one real server; they share nothing but the server. No tRPC mocking.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type BrowserContext, expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
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
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-client-state-unsaved-token";
const PROJECT = "unsaved-repo";
const WORKSPACE = toWorkspaceId(PROJECT, "main");
const FILE = "notes.txt";

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repo = join(tmpHome, PROJECT);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, FILE), "first line\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repo }],
      },
    ],
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

async function openDevices(browser: Browser): Promise<{
  contexts: BrowserContext[];
  desktop: WorkspacePage;
  phone: WorkspacePage;
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
    desktop: new WorkspacePage(await desktopContext.newPage(), server.url, TOKEN),
    phone: new WorkspacePage(phonePage, server.url, TOKEN),
    phoneStrip: new CenterTabStrip(phonePage),
  };
}

const unsavedKey = (path: string) => `band-unsaved:${WORKSPACE}:${path}`;

test.describe("unsaved edits shared between desktop and phone", () => {
  test("an unsaved edit made on the desktop is in the phone's editor", async ({ browser }) => {
    const { contexts, desktop, phone, phoneStrip } = await openDevices(browser);
    try {
      await desktop.goto(WORKSPACE);
      await desktop.waitForReady();
      await desktop.openFileViaQuickOpen(FILE);
      await desktop.appendToActiveFileEditor("typed on the desktop");
      await expect
        .poll(() => desktop.readServerClientState(WORKSPACE, unsavedKey(FILE)))
        .toBe("first line\ntyped on the desktop");

      await phone.goto(WORKSPACE);
      await phone.waitForMobileReady();
      await phoneStrip.tap(phone.fileTab(FILE));
      await expect(phone.fileLeafLine("typed on the desktop")).toBeVisible();
    } finally {
      for (const context of contexts) await context.close();
    }
  });

  test("a device with its own edits is warned when another device's copy arrives", async ({
    browser,
  }) => {
    const { contexts, desktop, phone, phoneStrip } = await openDevices(browser);
    try {
      await desktop.goto(WORKSPACE);
      await desktop.waitForReady();
      await desktop.openFileViaQuickOpen(FILE);
      await expect.poll(() => desktop.readSharedActiveTab(WORKSPACE)).toBe(`file:${FILE}`);

      await phone.goto(WORKSPACE);
      await phone.waitForMobileReady();
      await phoneStrip.tap(phone.fileTab(FILE));
      await phone.appendToActiveFileEditor("typed on the phone");
      await expect
        .poll(() => desktop.readServerClientState(WORKSPACE, unsavedKey(FILE)))
        .toBe("first line\ntyped on the phone");

      // The desktop had no edits of its own, so it just shows the phone's text…
      await expect(desktop.fileLeafLine("typed on the phone")).toBeVisible();
      await expect(desktop.remoteEditBanner).toHaveCount(0);
      // …and its next edit is the last save.
      await desktop.appendToActiveFileEditor(" and the desktop");
      await expect
        .poll(() => desktop.readServerClientState(WORKSPACE, unsavedKey(FILE)))
        .toBe("first line\ntyped on the phone and the desktop");

      // The phone still has its own text on screen and is asked what to do.
      await expect(phone.remoteEditBanner).toBeVisible();
      await expect(phone.fileLeafLine("typed on the phone")).toBeVisible();
      await phone.loadRemoteEdit();
      await expect(phone.fileLeafLine("typed on the phone and the desktop")).toBeVisible();
      await expect(phone.remoteEditBanner).toHaveCount(0);
    } finally {
      for (const context of contexts) await context.close();
    }
  });

  test("an untitled buffer written on the desktop opens with its text on the phone", async ({
    browser,
  }) => {
    const { contexts, desktop, phone, phoneStrip } = await openDevices(browser);
    try {
      await desktop.goto(WORKSPACE);
      await desktop.waitForReady();
      await desktop.openUntitledTab();
      await expect(desktop.fileTab("untitled:1")).toBeAttached();
      await desktop.appendToActiveFileEditor("scratch from the desktop");
      await expect
        .poll(() => desktop.readServerClientState(WORKSPACE, unsavedKey("untitled:1")))
        .toBe("scratch from the desktop");
      await expect.poll(() => desktop.readSharedActiveTab(WORKSPACE)).toBe("file:untitled:1");

      await phone.goto(WORKSPACE);
      await phone.waitForMobileReady();
      await phoneStrip.tap(phone.fileTab("untitled:1"));
      await expect(phone.fileLeafLine("scratch from the desktop")).toBeVisible();

      // A new buffer in another desktop window takes the next number instead
      // of reusing 1 and sharing its text.
      const secondContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      contexts.push(secondContext);
      const secondDesktop = new WorkspacePage(await secondContext.newPage(), server.url, TOKEN);
      await secondDesktop.goto(WORKSPACE);
      await secondDesktop.waitForReady();
      await expect(secondDesktop.fileTab("untitled:1")).toBeAttached();
      await secondDesktop.openUntitledTab();
      await expect(secondDesktop.fileTab("untitled:2")).toBeAttached();
    } finally {
      for (const context of contexts) await context.close();
    }
  });
});
