/**
 * End-to-end coverage for the desktop app's bundled UI and hub picker.
 *
 * Architecture:
 *
 *   - The REAL Electron app (`apps/desktop`, unpackaged) is launched with
 *     Playwright's `_electron` against a throwaway HOME. It spawns the real hub
 *     bundle (`apps/hub/dist/start-server.mjs`) in local mode and loads the UI
 *     from `apps/web/dist/client` over `app://`.
 *   - The "remote" hub is a second real hub bundle on another port with its own
 *     HOME and token, started with the same `startServer` the web specs use.
 *   - The only stub is the scripted ACP agent at the coding-agent boundary.
 *     Each hub's agent says a different sentence, so a reply shows which hub
 *     answered.
 *   - No tRPC mocking and no `page.route()`. The UI is driven through page
 *     objects.
 *
 * What it does not cover: the macOS shell (folder picker), terminals and
 * browser panes (`<webview>`), and the auto-updater. They need a packaged app
 * or real macOS dialogs.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { acpStubEnv } from "../e2e/helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  getRandomPort,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "../e2e/helpers/server";
import { type LaunchedDesktop, launchDesktop } from "./helpers/desktop-app";
import { DesktopDashboardPage } from "./pages/DesktopDashboardPage";
import { HubPickerPage } from "./pages/HubPickerPage";
import { HubUnreachablePage } from "./pages/HubUnreachablePage";

const LOCAL_TOKEN = "desktop-e2e-local-token";
const REMOTE_TOKEN = "desktop-e2e-remote-token";
const LOCAL_WORKSPACE = toWorkspaceId("localproj", "main");
const REMOTE_WORKSPACE = toWorkspaceId("remoteproj", "main");
const LOCAL_REPLY = "Reply from the local hub";
const REMOTE_REPLY = "Reply from the remote hub";

interface HubHome {
  home: string;
  port: number;
}

/** A HOME with one project, a token, a coding agent and the scripted reply. */
async function seedHome(project: string, reply: string, token: string): Promise<HubHome> {
  const home = createTmpHome();
  const repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  seedState(home, {
    projects: [
      {
        name: project,
        path: repo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repo }],
      },
    ],
  });
  // The desktop app spawns the local hub on `webServerPort` and kills whatever
  // listens there first, so it must be a random free port, never 3456.
  const port = await getRandomPort();
  seedSettings(home, {
    tokenSecret: token,
    webServerPort: port,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  acpStubEnv(home, { turns: [{ steps: [{ say: reply }] }] });
  return { home, port };
}

async function localHubAnswers(port: number, token: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1_500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

let remote: ServerHandle;
let remoteHome: string;
const homes: string[] = [];
let desktop: LaunchedDesktop | null = null;

test.beforeAll(async () => {
  const seeded = await seedHome("remoteproj", REMOTE_REPLY, REMOTE_TOKEN);
  remoteHome = seeded.home;
  remote = await startServer({
    tmpHome: remoteHome,
    env: acpStubEnv(remoteHome, { turns: [{ steps: [{ say: REMOTE_REPLY }] }] }),
  });
});

test.afterAll(async () => {
  await remote?.close();
  cleanupTmpHome(remoteHome);
  for (const home of homes) cleanupTmpHome(home);
});

test.afterEach(async () => {
  await desktop?.close();
  desktop = null;
});

/** A local-hub desktop HOME, launched, with its stub agent wired through the env. */
async function launchLocal(): Promise<{ app: LaunchedDesktop; hub: HubHome }> {
  const hub = await seedHome("localproj", LOCAL_REPLY, LOCAL_TOKEN);
  homes.push(hub.home);
  const app = await launchDesktop({
    home: hub.home,
    hubPort: hub.port,
    env: acpStubEnv(hub.home, { turns: [{ steps: [{ say: LOCAL_REPLY }] }] }),
  });
  desktop = app;
  return { app, hub };
}

test.describe("Desktop app: bundled UI and hub picker", () => {
  test("local hub: loads app://, spawns the hub, streams a chat reply, keeps the route on reload", async () => {
    const { app, hub } = await launchLocal();
    const dashboard = new DesktopDashboardPage(app.window);

    // The window loads the bundled UI, not the hub's URL.
    expect(dashboard.url()).toMatch(/^app:\/\/local\//);

    // The local hub was spawned and answers with the token.
    await expect.poll(() => localHubAnswers(hub.port, LOCAL_TOKEN), { timeout: 30_000 }).toBe(true);

    await dashboard.expectProjectListed("localproj");
    await dashboard.openWorkspace(LOCAL_WORKSPACE);

    await dashboard.chat.typeMessage("hello from the desktop app");
    await dashboard.chat.submit();
    await expect(dashboard.chat.userMessage("hello from the desktop app")).toBeVisible();
    await expect(dashboard.chat.assistantMessage(LOCAL_REPLY)).toBeVisible({ timeout: 30_000 });

    // S3: a reload and a deep link keep the route.
    const route = new URL(dashboard.url()).pathname;
    expect(route).toBe(`/workspace/${encodeURIComponent(LOCAL_WORKSPACE)}`);
    await dashboard.reload();
    expect(new URL(dashboard.url()).pathname).toBe(route);
    await dashboard.chat.waitForReady();
    await dashboard.gotoDeepLink(LOCAL_WORKSPACE);
    expect(new URL(dashboard.url()).pathname).toBe(route);
    await dashboard.chat.waitForReady();

    // The CSP lets all of that through.
    expect(app.cspViolations).toEqual([]);
  });

  test("remote hub chosen at launch: no local hub is spawned and the UI works against the remote hub", async () => {
    const hub = await seedHome("unused", "unused", LOCAL_TOKEN);
    homes.push(hub.home);
    // The saved choice a previous run of the picker left behind.
    writeFileSync(
      join(hub.home, ".band", "desktop-hub.json"),
      JSON.stringify({ mode: "remote", url: remote.url, token: REMOTE_TOKEN }),
    );
    const app = await launchDesktop({ home: hub.home, hubPort: hub.port });
    desktop = app;
    const dashboard = new DesktopDashboardPage(app.window);

    expect(dashboard.url()).toMatch(/^app:\/\/h-[0-9a-f]{12}\//);

    // The remote hub's workspace is listed, not the (unseeded) local one.
    await dashboard.expectProjectListed("remoteproj");
    await dashboard.openWorkspace(REMOTE_WORKSPACE);
    await dashboard.chat.typeMessage("hello remote");
    await dashboard.chat.submit();
    await expect(dashboard.chat.assistantMessage(REMOTE_REPLY)).toBeVisible({ timeout: 30_000 });

    // Nothing listens on the local hub's port, and it never wrote a server log.
    expect(await localHubAnswers(hub.port, LOCAL_TOKEN)).toBe(false);
    expect(existsSync(join(hub.home, ".band", "server.log"))).toBe(false);
    expect(app.cspViolations).toEqual([]);
  });

  test("a saved remote hub that is down offers Retry and Use local, and Use local starts the local hub", async () => {
    const hub = await seedHome("localproj", LOCAL_REPLY, LOCAL_TOKEN);
    homes.push(hub.home);
    // Nothing listens on this port: the saved hub is down.
    const deadPort = await getRandomPort();
    writeFileSync(
      join(hub.home, ".band", "desktop-hub.json"),
      JSON.stringify({ mode: "remote", url: `http://127.0.0.1:${deadPort}`, token: REMOTE_TOKEN }),
    );
    const app = await launchDesktop({
      home: hub.home,
      hubPort: hub.port,
      firstPage: "unreachable",
      env: acpStubEnv(hub.home, { turns: [{ steps: [{ say: LOCAL_REPLY }] }] }),
    });
    desktop = app;
    const unreachable = new HubUnreachablePage(app.window);
    await unreachable.expectShown();
    // No local hub yet: the window shows the choice instead of a blank page.
    expect(await localHubAnswers(hub.port, LOCAL_TOKEN)).toBe(false);

    // Retry against the same dead hub keeps the page and says why.
    await unreachable.clickRetry();
    await unreachable.expectShown();
    await unreachable.expectReasonShown();

    await unreachable.clickUseLocal();
    const dashboard = new DesktopDashboardPage(app.window);
    await expect.poll(() => dashboard.url(), { timeout: 60_000 }).toMatch(/^app:\/\/local\//);
    await dashboard.expectProjectListed("localproj");
    expect(await localHubAnswers(hub.port, LOCAL_TOKEN)).toBe(true);
    expect(app.cspViolations).toEqual([]);
  });

  test("the picker switches hubs live, keeps each hub's storage apart and refuses a bad token", async () => {
    const { app, hub } = await launchLocal();
    const dashboard = new DesktopDashboardPage(app.window);
    const picker = new HubPickerPage(app.window);
    await dashboard.expectProjectListed("localproj");
    await dashboard.writeStorage("e2e-marker", "local");
    const localUrl = dashboard.url();

    // A wrong token is refused in the picker and nothing changes.
    await picker.open();
    await picker.chooseRemote(remote.url, "wrong-token");
    await expect(picker.error).toBeVisible();
    expect(dashboard.url()).toBe(localUrl);

    // The right one reloads the window on the remote hub's own host.
    await picker.chooseRemote(remote.url, REMOTE_TOKEN);
    await expect
      .poll(() => dashboard.url(), { timeout: 30_000 })
      .toMatch(/^app:\/\/h-[0-9a-f]{12}\//);
    await dashboard.expectProjectListed("remoteproj");
    // The other hub's storage is not visible here.
    expect(await dashboard.readStorage("e2e-marker")).toBeNull();
    // The local hub was stopped.
    await expect
      .poll(() => localHubAnswers(hub.port, LOCAL_TOKEN), { timeout: 30_000 })
      .toBe(false);

    // Back to local: the hub starts again and its storage is intact.
    await picker.open();
    await picker.chooseLocal();
    await expect.poll(() => dashboard.url(), { timeout: 60_000 }).toMatch(/^app:\/\/local\//);
    await dashboard.expectProjectListed("localproj");
    expect(await dashboard.readStorage("e2e-marker")).toBe("local");
    await expect.poll(() => localHubAnswers(hub.port, LOCAL_TOKEN), { timeout: 30_000 }).toBe(true);
  });

  test("the window cannot be navigated away from app:// or opened into another window", async () => {
    const { app } = await launchLocal();
    const dashboard = new DesktopDashboardPage(app.window);
    await dashboard.expectProjectListed("localproj");
    const windowsBefore = app.windowCount();

    await dashboard.navigateTo("app://h-000000000000/");
    await dashboard.navigateTo("file:///etc/hosts");
    await dashboard.openWindow("app://local/");
    await dashboard.openWindow("file:///etc/hosts");

    // A fresh in-app navigation queues behind the attempts above, so once the
    // dashboard renders again a wrongly allowed navigation or window would
    // already have shown up.
    await dashboard.gotoDeepLink(LOCAL_WORKSPACE);
    await dashboard.expectProjectListed("localproj");
    expect(dashboard.url()).toContain("app://local/");
    expect(dashboard.url()).not.toContain("h-000000000000");
    expect(app.windowCount()).toBe(windowsBefore);
  });

  test("browser panes still attach their <webview> guests under app://", async () => {
    const { app } = await launchLocal();
    const dashboard = new DesktopDashboardPage(app.window);
    await dashboard.expectProjectListed("localproj");
    await dashboard.gotoDeepLink(LOCAL_WORKSPACE);
    await dashboard.openBrowserTab();
    expect(await dashboard.expectBrowserGuestAttached()).toBeGreaterThan(0);
    expect(app.cspViolations).toEqual([]);
  });
});
