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
 *     but not the phone, while a shared one (recent workspaces) reaches both.
 *
 * Chats talk to the scripted ACP stub agent; nothing on the server is mocked.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type BrowserContext, expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
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
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-client-state-sync-token";
const PROJECT = "sync-proj";
const WORKSPACE = toWorkspaceId(PROJECT, "main");
const DESKTOP = { viewport: { width: 1280, height: 800 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, "repo");
  mkdirSync(repoDir, { recursive: true });
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
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
      const desktopWorkspace = new WorkspacePage(desktopPage, server.url, TOKEN);
      await desktop.goto(WORKSPACE);
      await desktop.waitForReady();
      await desktop.typeMessage("half-written on the desktop");
      await expect
        .poll(() => desktopWorkspace.readServerClientState(WORKSPACE, `band-draft:${WORKSPACE}`))
        .toBe("half-written on the desktop");

      const phone = new ChatPanePage(await contexts[1].newPage(), server.url, TOKEN);
      await phone.goto(WORKSPACE);
      await phone.waitForReady();
      await expect.poll(() => phone.promptValue()).toBe("half-written on the desktop");
    } finally {
      for (const context of contexts) await context.close();
    }
  });

  test("localStorage kept before the upgrade is uploaded, per device type", async ({ browser }) => {
    const contexts = await newContexts(browser, [DESKTOP, DESKTOP, PHONE]);
    try {
      // A browser that used Band before its UI state moved to the server.
      const upgraded = new WorkspacePage(await contexts[0].newPage(), server.url, TOKEN);
      await upgraded.seedLocalStorageBeforeLoad({
        "band:sidebar-collapsed": "1",
        "band-recent-workspaces": JSON.stringify([WORKSPACE]),
      });
      await upgraded.goto(WORKSPACE);
      await upgraded.waitForReady();
      await expect
        .poll(() => upgraded.readServerClientState(null, "band:sidebar-collapsed"))
        .toBe("1");
      await expect
        .poll(() => upgraded.readServerClientState(null, "band-recent-workspaces"))
        .toEqual([WORKSPACE]);

      // Another desktop gets both: the collapsed sidebar is per device type.
      const otherDesktop = new WorkspacePage(await contexts[1].newPage(), server.url, TOKEN);
      await otherDesktop.goto(WORKSPACE);
      await otherDesktop.waitForReady();
      await expect.poll(() => otherDesktop.readSidebarCollapsed()).toBe(true);
      await expect.poll(() => otherDesktop.sidebarWidth()).toBeLessThan(10);

      // The phone gets the shared recent list (the anchor that its hydration
      // ran) but keeps its own, unset sidebar state.
      const phone = new WorkspacePage(await contexts[2].newPage(), server.url, TOKEN);
      await phone.goto(WORKSPACE);
      await phone.waitForMobileReady();
      await expect
        .poll(() => phone.readLocalStorageItem("band-recent-workspaces"))
        .toBe(JSON.stringify([WORKSPACE]));
      expect(await phone.readLocalStorageItem("band:sidebar-collapsed")).toBeNull();
      expect(
        await phone.readServerClientState(null, "band:sidebar-collapsed", "mobile"),
      ).toBeNull();
    } finally {
      for (const context of contexts) await context.close();
    }
  });
});
