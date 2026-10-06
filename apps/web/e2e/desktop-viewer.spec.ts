/**
 * The desktop viewer (plan step 7.2): noVNC draws a worker's desktop through the hub, starts
 * view-only, and forwards keys only after "Take control".
 *
 * A real hub, the real `band-worker` binary and a real browser run the whole path. The worker
 * reports the `desktop` capability because the test gives it a `DISPLAY` and an `x11vnc` on its
 * PATH, and `BAND_DESKTOP_VNC_PORT` points it at `fixtures/rfb-stub.ts`, a stand-in RFB server
 * that draws a gradient and records the keys it receives. The real Xvfb and x11vnc run in the CI
 * `docker` job (`apps/hub/tests/desktop-docker.test.ts`). Everything runs in temp dirs.
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

test.beforeEach(() => resetClientState(tmpHome));

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

test("the worktree header opens the desktop of the worktree's host", async ({ page }) => {
  await trpcMutate(server.url, TOKEN, "worktrees.create", {
    repo: REPO,
    branch: "on-desktop",
    hostId,
    hostRepoPath: join(workerRoot, REPO),
  });
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const viewer = new DesktopViewerPage(page);
  await worktreePage.goto(`${REPO}-on-desktop`);
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
