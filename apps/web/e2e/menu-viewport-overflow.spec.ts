/**
 * A context submenu, a select list, the command palette and a toolbar
 * dialog in a short window at 130% app zoom.
 *
 * Every Radix menu, submenu, select and popover caps its height at the room
 * Radix reports between its trigger and the window edge, and scrolls. That
 * room is in viewport pixels, while the app zoom (CSS `zoom` on <html>, set
 * with Ctrl+=) scales every CSS pixel inside the menu. Before the fix a
 * 130% menu came out 30% taller than the room it was given and ran off the
 * window, and the sidebar's group filter menu had no cap at all. The
 * zoom also scaled `vh`, so the 70vh command palette and the 80vh toolbar
 * dialogs ran past the bottom edge. The chat's model submenus are covered in
 * chat-model-submenu-overflow.spec.ts.
 *
 * Real server, no tRPC mocking, no stubs: the groups are seeded into the
 * database and the coding agents into settings.json.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { acpStubEnv } from "./helpers/acp-stub";
import { expectInsideViewport } from "./helpers/geometry";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { CommandPalette } from "./pages/CommandPalette";
import { ReportsDialog } from "./pages/ReportsDialog";
import { SettingsPage } from "./pages/SettingsPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-menu-viewport-overflow-token";
const REPO = "menuoverflow";
const pad = (n: number) => String(n).padStart(2, "0");
const GROUPS = Array.from({ length: 30 }, (_, i) => ({
  id: `group-${pad(i + 1)}`,
  name: `Group ${pad(i + 1)}`,
  color: "#3b82f6",
}));
const LAST_GROUP = GROUPS[GROUPS.length - 1];
const AGENTS = Array.from({ length: 30 }, (_, i) => ({
  id: `agent-${pad(i + 1)}`,
  type: "claude-code",
  label: `Agent ${pad(i + 1)}`,
}));
const LAST_AGENT = AGENTS[AGENTS.length - 1];
const viewport = { width: 1280, height: 420 };

test.use({ viewport });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, REPO);
  mkdirSync(repoDir, { recursive: true });
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir, groupId: LAST_GROUP.id }],
      },
    ],
    groups: GROUPS,
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
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

test("the group filter menu stays inside the window and scrolls to its last group", async ({
  page,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(toWorktreeId(REPO, "main", "local"));
  await worktreePage.zoomInBy(3);

  await worktreePage.openGroupFilter();
  await expectInsideViewport(worktreePage.groupFilterMenu, viewport);

  const last = worktreePage.groupFilterOption(LAST_GROUP.name);
  await worktreePage.focusGroupFilterOption(LAST_GROUP.name);
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 1 });

  await worktreePage.scrollGroupFilterToTop();
  await expect(worktreePage.groupFilterOption(GROUPS[0].name)).toBeInViewport();
  await expect(last).not.toBeInViewport();
  await worktreePage.clickGroupFilterOption(LAST_GROUP.name);

  // Filtering the sidebar by that group still shows the repo's worktree.
  await expect(worktreePage.worktreeCard(toWorktreeId(REPO, "main", "local"))).toBeVisible();
});

test("the Default agent select stays inside the window and scrolls to its last agent", async ({
  page,
}) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await worktreePage.goto(toWorktreeId(REPO, "main", "local"));
  await worktreePage.zoomInBy(3);

  await settingsPage.openDialog("agents");
  await expectInsideViewport(settingsPage.dialog, viewport);
  await settingsPage.openDefaultAgentSelect();
  await expectInsideViewport(settingsPage.openSelectList, viewport);

  const last = settingsPage.selectOption(LAST_AGENT.label);
  await settingsPage.focusLastSelectOption();
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 1 });

  await settingsPage.scrollSelectListToTop();
  await expect(settingsPage.selectOption(AGENTS[0].label)).toBeInViewport();
  await expect(last).not.toBeInViewport();
  await settingsPage.clickSelectOption(LAST_AGENT.label);
  await expect(settingsPage.defaultAgentSelect()).toContainText(LAST_AGENT.label);
});

test("the command palette and a toolbar dialog stay inside the window", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  const palette = new CommandPalette(page);
  const reports = new ReportsDialog(page, server.url, TOKEN);
  await worktreePage.goto(toWorktreeId(REPO, "main", "local"));
  await worktreePage.zoomInBy(3);

  await palette.open();
  await expect(palette.dialog).toBeVisible();
  await expectInsideViewport(palette.dialog, viewport);
  await palette.close();

  // Reopening the dashboard keeps the zoom, which lives in client state.
  await reports.open();
  await expect.poll(() => worktreePage.readAppZoom()).toBeCloseTo(1.3, 5);
  await expectInsideViewport(reports.dialog, viewport);
});
