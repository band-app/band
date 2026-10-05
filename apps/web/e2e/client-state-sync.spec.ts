/**
 * UI state the dashboard keeps on the Band server, beyond the center tabs
 * (`client-state-shared-tabs.spec.ts` covers those).
 *
 * Each test opens separate browser contexts against one real server, so the
 * contexts share nothing but the server:
 *   - a chat draft typed on the desktop is in the phone's prompt;
 *   - values a browser kept in localStorage before this change are uploaded
 *     on its first load, so another browser gets them;
 *   - a per-device-type value (the collapsed sidebar) reaches another desktop
 *     but not the phone, while a shared one (recent worktrees) reaches both.
 *
 * Chats talk to the scripted ACP stub agent; nothing on the server is mocked.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type BrowserContext, expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { acpStubEnv } from "./helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChatPanePage } from "./pages/ChatPanePage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-client-state-sync-token";
const REPO = "sync-proj";
const WORKTREE = toWorktreeId(REPO, "main");
const DESKTOP = { viewport: { width: 1280, height: 800 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, "repo");
  mkdirSync(repoDir, { recursive: true });
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir }],
      },
    ],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  server = await startServer({ tmpHome, env: acpStubEnv(tmpHome) });
});

// UI state lives on the server now: start each test from none, like the
// fresh localStorage each test's browser context used to give it.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

async function newContexts(
  browser: Browser,
  options: (typeof DESKTOP | typeof PHONE)[],
): Promise<BrowserContext[]> {
  return Promise.all(options.map((o) => browser.newContext(o)));
}

test.describe("client state kept on the server", () => {
  test("a chat draft typed on the desktop is in the phone's prompt", async ({ browser }) => {
    const contexts = await newContexts(browser, [DESKTOP, PHONE]);
    try {
      const desktopPage = await contexts[0].newPage();
      const desktop = new ChatPanePage(desktopPage, server.url, TOKEN);
      const desktopWorktree = new WorktreePage(desktopPage, server.url, TOKEN);
      await desktop.goto(WORKTREE);
      await desktop.waitForReady();
      await desktop.typeMessage("half-written on the desktop");
      await expect
        .poll(() => desktopWorktree.readServerClientState(WORKTREE, `band-draft:${WORKTREE}`))
        .toBe("half-written on the desktop");

      const phone = new ChatPanePage(await contexts[1].newPage(), server.url, TOKEN);
      await phone.goto(WORKTREE);
      await phone.waitForReady();
      await expect.poll(() => phone.promptValue()).toBe("half-written on the desktop");
    } finally {
      for (const context of contexts) await context.close();
    }
  });

  test("a change made while its predecessor's push was unanswered is kept, not replaced by the server copy", async ({
    browser,
  }) => {
    const contexts = await newContexts(browser, [DESKTOP, DESKTOP]);
    try {
      // The server holds version 1 of the collapsed sidebar.
      const first = new WorktreePage(await contexts[0].newPage(), server.url, TOKEN);
      await first.seedLocalStorageBeforeLoad({ "band:sidebar-collapsed": "1" });
      await first.goto(WORKTREE);
      await first.waitForReady();
      await expect
        .poll(() => first.readServerClientState(null, "band:sidebar-collapsed"))
        .toBe("1");

      // A page that sent a write on top of version 0 and closed before the
      // answer: the server has that write (version 1), and the user changed
      // the value again afterwards. The newer local value must win.
      const entry = "desktop|band:sidebar-collapsed";
      const reopened = new WorktreePage(await contexts[1].newPage(), server.url, TOKEN);
      await reopened.seedLocalStorageBeforeLoad({
        "band:sidebar-collapsed": "0",
        "band:client-state:v1": JSON.stringify({
          versions: {},
          pending: [entry],
          sent: { [entry]: 0 },
        }),
      });
      await reopened.goto(WORKTREE);
      await reopened.waitForReady();
      await expect
        .poll(() => reopened.readServerClientState(null, "band:sidebar-collapsed"))
        .toBe("0");
      expect(await reopened.readSidebarCollapsed()).toBe(false);
    } finally {
      for (const context of contexts) await context.close();
    }
  });

  test("localStorage kept before the upgrade is uploaded, per device type", async ({ browser }) => {
    const contexts = await newContexts(browser, [DESKTOP, DESKTOP, PHONE]);
    try {
      // A browser that used Band before its UI state moved to the server.
      const upgraded = new WorktreePage(await contexts[0].newPage(), server.url, TOKEN);
      await upgraded.seedLocalStorageBeforeLoad({
        "band:sidebar-collapsed": "1",
        "band-recent-worktrees": JSON.stringify([WORKTREE]),
      });
      await upgraded.goto(WORKTREE);
      await upgraded.waitForReady();
      await expect
        .poll(() => upgraded.readServerClientState(null, "band:sidebar-collapsed"))
        .toBe("1");
      await expect
        .poll(() => upgraded.readServerClientState(null, "band-recent-worktrees"))
        .toEqual([WORKTREE]);

      // Another desktop gets both: the collapsed sidebar is per device type.
      const otherDesktop = new WorktreePage(await contexts[1].newPage(), server.url, TOKEN);
      await otherDesktop.goto(WORKTREE);
      await otherDesktop.waitForReady();
      await expect.poll(() => otherDesktop.readSidebarCollapsed()).toBe(true);
      await expect.poll(() => otherDesktop.sidebarWidth()).toBeLessThan(10);

      // The phone gets the shared recent list (the anchor that its hydration
      // ran) but keeps its own, unset sidebar state.
      const phone = new WorktreePage(await contexts[2].newPage(), server.url, TOKEN);
      await phone.goto(WORKTREE);
      await phone.waitForMobileReady();
      await expect
        .poll(() => phone.readLocalStorageItem("band-recent-worktrees"))
        .toBe(JSON.stringify([WORKTREE]));
      expect(await phone.readLocalStorageItem("band:sidebar-collapsed")).toBeNull();
      expect(
        await phone.readServerClientState(null, "band:sidebar-collapsed", "mobile"),
      ).toBeNull();
    } finally {
      for (const context of contexts) await context.close();
    }
  });
});
