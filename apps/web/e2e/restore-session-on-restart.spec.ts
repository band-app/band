/**
 * Relaunching Band lands where the user was.
 *
 * The desktop shell loads `/` on every launch (quit and reopen, auto-update
 * restart), so before this the app always came back with no worktree open.
 * Each device type now records the worktree on screen (`band:last-worktree`
 * in the client-state store) and a load on `/` reopens it before the shell
 * renders (`lib/last-worktree.ts`, `ClientStateGate` in `__root.tsx`).
 *
 * Each test restarts the real server on the same HOME and port, then opens
 * `/` the way the desktop shell does:
 *   - the worktree, the selected label, the active center tab, the right
 *     sidepanel tab and the sidebar width all come back, in the same browser and in a new one with
 *     empty localStorage (the values come from the server);
 *   - a worktree deleted while Band was closed leaves the app on `/`;
 *   - when another device picked a different label, the label and the
 *     worktree still agree: the label's last worktree opens.
 *
 * The desktop window's size, position and maximized state are restored by
 * the Electron main process (`apps/desktop/src/main/window.ts`), which this
 * web build can't exercise; `apps/desktop/tests/window-state.test.ts` covers
 * its file and display-fitting helpers.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  removeSeededRepo,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-restore-session-token";
const LABEL_ALPHA = "lbl_alpha";
const LABEL_BETA = "lbl_beta";
const WS_ALPHA = toWorktreeId("alpha", "main", "local");
const WS_BETA = toWorktreeId("beta", "main", "local");
const WS_GAMMA = toWorktreeId("gamma", "main", "local");
const FILE = "readme.md";
const DESKTOP = { viewport: { width: 1280, height: 800 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

test.use(DESKTOP);
// Every test boots the server twice.
test.setTimeout(90_000);

let server: ServerHandle;
let tmpHome: string;

/** A git repo with one committed file and an uncommitted change to it. */
function createRepo(name: string): string {
  const dir = join(tmpHome, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, FILE), "# committed\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial"]);
  writeFileSync(join(dir, FILE), "# changed\n");
  return dir;
}

function repo(name: string, label?: string) {
  const path = createRepo(name);
  return { name, path, defaultBranch: "main", label, worktrees: [{ branch: "main", path }] };
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    repos: [repo("alpha", LABEL_ALPHA), repo("beta", LABEL_BETA), repo("gamma")],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    labels: [
      { id: LABEL_ALPHA, name: "Alpha", color: "#8b5cf6" },
      { id: LABEL_BETA, name: "Beta", color: "#3b82f6" },
    ],
  });
  server = await startServer({ tmpHome });
});

// Start each test from no UI state, like a first launch.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("a restart reopens the worktree, label, active tab and right sidepanel tab", async ({
  page,
  browser,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WS_ALPHA);
  await worktreePage.waitForReady();
  await worktreePage.selectLabelFilter(LABEL_BETA);
  await worktreePage.switchWorktree(WS_BETA);
  await expect(page).toHaveURL(new RegExp(`/worktree/${encodeURIComponent(WS_BETA)}`));
  await worktreePage.waitForReady();
  await worktreePage.openFileLeaf(FILE, WS_BETA);
  await worktreePage.selectRightSidepanelTab("changes");
  const sidebarBefore = await worktreePage.sidebarWidth();
  await worktreePage.dragSidebarEdgeBy(120);
  await expect.poll(() => worktreePage.sidebarWidth()).toBeGreaterThan(sidebarBefore + 60);
  const sidebarWidth = await worktreePage.sidebarWidth();

  // Everything reached the server before it stops.
  await expect
    .poll(() => worktreePage.readServerClientState(null, "band:last-worktree"))
    .toBe(WS_BETA);
  await expect
    .poll(() => worktreePage.readServerClientState(null, "band:right-sidepanel-tab"))
    .toBe("changes");
  await expect.poll(() => worktreePage.readSharedActiveTab(WS_BETA)).toBe(`file:${FILE}`);
  await expect
    .poll(() => worktreePage.readServerClientState(null, "band:sidebar-width"))
    .not.toBeNull();

  server = await server.restart();

  await worktreePage.launch();
  await expect(page).toHaveURL(new RegExp(`/worktree/${encodeURIComponent(WS_BETA)}`));
  await worktreePage.waitForReady();
  await expect(worktreePage.labelFilterTrigger()).toHaveText("Beta");
  await expect(worktreePage.fileTabContainer(FILE)).toHaveClass(/dv-active-tab/);
  await expect(worktreePage.rightSidepanelTab("changes")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => worktreePage.sidebarWidth()).toBeCloseTo(sidebarWidth, 0);

  // A browser with nothing in localStorage gets the same from the server.
  const context = await browser.newContext(DESKTOP);
  try {
    const fresh = new WorktreePage(await context.newPage(), server.url, TOKEN);
    await fresh.launch();
    await fresh.waitForReady();
    await expect(fresh.labelFilterTrigger()).toHaveText("Beta");
    await expect(fresh.fileTabContainer(FILE)).toHaveClass(/dv-active-tab/);
    await expect(fresh.rightSidepanelTab("changes")).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => fresh.sidebarWidth()).toBeCloseTo(sidebarWidth, 0);
  } finally {
    await context.close();
  }
});

test("a worktree deleted while Band was closed leaves the app on /", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WS_GAMMA);
  await worktreePage.waitForReady();
  await expect
    .poll(() => worktreePage.readServerClientState(null, "band:last-worktree"))
    .toBe(WS_GAMMA);

  const port = Number(new URL(server.url).port);
  await server.close();
  removeSeededRepo(tmpHome, "gamma");
  server = await startServer({ tmpHome, port });

  await worktreePage.launch();
  // The shell rendered, with no worktree in the center column.
  await expect(worktreePage.centerDragBar).toBeVisible();
  await expect(worktreePage.worktreeCard(WS_ALPHA)).toBeVisible();
  await expect(page).toHaveURL(`${server.url}/?token=${TOKEN}`);
  await expect
    .poll(() => worktreePage.readServerClientState(null, "band:last-worktree"))
    .toBeNull();
});

test("a label another device picked opens that label's last worktree", async ({
  page,
  browser,
}) => {
  const desktop = new WorktreePage(page, server.url, TOKEN);
  await desktop.goto(WS_ALPHA);
  await desktop.waitForReady();
  await desktop.selectLabelFilter(LABEL_ALPHA);
  await expect.poll(() => desktop.readServerClientState(null, "band:last-worktree")).toBe(WS_ALPHA);
  // Otherwise the desktop's write could land after the phone's and win.
  await expect
    .poll(() => desktop.readServerClientState(null, "band.repos-list.label-filter"))
    .toBe(LABEL_ALPHA);

  // The phone switches the shared label filter to Beta and opens a Beta
  // worktree, which becomes Beta's last worktree.
  const context = await browser.newContext(PHONE);
  try {
    const phone = new WorktreePage(await context.newPage(), server.url, TOKEN);
    await phone.launch();
    await phone.selectLabelFilter(LABEL_BETA);
    await phone.switchWorktree(WS_BETA);
    await expect
      .poll(() => phone.readServerClientState(null, "band.repos-list.label-last-worktree"))
      .toEqual({ [LABEL_BETA]: WS_BETA });
    await expect
      .poll(() => phone.readServerClientState(null, "band.repos-list.label-filter"))
      .toBe(LABEL_BETA);
  } finally {
    await context.close();
  }

  // The desktop itself is still on Alpha: only the label says Beta.
  await expect.poll(() => desktop.readServerClientState(null, "band:last-worktree")).toBe(WS_ALPHA);

  server = await server.restart();

  await desktop.launch();
  await expect(page).toHaveURL(new RegExp(`/worktree/${encodeURIComponent(WS_BETA)}`));
  await desktop.waitForReady();
  await expect(desktop.labelFilterTrigger()).toHaveText("Beta");
});
