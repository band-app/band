/**
 * End-to-end coverage for the desktop app's local hub running as a launchd agent.
 *
 * Architecture:
 *
 *   - The REAL Electron app is launched against a throwaway HOME, with a seeded repo in
 *     `~/.band`. A second real hub stands in for the remote hub of the stop/keep case.
 *   - The only fake is `launchctl` (`fixtures/fake-launchctl.mjs`, through `BAND_LAUNCHCTL_BIN`).
 *     It behaves like launchd for the `app.band.hub` label and starts the real hub from the
 *     plist, so the hub is a process of its own that outlives the app. The LaunchAgents
 *     directory is under the temp HOME, so nothing touches the real launchd.
 *   - No tRPC mocking and no `page.route()`. The hub is read with plain HTTP calls to its
 *     health endpoint, and the plist is read from disk.
 *
 * Under `BAND_DESKTOP_EXECUTABLE` the same specs run against the packaged app, which also checks
 * that the plist points inside the app bundle. A real launchd agent surviving an app quit and an
 * app update is checked by hand on a packaged build.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  getRandomPort,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "../e2e/helpers/server";
import { isPackagedRun, type LaunchedDesktop, launchDesktop } from "./helpers/desktop-app";
import { DesktopDashboardPage } from "./pages/DesktopDashboardPage";
import { HubPickerPage } from "./pages/HubPickerPage";

const LOCAL_TOKEN = "desktop-hub-service-local-token";
const REMOTE_TOKEN = "desktop-hub-service-remote-token";
const FAKE_LAUNCHCTL = join(import.meta.dirname, "fixtures", "fake-launchctl.mjs");
const LABEL = "app.band.hub";
const WORKTREE = toWorktreeId("serviceproj", "main", "local");

let remote: ServerHandle;
let remoteHome: string;
const homes: string[] = [];
let desktop: LaunchedDesktop | null = null;
let launchedHome: string | null = null;

async function hubAnswers(port: number, token: string): Promise<boolean> {
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

function plistFile(home: string): string {
  return join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

/** The program and environment of the installed plist. */
function readPlist(home: string): { program: string[]; env: Record<string, string> } {
  const text = readFileSync(plistFile(home), "utf8");
  const section = (key: string) =>
    new RegExp(`<key>${key}</key>\\s*<(?:array|dict)>([\\s\\S]*?)</(?:array|dict)>`).exec(
      text,
    )?.[1] ?? "";
  const program = [...section("ProgramArguments").matchAll(/<string>([\s\S]*?)<\/string>/g)].map(
    (m) => m[1] ?? "",
  );
  const env: Record<string, string> = {};
  for (const m of section("EnvironmentVariables").matchAll(
    /<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g,
  )) {
    env[m[1] ?? ""] = m[2] ?? "";
  }
  return { program, env };
}

/** A HOME with one repo and an existing token, the way a user of an older app has it. */
async function seedHome(): Promise<{ home: string; port: number }> {
  const home = createTmpHome();
  homes.push(home);
  const repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  seedState(home, {
    repos: [
      {
        name: "serviceproj",
        path: repo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repo }],
      },
    ],
  });
  const port = await getRandomPort();
  seedSettings(home, {
    tokenSecret: LOCAL_TOKEN,
    webServerPort: port,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  return { home, port };
}

async function launch() {
  const { home, port } = await seedHome();
  launchedHome = home;
  desktop = await launchDesktop({
    home,
    hubPort: port,
    answeredWorkerPrompt: [remote.url],
    env: {
      BAND_LAUNCHCTL_BIN: FAKE_LAUNCHCTL,
      BAND_FAKE_LAUNCHD_DIR: join(home, "fake-launchd"),
    },
  });
  return { home, port, app: desktop };
}

test.beforeAll(async () => {
  remoteHome = createTmpHome();
  seedSettings(remoteHome, { tokenSecret: REMOTE_TOKEN, webServerPort: await getRandomPort() });
  remote = await startServer({ tmpHome: remoteHome });
});

test.afterAll(async () => {
  await remote?.close();
  cleanupTmpHome(remoteHome);
  for (const home of homes) cleanupTmpHome(home);
});

test.afterEach(async () => {
  await desktop?.close();
  desktop = null;
  // The fake launchd leaves the hub it started running. Stop it.
  if (launchedHome) {
    spawnSync(FAKE_LAUNCHCTL, ["bootout", `gui/0/${LABEL}`], {
      env: { ...process.env, BAND_FAKE_LAUNCHD_DIR: join(launchedHome, "fake-launchd") },
    });
  }
  launchedHome = null;
});

test.describe("Desktop app: the local hub as a launchd service", () => {
  test("S1, S5: the first start installs app.band.hub and the hub serves the existing data", async () => {
    const { home, port, app } = await launch();
    const dashboard = new DesktopDashboardPage(app.window);

    // The UI loads from the bundled build and the seeded repo from ~/.band is listed.
    await expect.poll(() => dashboard.url(), { timeout: 60_000 }).toMatch(/^app:\/\/local\//);
    await dashboard.expectRepoListed("serviceproj");
    await dashboard.openWorktree(WORKTREE);
    expect(await hubAnswers(port, LOCAL_TOKEN)).toBe(true);

    // The plist runs the hub entry through the app executable, with the port from settings.json.
    const { program, env } = readPlist(home);
    expect(program[1]).toMatch(/dist\/start-server\.mjs$/);
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.PORT).toBe(String(port));
    expect(env.BAND_HOME).toBe(join(home, ".band"));
    if (isPackagedRun()) {
      expect(program[0]).toContain(".app/Contents/");
      expect(program[1]).toContain(".app/Contents/Resources/");
    }
    expect(readFileSync(plistFile(home), "utf8")).not.toContain(LOCAL_TOKEN);
    // The hub is the service's process, not the app's child: the fake launchd recorded it.
    expect(existsSync(join(home, "fake-launchd", `${LABEL}.pid`))).toBe(true);
    expect(app.cspViolations).toEqual([]);
  });

  test("S2: quitting the app leaves the hub running", async () => {
    const { port, app } = await launch();
    const dashboard = new DesktopDashboardPage(app.window);
    await dashboard.expectRepoListed("serviceproj");
    expect(await hubAnswers(port, LOCAL_TOKEN)).toBe(true);

    await app.app.close();

    // A browser (here, a plain HTTP client with the token) still reaches it.
    await expect.poll(() => hubAnswers(port, LOCAL_TOKEN), { timeout: 10_000 }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await hubAnswers(port, LOCAL_TOKEN)).toBe(true);
  });

  test("S4: switching to a remote hub keeps or stops the local service, and switching back starts it", async () => {
    const { home, port, app } = await launch();
    const dashboard = new DesktopDashboardPage(app.window);
    const picker = new HubPickerPage(app.window);
    await dashboard.expectRepoListed("serviceproj");

    // Keep (the default): the local hub keeps answering while the window shows the remote hub.
    await picker.open();
    await picker.chooseRemote(remote.url, REMOTE_TOKEN);
    await expect
      .poll(() => dashboard.url(), { timeout: 30_000 })
      .toMatch(/^app:\/\/h-[0-9a-f]{12}\//);
    expect(await hubAnswers(port, LOCAL_TOKEN)).toBe(true);
    expect(existsSync(plistFile(home))).toBe(true);

    // Back to local, then to remote again with Stop.
    await picker.open();
    await picker.chooseLocal();
    await expect.poll(() => dashboard.url(), { timeout: 60_000 }).toMatch(/^app:\/\/local\//);
    await dashboard.expectRepoListed("serviceproj");
    await picker.open();
    await picker.chooseRemote(remote.url, REMOTE_TOKEN, { localHub: "stop" });
    await expect
      .poll(() => dashboard.url(), { timeout: 30_000 })
      .toMatch(/^app:\/\/h-[0-9a-f]{12}\//);
    await expect.poll(() => hubAnswers(port, LOCAL_TOKEN), { timeout: 30_000 }).toBe(false);
    expect(existsSync(plistFile(home))).toBe(false);

    // Switching back starts the service again, with the data it had.
    await picker.open();
    await picker.chooseLocal();
    await expect.poll(() => dashboard.url(), { timeout: 60_000 }).toMatch(/^app:\/\/local\//);
    await dashboard.expectRepoListed("serviceproj");
    await expect.poll(() => hubAnswers(port, LOCAL_TOKEN), { timeout: 30_000 }).toBe(true);
    expect(existsSync(plistFile(home))).toBe(true);
  });
});
