import { toWorktreeId } from "@band-app/shared/worktree-id";
/**
 * The desktop viewer (plan step 7.2): noVNC draws a worker's desktop through the hub, starts
 * view-only, and forwards keys only after "Take control".
 *
 * A real hub, the real `band-worker` binary and a real browser run the whole path. The worker
 * reports the `desktop` capability because the test gives it a `DISPLAY` and an `x11vnc` on its
 * PATH, and `BAND_DESKTOP_VNC_PORT` points it at `fixtures/rfb-stub.ts`, a stand-in RFB server
 * that draws a gradient and records the keys it receives. Input against a real Xvfb and x11vnc
 * is `desktop-viewer-x11vnc.spec.ts`, and the real desktop image runs in the CI `docker` job
 * (`apps/hub/tests/desktop-docker.test.ts`). Everything runs in temp dirs.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, test } from "@playwright/test";
import { type RfbStub, startRfbStub } from "./fixtures/rfb-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcMutate, trpcQuery } from "./helpers/trpc";
import { startWorker, type WorkerHandle } from "./helpers/worker";
import { DesktopViewerPage } from "./pages/DesktopViewerPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-desktop-viewer-token";
const REPO = "desktop-proj";
const KEY_A = 0x61;
const KEY_B = 0x62;

let server: ServerHandle;
let tmpHome: string;
let stub: RfbStub;
let worker: WorkerHandle;
let hostId: string;
let workerRoot: string;
const scratch: string[] = [];

const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  writeFileSync(join(dir, "README.md"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env });
}

test.use({ viewport: { width: 1280, height: 800 } });

test.beforeAll(async () => {
  stub = await startRfbStub();
  tmpHome = createTmpHome();
  const hubRepo = join(tmpDir("band-e2e-desktop-hubrepo-"), REPO);
  makeRepo(hubRepo);
  seedSettings(tmpHome, { tokenSecret: TOKEN });
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
  server = await startServer({ tmpHome });

  const res = await fetch(`${server.url}/trpc/tokens.issueWorkerBootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
    body: JSON.stringify({ hostName: "desktop-box", labels: [] }),
  });
  expect(res.ok).toBe(true);
  const issued = ((await res.json()) as { result: { data: { token: string; hostId: string } } })
    .result.data;
  hostId = issued.hostId;

  // An executable named x11vnc on PATH and a DISPLAY are all the worker looks for.
  const bin = tmpDir("band-e2e-desktop-bin-");
  const fakeX11vnc = join(bin, "x11vnc");
  writeFileSync(fakeX11vnc, "#!/bin/sh\nexit 0\n");
  chmodSync(fakeX11vnc, 0o755);

  workerRoot = tmpDir("band-e2e-desktop-root-");
  makeRepo(join(workerRoot, REPO));
  worker = startWorker({
    env: {
      BAND_HUB_URL: server.url,
      BAND_BOOTSTRAP_TOKEN: issued.token,
      BAND_WORKER_ID: hostId,
      DISPLAY: ":99",
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      BAND_DESKTOP_VNC_PORT: String(stub.port),
    },
    root: workerRoot,
    stateDir: tmpDir("band-e2e-desktop-state-"),
    home: tmpDir("band-e2e-desktop-whome-"),
  });
  await expect
    .poll(
      async () => {
        const { hosts } = await trpcQuery<{
          hosts: Array<{ id: string; status: string; capabilities: string[] }>;
        }>(server.url, TOKEN, "hosts.list");
        const host = hosts.find((h) => h.id === hostId);
        return host?.status === "online" && host.capabilities.includes("desktop");
      },
      { timeout: 30_000 },
    )
    .toBe(true);
});

test.beforeEach(() => {
  resetClientState(tmpHome);
  stub.setSize(64, 48);
});

test.afterAll(async () => {
  await worker?.kill();
  await server?.close();
  await stub?.close();
  cleanupTmpHome(tmpHome);
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

async function openFromHosts(page: import("@playwright/test").Page): Promise<DesktopViewerPage> {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");
  const viewer = new DesktopViewerPage(page);
  await viewer.hostRowButton(hostId).click();
  await expect(viewer.dialog).toBeVisible();
  return viewer;
}

test("the Hosts screen opens the worker's desktop and the canvas shows its framebuffer", async ({
  page,
}) => {
  const viewer = await openFromHosts(page);
  await viewer.expectFramebuffer();
  await expect(viewer.hostName).toHaveText("desktop-box");
  await expect(viewer.resolution).toHaveText("64x48");
  await expect(viewer.mode).toHaveAttribute("data-mode", "view");
});

test("a desktop smaller than the area is drawn 1:1, not scaled up, and takes no focus in view only", async ({
  page,
}) => {
  const viewer = await openFromHosts(page);
  await viewer.expectFramebuffer();
  // Polled, because the dialog's open animation scales the box for its first 200 ms.
  await expect.poll(async () => (await viewer.canvasBox()).width).toBeCloseTo(64, 0);
  await expect.poll(async () => (await viewer.canvasBox()).height).toBeCloseTo(48, 0);
  expect(await viewer.canvasHasFocus()).toBe(false);
});

test("a key press is not forwarded in view-only mode, and is after Take control", async ({
  page,
}) => {
  const viewer = await openFromHosts(page);
  await viewer.expectFramebuffer();

  await viewer.pressKey("a");
  await viewer.takeControl();
  await viewer.pressKey("b");

  // Keys travel one socket in order, so once `b` has arrived an `a` that was sent has too.
  await expect.poll(() => stub.keys()).toContain(KEY_B);
  expect(stub.keys()).not.toContain(KEY_A);
});

test("Release returns to view only, and keys stop reaching the desktop", async ({ page }) => {
  const viewer = await openFromHosts(page);
  await viewer.expectFramebuffer();
  const before = stub.keys().length;

  await viewer.takeControl();
  expect(await viewer.canvasHasFocus()).toBe(true);
  await viewer.pressKey("b");
  await expect.poll(() => stub.keys().length).toBe(before + 1);

  // Escape is a key for the remote desktop in control mode, so the viewer stays open.
  await viewer.pressEscape();
  await expect(viewer.dialog).toBeVisible();
  await expect.poll(() => stub.keys().length).toBe(before + 2);

  await viewer.releaseControl();
  expect(await viewer.canvasHasFocus()).toBe(false);
  await viewer.pressKey("a");
  await viewer.takeControl();
  await viewer.pressKey("b");
  await expect.poll(() => stub.keys().length).toBe(before + 3);
  expect(stub.keys().slice(before)).not.toContain(KEY_A);
});

test.describe("a 1600x1000 desktop on a 1440x900 window", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeEach(() => stub.setSize(1600, 1000));

  test("the viewer uses most of the window and fit fills the area at the desktop's aspect ratio", async ({
    page,
  }, testInfo) => {
    const viewer = await openFromHosts(page);
    await viewer.expectFramebuffer();
    await expect(viewer.resolution).toHaveText("1600x1000");

    // Polled, because the dialog's open animation scales it down for its first 200 ms.
    await expect
      .poll(async () => (await viewer.dialogBox()).width)
      .toBeGreaterThanOrEqual(1440 * 0.9);
    await expect
      .poll(async () => (await viewer.dialogBox()).height)
      .toBeGreaterThanOrEqual(900 * 0.9);

    await expect
      .poll(async () => {
        const area = await viewer.screenBox();
        const canvas = await viewer.canvasBox();
        // Scaled down to touch the area on one axis, so at most one pair of bars is left.
        return Math.min(Math.abs(canvas.width - area.width), Math.abs(canvas.height - area.height));
      })
      .toBeLessThanOrEqual(1);
    const area = await viewer.screenBox();
    const canvas = await viewer.canvasBox();
    expect(canvas.width / canvas.height).toBeCloseTo(1.6, 2);
    expect(canvas.width).toBeLessThanOrEqual(area.width + 1);
    expect(canvas.height).toBeLessThanOrEqual(area.height + 1);
    await testInfo.attach("viewer-fit", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  });

  test("1:1 draws the desktop at its own size and scrolls, and Fit scales it back", async ({
    page,
  }) => {
    const viewer = await openFromHosts(page);
    await viewer.expectFramebuffer();

    await viewer.actualSize();
    await expect.poll(async () => (await viewer.canvasBox()).width).toBeCloseTo(1600, 0);
    expect((await viewer.canvasBox()).height).toBeCloseTo(1000, 0);
    const scrolled = await viewer.scrollToEnd();
    expect(scrolled.left).toBeGreaterThan(0);
    expect(scrolled.top).toBeGreaterThan(0);

    await viewer.fit();
    const area = await viewer.screenBox();
    await expect
      .poll(async () => (await viewer.canvasBox()).width)
      .toBeLessThanOrEqual(area.width + 1);
  });

  test("fullscreen grows the desktop, and Escape leaves fullscreen before it closes the viewer", async ({
    page,
  }) => {
    const viewer = await openFromHosts(page);
    await viewer.expectFramebuffer();
    await viewer.expectFitSettled();
    const windowed = await viewer.canvasBox();

    await viewer.enterFullscreen();
    expect(await viewer.isViewerFullscreen()).toBe(true);
    await expect
      .poll(async () => (await viewer.canvasBox()).height)
      .toBeGreaterThan(windowed.height);

    await viewer.pressEscape();
    await expect(viewer.root).toHaveAttribute("data-fullscreen", "false");
    expect(await viewer.isViewerFullscreen()).toBe(false);
    await expect(viewer.dialog).toBeVisible();

    await viewer.pressEscape();
    await expect(viewer.dialog).toBeHidden();
  });

  test("Close closes the viewer, and leaves fullscreen when it is on", async ({ page }) => {
    const windowed = await openFromHosts(page);
    await windowed.expectFramebuffer();
    await windowed.close();

    const viewer = await openFromHosts(page);
    await viewer.expectFramebuffer();
    await viewer.enterFullscreen();
    await viewer.close();
    await expect.poll(() => viewer.isAnythingFullscreen()).toBe(false);
  });
});

test("the worktree header opens the desktop of the worktree's host", async ({ page }) => {
  await trpcMutate(server.url, TOKEN, "worktrees.create", {
    repo: REPO,
    branch: "on-desktop",
    hostId,
    hostRepoPath: join(workerRoot, REPO),
  });
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const viewer = new DesktopViewerPage(page);
  await worktreePage.goto(toWorktreeId(REPO, "on-desktop", hostId));
  await worktreePage.waitForReady();
  await viewer.headerButton.click();
  await expect(viewer.dialog).toBeVisible();
  await viewer.expectFramebuffer();
});

test("a worktree on a host with no desktop shows no header button", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const viewer = new DesktopViewerPage(page);
  await worktreePage.goto(`${REPO}-main`);
  await worktreePage.waitForReady();
  await expect(viewer.headerButton).toHaveCount(0);
});
