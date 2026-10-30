/**
 * The Simulator tab (plan phase 3, second half). A real hub, the real `band-worker` binary on this
 * Mac and a real browser. The live tests need Xcode (`simctl`) and skip without it; the worker
 * names its devices with a prefix of this run's own (`BAND_SIMULATOR_NAME_PREFIX`), so a person's
 * simulators are never matched, and everything with that prefix is deleted at the end.
 *
 * The chat test needs no simulator: the scripted ACP stub returns a tool result with an image,
 * which the chat draws. No tRPC mocking and no `page.route`.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
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
import { trpcMutate, trpcMutateData, trpcQuery } from "./helpers/trpc";
import { startWorker, type WorkerHandle } from "./helpers/worker";
import { SimulatorPage } from "./pages/SimulatorPage";

const TOKEN = "e2e-simulator-panel-token";
const REPO = "simrepo";
const PREFIX = `Band e2e ${randomBytes(4).toString("hex")}`;
const CLI = join(import.meta.dirname, "../../cli/target/debug/band");
const SERVE_SIM = join(
  import.meta.dirname,
  "../../worker/node_modules/serve-sim/dist/serve-sim.js",
);
/** A 1x1 PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function hasSimctl(): boolean {
  try {
    execFileSync("xcrun", ["simctl", "help"], { stdio: "ignore" });
    return process.platform === "darwin";
  } catch {
    return false;
  }
}
// Booting devices takes minutes on a CI runner, so CI skips these unless BAND_TEST_SIMULATOR=1.
const CAN_RUN = hasSimctl() && (!process.env.CI || process.env.BAND_TEST_SIMULATOR === "1");

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: "serial" });

let server: ServerHandle;
let tmpHome: string;
let worker: WorkerHandle | undefined;
let hostId = "";
let simWorktree = "";
const scratch: string[] = [];
const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

interface Device {
  udid: string;
  name: string;
  state: string;
}
function myDevices(): Device[] {
  const out = execFileSync("xcrun", ["simctl", "list", "devices", "-j"], { encoding: "utf8" });
  return Object.values((JSON.parse(out) as { devices: Record<string, Device[]> }).devices)
    .flat()
    .filter((d) => d.name.startsWith(`${PREFIX} – `));
}

/** The bundle id of the app in the device's foreground, from serve-sim's helper for the device. */
async function foreground(udid: string): Promise<string> {
  const listed = JSON.parse(
    execFileSync(process.execPath, [SERVE_SIM, "--list", "--quiet"], { encoding: "utf8" }),
  ) as { device?: string; port?: number; devices?: Array<{ device: string; port: number }> };
  const port =
    listed.devices?.find((d) => d.device === udid)?.port ??
    (listed.device === udid ? listed.port : undefined);
  if (!port) throw new Error("serve-sim has no helper for the device");
  const res = await fetch(`http://127.0.0.1:${port}/helper/${udid}/foreground`);
  return ((await res.json()) as { bundleId?: string }).bundleId ?? "";
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  tmpHome = createTmpHome();
  const hubRepo = join(tmpDir("band-e2e-sim-hubrepo-"), REPO);
  mkdirSync(hubRepo, { recursive: true });
  git(hubRepo, "init", "-q", "-b", "main");
  writeFileSync(join(hubRepo, "hello.txt"), "hello\n");
  git(hubRepo, "add", ".");
  git(hubRepo, "commit", "-q", "-m", "init");
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    defaultCodingAgent: "claude-code",
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: hubRepo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: hubRepo }],
      },
    ],
  });
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [
        {
          match: "take a screenshot",
          steps: [
            {
              tool: {
                toolCallId: "tc-shot-1",
                title: "simulator_screenshot",
                kind: "other",
                status: "in_progress",
                rawInput: {},
              },
            },
            {
              toolUpdate: {
                toolCallId: "tc-shot-1",
                status: "completed",
                content: [
                  { type: "content", content: { type: "image", data: PNG, mimeType: "image/png" } },
                ],
              },
            },
            { say: "Here is the screen." },
          ],
        },
      ],
    }),
  });

  if (!CAN_RUN) return;
  const issued = await trpcMutateData<{ token: string; hostId: string }>(
    server.url,
    TOKEN,
    "tokens.issueWorkerBootstrap",
    { hostName: "mac", labels: [] },
  );
  hostId = issued.hostId;
  const root = tmpDir("band-e2e-sim-root-");
  const repo = join(root, REPO);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "hello.txt"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  worker = startWorker({
    env: {
      BAND_HUB_URL: server.url,
      BAND_BOOTSTRAP_TOKEN: issued.token,
      BAND_WORKER_ID: hostId,
      BAND_SIMULATOR_NAME_PREFIX: PREFIX,
      BAND_SIMULATOR_MAX_BOOTED: "1",
    },
    root,
    stateDir: tmpDir("band-e2e-sim-state-"),
    home: tmpDir("band-e2e-sim-whome-"),
  });
  await expect
    .poll(
      async () => {
        const { hosts } = await trpcQuery<{
          hosts: Array<{ id: string; status: string; capabilities: string[] }>;
        }>(server.url, TOKEN, "hosts.list");
        const row = hosts.find((h) => h.id === hostId);
        return row?.status === "online" && row.capabilities.includes("simulator");
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await trpcMutate(server.url, TOKEN, "worktrees.create", {
    repo: REPO,
    branch: "sim",
    hostId,
    hostRepoPath: repo,
    noOrigin: true,
  });
  simWorktree = toWorktreeId(REPO, "sim", hostId);
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await worker?.kill();
  for (const d of myDevices()) {
    try {
      execFileSync("xcrun", ["simctl", "shutdown", d.udid], { stdio: "ignore" });
    } catch {}
    try {
      execFileSync("xcrun", ["simctl", "delete", d.udid], { stdio: "ignore" });
    } catch {}
  }
  await server?.close();
  cleanupTmpHome(tmpHome);
  for (const dir of scratch) cleanupTmpHome(dir);
});

test("S8: the + menu has no Simulator item for a worktree whose worker lacks the capability", async ({
  page,
}) => {
  const sim = new SimulatorPage(page, server.url, TOKEN);
  await sim.open(toWorktreeId(REPO, "main", "local"));
  await sim.openNewTabMenu();
  await expect(sim.menuItem).toHaveCount(0);
});

test("S7: a tool result with an image shows in the chat, sized to fit and openable full size", async ({
  page,
}) => {
  const sim = new SimulatorPage(page, server.url, TOKEN);
  await sim.open(toWorktreeId(REPO, "main", "local"));
  await sim.say("take a screenshot", "Here is the screen.");
  await sim.expandFirstToolCall();
  await expect(sim.toolImage).toBeVisible();
  const box = await sim.toolImage.boundingBox();
  expect(box?.height).toBeLessThanOrEqual(330);
  await sim.toolImage.click();
  await expect(sim.toolImageFull).toBeVisible();
  await sim.saveEvidence("S7-chat-tool-image");
});

test.describe("with a Mac worker", () => {
  test.skip(!CAN_RUN, "needs Xcode's simctl");

  test("S3, S6: the tab opens from the + menu, shows the screen and survives switching tabs, a reload and closing", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const sim = new SimulatorPage(page, server.url, TOKEN);
    await sim.open(simWorktree);
    await sim.openFromMenu();
    await sim.waitLive();
    await expect(sim.status).toHaveText("View only");
    await sim.saveEvidence("S3-simulator-tab-live");

    // The screen updates when something else changes the device (here, an app launching).
    const before = await sim.canvasPixels();
    const udid = myDevices().find((d) => d.name.endsWith(simWorktree))?.udid ?? "";
    expect(udid).not.toBe("");
    execFileSync("xcrun", ["simctl", "launch", udid, "com.apple.Preferences"]);
    await expect
      .poll(async () => (await sim.canvasPixels()).equals(before), { timeout: 30_000 })
      .toBe(false);
    await sim.saveEvidence("S3-screen-updated-after-launch");

    // Switching tabs and back keeps the one connection.
    expect(sim.streamConnections).toBe(1);
    await sim.selectOtherTab();
    await sim.selectTab();
    await expect(sim.screen).toHaveAttribute("data-phase", "live");
    expect(sim.streamConnections).toBe(1);

    // A reload restores the tab from the shared tab list.
    await sim.reload();
    await expect(sim.tab).toBeVisible();
    await sim.waitLive();

    // Closing the tab stops the stream and leaves the device booted.
    await sim.closeTab();
    expect(myDevices().find((d) => d.udid === udid)?.state).toBe("Booted");
  });

  test("S4: a click does nothing until Take control, then taps at the matching point", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const sim = new SimulatorPage(page, server.url, TOKEN);
    await sim.open(simWorktree);
    await sim.openFromMenu();
    await sim.waitLive();
    const udid = myDevices().find((d) => d.name.endsWith(simWorktree))?.udid ?? "";

    // Home screen first: Home needs control, so use the device directly to get there.
    await sim.takeControl();
    await sim.homeButton.click();
    await expect.poll(() => foreground(udid), { timeout: 30_000 }).toBe("com.apple.springboard");
    await sim.release();

    // The Maps widget sits in the upper left of a fresh iPhone's home screen.
    await sim.clickAt(0.27, 0.21);
    await page.waitForTimeout(2000);
    expect(await foreground(udid)).toBe("com.apple.springboard");

    await sim.takeControl();
    await sim.clickAt(0.27, 0.21);
    await expect.poll(() => foreground(udid), { timeout: 30_000 }).toBe("com.apple.Maps");
    await sim.saveEvidence("S4-after-take-control-tap");

    // Releasing returns to view-only. The hub drops input again from then on; the hub test
    // (`apps/hub/tests/simulator-plugin.test.ts`) checks that on the device.
    await sim.release();
    await expect(sim.status).toHaveText("View only");
  });

  test("S9: band simulators open opens the tab for the connected client", async ({ page }) => {
    test.setTimeout(300_000);
    const sim = new SimulatorPage(page, server.url, TOKEN);
    await sim.open(simWorktree);
    await expect(sim.tab).toHaveCount(0);
    const home = tmpDir("band-e2e-sim-cli-");
    const out = execFileSync(CLI, ["simulators", "open", simWorktree], {
      encoding: "utf8",
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BAND_"))),
        HOME: home,
        BAND_SERVER_URL: server.url,
        BAND_TOKEN: TOKEN,
      },
    });
    expect(out).toContain("Opened the Simulator tab");
    await expect(sim.tab).toBeVisible();
    await sim.waitLive();
  });
});
