/**
 * The desktop viewer against a real x11vnc on Xvfb (`fixtures/x11-desktop.ts`): after Take
 * control, a click and a key typed into the viewer reach the X display, and before it they do
 * not. The display runs an `xev` window over the whole screen, and the test reads its log.
 *
 * A real hub, the real `band-worker` binary and a real browser run the whole path, as in
 * `desktop-viewer.spec.ts`, with `BAND_DESKTOP_VNC_PORT` pointing the worker at the real x11vnc.
 * The CI e2e job installs `xvfb x11vnc x11-utils`. Locally on macOS set `BAND_E2E_DESKTOP_IMAGE`
 * to the desktop worker image. Without either the file is skipped, except on Linux CI, where it
 * fails.
 */

import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, test } from "@playwright/test";
import { startX11Desktop, type X11Desktop } from "./fixtures/x11-desktop";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  startServer,
} from "./helpers/server";
import { trpcQuery } from "./helpers/trpc";
import { startWorker, type WorkerHandle } from "./helpers/worker";
import { DesktopViewerPage } from "./pages/DesktopViewerPage";
import { SettingsPage } from "./pages/SettingsPage";

const TOKEN = "e2e-desktop-x11vnc-token";

let server: ServerHandle | undefined;
let tmpHome: string;
let desktop: X11Desktop | null = null;
let worker: WorkerHandle | undefined;
let hostId: string;
const scratch: string[] = [];

const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  desktop = await startX11Desktop();
  if (!desktop) {
    if (process.env.CI && process.platform === "linux") {
      throw new Error("Xvfb, x11vnc and xev are not installed (apt: xvfb x11vnc x11-utils)");
    }
    return;
  }
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });

  const res = await fetch(`${server.url}/trpc/tokens.issueWorkerBootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
    body: JSON.stringify({ hostName: "x11-box", labels: [] }),
  });
  expect(res.ok).toBe(true);
  const issued = ((await res.json()) as { result: { data: { token: string; hostId: string } } })
    .result.data;
  hostId = issued.hostId;

  // The worker reports a desktop when it has a DISPLAY and an x11vnc on PATH. The real x11vnc
  // may run in a container, so a stand-in on PATH covers that case.
  const bin = tmpDir("band-e2e-x11-bin-");
  const fakeX11vnc = join(bin, "x11vnc");
  writeFileSync(fakeX11vnc, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeX11vnc, 0o755);

  worker = startWorker({
    env: {
      BAND_HUB_URL: server.url,
      BAND_BOOTSTRAP_TOKEN: issued.token,
      BAND_WORKER_ID: hostId,
      DISPLAY: ":99",
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      BAND_DESKTOP_VNC_PORT: String(desktop.port),
    },
    root: tmpDir("band-e2e-x11-root-"),
    stateDir: tmpDir("band-e2e-x11-state-"),
    home: tmpDir("band-e2e-x11-whome-"),
  });
  await expect
    .poll(
      async () => {
        const { hosts } = await trpcQuery<{
          hosts: Array<{ id: string; status: string; capabilities: string[] }>;
        }>(server?.url ?? "", TOKEN, "hosts.list");
        const host = hosts.find((h) => h.id === hostId);
        return host?.status === "online" && host.capabilities.includes("desktop");
      },
      { timeout: 30_000 },
    )
    .toBe(true);
});

test.beforeEach(() => {
  test.skip(!desktop, "no Xvfb and x11vnc here (set BAND_E2E_DESKTOP_IMAGE)");
  resetClientState(tmpHome);
});

test.afterAll(async () => {
  await worker?.kill();
  await server?.close();
  await desktop?.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

test("clicks and keys reach the real display only after Take control", async ({
  page,
}, testInfo) => {
  if (!server || !desktop) return;
  const x11 = desktop;
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");
  const viewer = new DesktopViewerPage(page);
  await viewer.hostRowButton(hostId).click();
  await expect(viewer.dialog).toBeVisible();
  await viewer.expectFramebuffer();
  await expect(viewer.resolution).toHaveText("1280x800");

  // xev prints one block per event, separated by a blank line.
  const eventBlocks = () => x11.events().split(/\n\s*\n/);
  const buttonPresses = () =>
    eventBlocks().filter((block) => block.trimStart().startsWith("ButtonPress event")).length;
  const keyPresses = (keysym: string) =>
    eventBlocks().filter(
      (block) =>
        block.trimStart().startsWith("KeyPress event") && block.includes(`keysym ${keysym},`),
    ).length;

  // View only: noVNC sends no click or key. The hub's own dropping is in desktop-host.test.ts.
  await viewer.clickDesktop();
  await viewer.pressKey("q");

  await viewer.takeControl();
  await viewer.clickDesktop();
  await expect.poll(buttonPresses, { timeout: 10_000 }).toBeGreaterThan(0);
  await viewer.pressKey("z");
  await expect.poll(() => keyPresses("0x7a"), { timeout: 10_000 }).toBe(1);

  // The view-only click and key never arrived: one click, and no `q`.
  expect(buttonPresses()).toBe(1);
  expect(keyPresses("0x71")).toBe(0);

  await viewer.releaseControl();
  await viewer.clickDesktop();
  await viewer.pressKey("q");
  await viewer.takeControl();
  await viewer.pressKey("z");
  await expect.poll(() => keyPresses("0x7a"), { timeout: 10_000 }).toBe(2);
  expect(keyPresses("0x71")).toBe(0);
  expect(buttonPresses()).toBe(1);
  await testInfo.attach("xev.log", { body: x11.events(), contentType: "text/plain" });
});
