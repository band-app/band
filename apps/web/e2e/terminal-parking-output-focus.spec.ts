/**
 * band-app/band#617 — parking model: liveness + focus isolation of a parked
 * terminal.
 *
 * Two guarantees the parking model must uphold while a terminal is detached
 * (moved to the shared off-screen parking container):
 *
 *  1. Output CONTINUES to flow into a parked terminal. Detach only moves the
 *     DOM wrapper — the xterm instance and its WebSocket stay live in the cache,
 *     so a command that keeps printing while its workspace is in the background
 *     still lands in that terminal's buffer (no reconnect, same socket).
 *
 *  2. Keystrokes NEVER leak into a parked terminal. The parking container is
 *     `inert` + `aria-hidden`, so a parked terminal's hidden textarea can't take
 *     focus or receive input meant for the active terminal.
 *
 * Renderer note: unlike the sibling `terminal-parking-switch.spec.ts`, this spec
 * does NOT force SwiftShader WebGL — so xterm falls back to its DOM renderer and
 * `.xterm-rows` carries the actual glyphs, which is what lets us read a parked
 * terminal's rendered text. Real server, real PTYs, driven via `WorkspacePage`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-terminal-parking-liveness-token";

const PROJECT_A = "alpha-parking-live";
const PROJECT_B = "bravo-parking-live";
const WORKSPACE_A = toWorkspaceId(PROJECT_A, "main");
const WORKSPACE_B = toWorkspaceId(PROJECT_B, "main");

test.use({ viewport: { width: 1280, height: 800 } });

let server!: ServerHandle;
let tmpHome!: string;
let workdirA!: string;
let workdirB!: string;

function makeGitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

function makeGitWorkdir(prefix: string, home: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const env = makeGitEnv(home);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir, env });
  return dir;
}

/** Highest N across all `TICK_<N>` markers currently rendered, or 0 if none. */
function maxTick(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/TICK_(\d+)/g)) {
    const n = Number.parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  workdirA = makeGitWorkdir("band-parking-live-a-", tmpHome);
  workdirB = makeGitWorkdir("band-parking-live-b-", tmpHome);
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT_A,
        path: workdirA,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: workdirA }],
      },
      {
        name: PROJECT_B,
        path: workdirB,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: workdirB }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN, maxCachedWorkspaces: 3 });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
  if (workdirA) rmSync(workdirA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (workdirB) rmSync(workdirB, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test.describe("Terminal parking: liveness + focus isolation", () => {
  test("output keeps flowing into a parked terminal over the same socket", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    // Count only workspace A's terminal sockets so a reconnect is detectable
    // independent of B opening its own.
    const socketCount = workspacePage.trackTerminalSocketOpensFor(WORKSPACE_A);

    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible({
      timeout: 20_000,
    });
    await workspacePage.waitForTerminalReady(20_000);
    await expect.poll(() => socketCount(), { timeout: 20_000 }).toBe(1);

    // Start a long, self-paced stream of incrementing markers.
    await workspacePage.runInTerminal("for i in $(seq 1 200); do echo TICK_$i; sleep 0.25; done");
    // Confirm it started rendering while A is active, and record the highest
    // marker visible just before we switch away.
    await expect
      .poll(async () => maxTick(await workspacePage.readTerminalRenderedText(WORKSPACE_A)), {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    const beforePark = maxTick(await workspacePage.readTerminalRenderedText(WORKSPACE_A));

    // Switch away → A parks. In-app nav keeps A cached (maxCachedWorkspaces=3).
    await workspacePage.switchWorkspace(WORKSPACE_B);
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_B, true)).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() => workspacePage.isTerminalParked(WORKSPACE_A), { timeout: 20_000 })
      .toBe(true);

    // xterm pauses its renderer for an off-screen element, so we can't observe
    // growth while parked — instead we come back and read the RENDERED markers
    // (the re-attach `refresh()` repaints the buffer that kept filling while
    // parked). The stream keeps ticking, and `socketCount === 1` below proves it
    // was the SAME live connection feeding the parked terminal — no fixed wait
    // needed; the auto-retrying poll after return catches the accumulation.
    await workspacePage.switchWorkspace(WORKSPACE_A);
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() => workspacePage.isTerminalParked(WORKSPACE_A), { timeout: 20_000 })
      .toBe(false);

    // The highest marker jumped well past the pre-park value: output kept
    // arriving into the parked terminal's buffer and is now repainted on return.
    await expect
      .poll(async () => maxTick(await workspacePage.readTerminalRenderedText(WORKSPACE_A)), {
        timeout: 20_000,
      })
      .toBeGreaterThan(beforePark + 3);

    // A's socket never reopened — the same live connection fed the parked terminal.
    expect(socketCount()).toBe(1);
  });

  test("keystrokes for the active terminal never leak into a parked one", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE_A);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible({
      timeout: 20_000,
    });
    await workspacePage.waitForTerminalReady(20_000);

    // Anchor: type a marker into A WHILE IT IS ACTIVE (no focus race), and wait
    // until A renders it. This becomes the positive anchor for the negative
    // assertion at the end — read back after A re-attaches, so the "no leak"
    // check can't pass vacuously against an unrendered buffer, and we never have
    // to type into A after its park→re-attach (that focus race made this test
    // flaky under parallel load).
    await workspacePage.runInTerminal("echo A_OWN_MARKER");
    await expect
      .poll(
        async () =>
          (await workspacePage.readTerminalRenderedText(WORKSPACE_A)).includes("A_OWN_MARKER"),
        { timeout: 20_000 },
      )
      .toBe(true);

    // Bring B forward with its own terminal; A parks.
    await workspacePage.switchWorkspace(WORKSPACE_B);
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_B, true)).toBeVisible({
      timeout: 20_000,
    });
    await workspacePage.waitForTerminalReady(20_000);
    await expect
      .poll(() => workspacePage.isTerminalParked(WORKSPACE_A), { timeout: 20_000 })
      .toBe(true);

    // The parking container isolates focus/input.
    expect(await workspacePage.readParkingIsolation()).toEqual({ inert: true, ariaHidden: true });

    // Type a unique marker; it must land in the ACTIVE terminal (B), never the
    // parked one (A). `terminalInput` resolves to B only — A's textarea is
    // aria-hidden inside the inert parking container.
    await workspacePage.runInTerminal("echo LEAKMARKER987");
    await expect
      .poll(
        async () =>
          (await workspacePage.readTerminalRenderedText(WORKSPACE_B)).includes("LEAKMARKER987"),
        { timeout: 20_000 },
      )
      .toBe(true);

    // Switch back to A so its buffer is repainted on re-attach (xterm freezes
    // rendering while parked). Wait until A's own marker is rendered again (the
    // repaint completed), then assert the leak marker is absent — the keystrokes
    // went only to B.
    await workspacePage.switchWorkspace(WORKSPACE_A);
    await expect(workspacePage.terminalTabVisibilityMarker(WORKSPACE_A, true)).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(() => workspacePage.isTerminalParked(WORKSPACE_A), { timeout: 20_000 })
      .toBe(false);
    await expect
      .poll(
        async () =>
          (await workspacePage.readTerminalRenderedText(WORKSPACE_A)).includes("A_OWN_MARKER"),
        { timeout: 20_000 },
      )
      .toBe(true);
    expect(await workspacePage.readTerminalRenderedText(WORKSPACE_A)).not.toContain(
      "LEAKMARKER987",
    );
  });
});
