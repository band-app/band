/**
 * Relaunching Band lands where the user was.
 *
 * The desktop shell loads `/` on every launch (quit and reopen, auto-update
 * restart), so before this the app always came back with no workspace open.
 * Each device type now records the workspace on screen (`band:last-workspace`
 * in the client-state store) and a load on `/` reopens it before the shell
 * renders (`lib/last-workspace.ts`, `ClientStateGate` in `__root.tsx`).
 *
 * Each test restarts the real server on the same HOME and port, then opens
 * `/` the way the desktop shell does:
 *   - the workspace, the selected label, the active center tab and the right
 *     sidepanel tab all come back, in the same browser and in a new one with
 *     empty localStorage (the values come from the server);
 *   - a workspace deleted while Band was closed leaves the app on `/`;
 *   - when another device picked a different label, the label and the
 *     workspace still agree: the label's last workspace opens.
 *
 * The desktop window's size, position and maximized state are restored by
 * the Electron main process (`apps/desktop/src/main/window.ts`), which this
 * web build can't exercise; `apps/desktop/tests/window-state.test.ts` covers
 * its file and display-fitting helpers.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  removeSeededProject,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-restore-session-token";
const LABEL_ALPHA = "lbl_alpha";
const LABEL_BETA = "lbl_beta";
const WS_ALPHA = toWorkspaceId("alpha", "main");
const WS_BETA = toWorkspaceId("beta", "main");
const WS_GAMMA = toWorkspaceId("gamma", "main");
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

function project(name: string, label?: string) {
  const path = createRepo(name);
  return { name, path, defaultBranch: "main", label, worktrees: [{ branch: "main", path }] };
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedState(tmpHome, {
    projects: [project("alpha", LABEL_ALPHA), project("beta", LABEL_BETA), project("gamma")],
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

test("a restart reopens the workspace, label, active tab and right sidepanel tab", async ({
  page,
  browser,
}) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WS_ALPHA);
  await workspacePage.waitForReady();
  await workspacePage.selectLabelFilter(LABEL_BETA);
  await workspacePage.switchWorkspace(WS_BETA);
  await expect(page).toHaveURL(new RegExp(`/workspace/${encodeURIComponent(WS_BETA)}`));
  await workspacePage.waitForReady();
  await workspacePage.openFileLeaf(FILE, WS_BETA);
  await workspacePage.selectRightSidepanelTab("changes");

  // Everything reached the server before it stops.
  await expect
    .poll(() => workspacePage.readServerClientState(null, "band:last-workspace"))
    .toBe(WS_BETA);
  await expect
    .poll(() => workspacePage.readServerClientState(null, "band:right-sidepanel-tab"))
    .toBe("changes");
  await expect.poll(() => workspacePage.readSharedActiveTab(WS_BETA)).not.toBeNull();

  server = await server.restart();

  await workspacePage.launch();
  await expect(page).toHaveURL(new RegExp(`/workspace/${encodeURIComponent(WS_BETA)}`));
  await workspacePage.waitForReady();
  await expect(workspacePage.labelFilterTrigger()).toHaveText("Beta");
  await expect(workspacePage.fileTabContainer(FILE)).toHaveClass(/dv-active-tab/);
  await expect(workspacePage.rightSidepanelTab("changes")).toHaveAttribute("aria-selected", "true");

  // A browser with nothing in localStorage gets the same from the server.
  const context = await browser.newContext(DESKTOP);
  try {
    const fresh = new WorkspacePage(await context.newPage(), server.url, TOKEN);
    await fresh.launch();
    await fresh.waitForReady();
    await expect(fresh.labelFilterTrigger()).toHaveText("Beta");
    await expect(fresh.fileTabContainer(FILE)).toHaveClass(/dv-active-tab/);
    await expect(fresh.rightSidepanelTab("changes")).toHaveAttribute("aria-selected", "true");
  } finally {
    await context.close();
  }
});

test("a workspace deleted while Band was closed leaves the app on /", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WS_GAMMA);
  await workspacePage.waitForReady();
  await expect
    .poll(() => workspacePage.readServerClientState(null, "band:last-workspace"))
    .toBe(WS_GAMMA);

  const port = Number(new URL(server.url).port);
  await server.close();
  removeSeededProject(tmpHome, "gamma");
  server = await startServer({ tmpHome, port });

  await workspacePage.launch();
  // The shell rendered, with no workspace in the center column.
  await expect(workspacePage.centerDragBar).toBeVisible();
  await expect(workspacePage.workspaceCard(WS_ALPHA)).toBeVisible();
  await expect(page).toHaveURL(`${server.url}/?token=${TOKEN}`);
  await expect
    .poll(() => workspacePage.readServerClientState(null, "band:last-workspace"))
    .toBeNull();
});

test("a label another device picked opens that label's last workspace", async ({
  page,
  browser,
}) => {
  const desktop = new WorkspacePage(page, server.url, TOKEN);
  await desktop.goto(WS_ALPHA);
  await desktop.waitForReady();
  await desktop.selectLabelFilter(LABEL_ALPHA);
  await expect
    .poll(() => desktop.readServerClientState(null, "band:last-workspace"))
    .toBe(WS_ALPHA);
  // Otherwise the desktop's write could land after the phone's and win.
  await expect
    .poll(() => desktop.readServerClientState(null, "band.projects-list.label-filter"))
    .toBe(LABEL_ALPHA);

  // The phone switches the shared label filter to Beta and opens a Beta
  // workspace, which becomes Beta's last workspace.
  const context = await browser.newContext(PHONE);
  try {
    const phone = new WorkspacePage(await context.newPage(), server.url, TOKEN);
    await phone.launch();
    await phone.selectLabelFilter(LABEL_BETA);
    await phone.switchWorkspace(WS_BETA);
    await expect
      .poll(() => phone.readServerClientState(null, "band.projects-list.label-last-workspace"))
      .toEqual({ [LABEL_BETA]: WS_BETA });
    await expect
      .poll(() => phone.readServerClientState(null, "band.projects-list.label-filter"))
      .toBe(LABEL_BETA);
  } finally {
    await context.close();
  }

  server = await server.restart();

  await desktop.launch();
  await expect(page).toHaveURL(new RegExp(`/workspace/${encodeURIComponent(WS_BETA)}`));
  await desktop.waitForReady();
  await expect(desktop.labelFilterTrigger()).toHaveText("Beta");
});
