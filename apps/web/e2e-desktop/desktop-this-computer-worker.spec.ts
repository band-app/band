/**
 * End-to-end coverage for "use this Mac as a worker" in the desktop app.
 *
 * Architecture:
 *
 *   - The REAL Electron app is launched against a throwaway HOME, with a real second hub as its
 *     remote hub (the same `startServer` the web specs use).
 *   - The only fake is `launchctl` (`fixtures/fake-launchctl.mjs`, through `BAND_LAUNCHCTL_BIN`).
 *     It behaves like launchd for the `app.band.worker` label and starts the real bundled worker
 *     from the plist, so a host really connects to the hub. The LaunchAgents directory is under
 *     the temp HOME, so nothing touches the real launchd, `~/Library` or `~/.band`.
 *   - No tRPC mocking and no `page.route()`. The hub is read with plain HTTP calls to its tRPC
 *     endpoint to see which hosts it knows.
 *
 * Under `BAND_DESKTOP_EXECUTABLE` the same specs run against the packaged app, which also checks
 * that the plist points inside the app bundle.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  getRandomPort,
  type ServerHandle,
  seedSettings,
  startServer,
} from "../e2e/helpers/server";
import { isPackagedRun, type LaunchedDesktop, launchDesktop } from "./helpers/desktop-app";
import { ThisComputerPage } from "./pages/ThisComputerPage";

const REMOTE_TOKEN = "desktop-worker-e2e-remote-token";
const FAKE_LAUNCHCTL = join(import.meta.dirname, "fixtures", "fake-launchctl.mjs");
const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");
const LABEL = "app.band.worker";

let remote: ServerHandle;
let remoteHome: string;
const homes: string[] = [];
let desktop: LaunchedDesktop | null = null;
let launchedHome: string | null = null;

interface HostRow {
  id: string;
  name: string;
  status: string;
}

async function hubCall<T>(kind: "query" | "mutation", path: string, input?: unknown): Promise<T> {
  const res = await fetch(`${remote.url}/trpc/${path}`, {
    method: kind === "query" ? "GET" : "POST",
    headers: { Authorization: `Bearer ${REMOTE_TOKEN}`, "Content-Type": "application/json" },
    body: kind === "mutation" ? JSON.stringify(input ?? {}) : undefined,
  });
  const body = (await res.json()) as { result?: { data: T }; error?: { message: string } };
  if (!body.result) throw new Error(body.error?.message ?? `hub answered ${res.status}`);
  return body.result.data;
}

async function hosts(): Promise<HostRow[]> {
  return (await hubCall<{ hosts: HostRow[] }>("query", "hosts.list")).hosts;
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

/** A HOME for a desktop app whose saved hub is the remote one (or, with `local`, none). */
async function seedDesktopHome(opts: { remote: boolean }): Promise<{ home: string; port: number }> {
  const home = createTmpHome();
  homes.push(home);
  const port = await getRandomPort();
  seedSettings(home, { tokenSecret: "desktop-worker-e2e-local-token", webServerPort: port });
  if (opts.remote) {
    writeFileSync(
      join(home, ".band", "desktop-hub.json"),
      JSON.stringify({ mode: "remote", url: remote.url, token: REMOTE_TOKEN }),
    );
  }
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  return { home, port };
}

async function launch(opts: { remote: boolean }) {
  const { home, port } = await seedDesktopHome(opts);
  launchedHome = home;
  desktop = await launchDesktop({
    home,
    hubPort: port,
    env: {
      BAND_LAUNCHCTL_BIN: FAKE_LAUNCHCTL,
      BAND_FAKE_LAUNCHD_DIR: join(home, "fake-launchd"),
    },
  });
  return { home, page: new ThisComputerPage(desktop.window), app: desktop };
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
  // The fake launchd leaves the worker it started running. Stop it.
  if (launchedHome) {
    spawnSync(FAKE_LAUNCHCTL, ["bootout", `gui/0/${LABEL}`], {
      env: { ...process.env, BAND_FAKE_LAUNCHD_DIR: join(launchedHome, "fake-launchd") },
    });
  }
  launchedHome = null;
});

test.describe("Desktop app: this computer as a worker", () => {
  test("S1: connecting to a remote hub asks, and Yes adds a host that goes online", async () => {
    const { home, page, app } = await launch({ remote: true });

    await expect(page.prompt).toBeVisible({ timeout: 30_000 });
    await expect(page.promptName).not.toHaveValue("");
    await page.promptName.fill("E2E Mac one");
    await page.promptYes.click();
    await expect(page.prompt).toBeHidden({ timeout: 90_000 });

    await expect
      .poll(async () => (await hosts()).find((h) => h.name === "E2E Mac one")?.status, {
        timeout: 60_000,
      })
      .toBe("online");

    // S6: the service runs the worker bundled in the app, through the app's own executable.
    const { program, env } = readPlist(home);
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    if (isPackagedRun()) {
      expect(program[0]).toContain(".app/Contents/MacOS/");
      expect(program[1]).toContain(".app/Contents/Resources/worker/band-worker.mjs");
    } else {
      expect(program[1]).toBe(WORKER_BIN);
    }
    // The plist is private to the user, and the token is not on the page.
    const mode = statSync(plistFile(home)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await app.window.content()).not.toContain("bwb_");
  });

  test("S2: Not now is remembered for that hub, and Settings offers Add this computer", async () => {
    const { page, app, home } = await launch({ remote: true });
    await expect(page.prompt).toBeVisible({ timeout: 30_000 });
    await page.promptNotNow.click();
    await expect(page.prompt).toBeHidden();

    await app.window.reload();
    await page.openHostsSettings();
    await expect(page.add).toBeVisible();
    await expect(page.prompt).toBeHidden();
    expect(existsSync(plistFile(home))).toBe(false);
  });

  test("S3: the app's own local hub does not ask", async () => {
    const { page } = await launch({ remote: false });
    await page.openHostsSettings();
    await expect(page.localHubNote).toBeVisible();
    await expect(page.prompt).toBeHidden();
  });

  test("S4: Remove this computer uninstalls the service and the host leaves the hub", async () => {
    const { page, home } = await launch({ remote: true });
    await expect(page.prompt).toBeVisible({ timeout: 30_000 });
    await page.promptNotNow.click();

    await page.openHostsSettings();
    await page.add.click();
    await expect(page.state).toHaveAttribute("data-status", "online", { timeout: 90_000 });
    const installed = readPlist(home);
    const hostId = installed.env.BAND_WORKER_ID;
    expect((await hosts()).some((h) => h.id === hostId)).toBe(true);

    await page.remove.click();
    await expect(page.add).toBeVisible({ timeout: 60_000 });
    expect(existsSync(plistFile(home))).toBe(false);
    await expect.poll(async () => (await hosts()).some((h) => h.id === hostId)).toBe(false);
  });

  test("S5: a service installed from npm can be switched to the bundled worker, keeping its id", async () => {
    const issued = await hubCall<{ token: string; hostId: string }>(
      "mutation",
      "tokens.issueWorkerBootstrap",
      { hostName: "E2E npm Mac", labels: [] },
    );
    const { home, page } = await launch({ remote: true });
    // What `band-worker install-service` from the npm package wrote: a node from elsewhere
    // running a worker outside the app, with the id, the token and a root.
    const root = join(home, "work");
    mkdirSync(root, { recursive: true });
    const vars: Record<string, string> = {
      BAND_HUB_URL: remote.url,
      BAND_WORKER_TOKEN: issued.token,
      BAND_WORKER_ID: issued.hostId,
      BAND_WORKER_NAME: "E2E npm Mac",
      BAND_WORKER_ROOTS: root,
    };
    const env = Object.entries(vars)
      .map(([k, v]) => `    <key>${k}</key>\n    <string>${v}</string>`)
      .join("\n");
    writeFileSync(
      plistFile(home),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/lib/node_modules/@band-app/worker/bin/band-worker.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
</dict>
</plist>
`,
      { mode: 0o600 },
    );

    await page.openHostsSettings();
    await expect(page.prompt).toBeHidden();
    await expect(page.switchToBundled).toBeVisible();
    await page.switchToBundled.click();
    await expect(page.state).toHaveAttribute("data-status", "online", { timeout: 90_000 });

    const { program, env: after } = readPlist(home);
    expect(program[1]).not.toContain("/usr/local/lib");
    expect(after.BAND_WORKER_ID).toBe(issued.hostId);
    expect(after.BAND_WORKER_ROOTS).toBe(root);
    expect(
      (await hosts()).filter((h) => h.id === issued.hostId && h.status === "online"),
    ).toHaveLength(1);
  });
});
