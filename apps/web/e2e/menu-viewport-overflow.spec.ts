/**
 * A context submenu and a select list, taller than a short window, at 130%
 * app zoom.
 *
 * Every Radix menu, submenu, select and popover caps its height at the room
 * Radix reports between its trigger and the window edge, and scrolls. That
 * room is in viewport pixels, while the app zoom (CSS `zoom` on <html>, set
 * with Ctrl+=) scales every CSS pixel inside the menu. Before the fix a
 * 130% menu came out 30% taller than the room it was given and ran off the
 * window, and the project menu's "Set label" submenu had no cap at all. The
 * chat's model submenus are covered in chat-model-submenu-overflow.spec.ts.
 *
 * Real server, no tRPC mocking, no stubs: the labels and coding agents are
 * seeded into settings.json.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
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
import { SettingsPage } from "./pages/SettingsPage";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-menu-viewport-overflow-token";
const PROJECT = "menuoverflow";
const pad = (n: number) => String(n).padStart(2, "0");
const LABELS = Array.from({ length: 30 }, (_, i) => ({
  id: `label-${pad(i + 1)}`,
  name: `Label ${pad(i + 1)}`,
  color: "#3b82f6",
}));
const LAST_LABEL = LABELS[LABELS.length - 1];
const AGENTS = Array.from({ length: 30 }, (_, i) => ({
  id: `agent-${pad(i + 1)}`,
  type: "claude-code",
  label: `Agent ${pad(i + 1)}`,
}));
const LAST_AGENT = AGENTS[AGENTS.length - 1];
const APP_ZOOM_STEPS = 3;
const viewport = { width: 1280, height: 420 };

test.use({ viewport });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, PROJECT);
  mkdirSync(repoDir, { recursive: true });
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir }],
      },
    ],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    labels: LABELS,
    codingAgents: AGENTS,
    defaultCodingAgent: AGENTS[0].id,
  });
  // The boot model refresh probes every coding agent over ACP; the stub
  // answers so no real agent binary is needed.
  server = await startServer({ tmpHome, env: acpStubEnv(tmpHome) });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

/** Zoom the app in APP_ZOOM_STEPS steps with Ctrl+=, the way a user does. */
async function zoomIn(workspacePage: WorkspacePage): Promise<void> {
  for (let i = 0; i < APP_ZOOM_STEPS; i++) await workspacePage.zoomInViaShortcut();
  await expect.poll(() => workspacePage.readAppZoom()).toBeCloseTo(1 + APP_ZOOM_STEPS / 10, 5);
}

async function expectInsideViewport(
  readBox: (locator: Locator) => Promise<{
    top: number;
    bottom: number;
    left: number;
    right: number;
  }>,
  locator: Locator,
): Promise<void> {
  const box = await readBox(locator);
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.bottom).toBeLessThanOrEqual(viewport.height);
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(viewport.width);
}

test("the project menu's Set label submenu stays inside the window and scrolls to its last label", async ({
  page,
}) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const readBox = (locator: Locator) => workspacePage.readSettledBox(locator);
  await workspacePage.goto(toWorkspaceId(PROJECT, "main"));
  await zoomIn(workspacePage);

  await workspacePage.openProjectContextMenu(PROJECT);
  await expect(workspacePage.contextMenu.first()).toBeVisible();
  await workspacePage.openSetLabelSubmenu();
  await expectInsideViewport(readBox, workspacePage.labelSubmenu);

  const last = workspacePage.labelSubmenuOption(LAST_LABEL.name);
  await workspacePage.focusLastLabelSubmenuOption();
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 1 });

  await workspacePage.scrollLabelSubmenuToTop();
  await expect(last).not.toBeInViewport();
  await workspacePage.clickLabelSubmenuOption(LAST_LABEL.name);

  // Filtering the sidebar by that label still shows the project.
  await workspacePage.selectLabelFilter(LAST_LABEL.id);
  await expect(workspacePage.projectHeader(PROJECT)).toBeVisible();
});

test("the Default agent select stays inside the window and scrolls to its last agent", async ({
  page,
}) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  const readBox = (locator: Locator) => settingsPage.readSettledBox(locator);
  await workspacePage.goto(toWorkspaceId(PROJECT, "main"));
  await zoomIn(workspacePage);

  await settingsPage.openDialog();
  await expectInsideViewport(readBox, settingsPage.dialog);
  await settingsPage.openDefaultAgentSelect();
  await expectInsideViewport(readBox, settingsPage.openSelectList);

  const last = settingsPage.selectOption(LAST_AGENT.label);
  await settingsPage.focusLastSelectOption();
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 1 });

  await settingsPage.scrollSelectListToTop();
  await expect(last).not.toBeInViewport();
  await settingsPage.clickSelectOption(LAST_AGENT.label);
  await expect(settingsPage.defaultAgentSelect()).toContainText(LAST_AGENT.label);
});
