/**
 * Mouse-positioned popups and sidebar drags under an app zoom other than 100%.
 *
 * The app zooms with CSS `zoom` on `<html>`. A popup placed at `clientX/clientY` and a dnd-kit
 * preview placed from `getBoundingClientRect` both use viewport pixels, which the zoom scales
 * a second time. The page loads at a saved zoom level (125% and 80%), and each case checks a
 * position against the pointer:
 *   - the terminal link popover opens at the clicked link,
 *   - the editor's right-click menu opens at the cursor,
 *   - the drag preview of a sidebar worktree stays under the cursor, and the drop lands,
 *   - groups reorder by drag in the sidebar and in Settings > Groups.
 *
 * Real production hub, a real git repo with two worktrees, two groups, a real PTY.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { git } from "./helpers/git";
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
import { SelectionMenu } from "./pages/SelectionMenu";
import { SettingsPage } from "./pages/SettingsPage";
import { SidebarGroupsPage } from "./pages/SidebarGroupsPage";
import { TerminalLinkPopoverPage } from "./pages/TerminalLinkPopoverPage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-ui-zoom-popups-drag-token";
const REPO = "zoomrepo";
const ALPHA = "g-alpha";
const BETA = "g-beta";
const MAIN = toWorktreeId(REPO, "main", "local");
const EXTRA = toWorktreeId(REPO, "extra", "local");
const FILE_PATH = "src/notes.txt";
const URL_TEXT = "https://example.test/zoom";
// A pointer position and its popup differ by sub-pixel rounding at most.
const TOLERANCE_PX = 8;
const ZOOMS = [1.25, 0.8];

test.use({ viewport: { width: 1600, height: 900 } });

let server: ServerHandle;
let tmpHome: string;
let workdir: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  workdir = realpathSync(mkdtempSync(join(tmpdir(), "band-zoom-popups-")));
  mkdirSync(join(workdir, "src"), { recursive: true });
  git(workdir, ["init", "-b", "main"]);
  writeFileSync(join(workdir, FILE_PATH), "alpha\ngamma\nbeta\n");
  git(workdir, ["add", "."]);
  git(workdir, ["commit", "-m", "initial"]);
  const extraPath = join(workdir, "..", `${REPO}-extra-${Date.now()}`);
  git(workdir, ["worktree", "add", "-b", "extra", extraPath]);
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  seedState(tmpHome, {
    groups: [
      { id: ALPHA, name: "Alpha", color: "#8b5cf6" },
      { id: BETA, name: "Beta", color: "#3b82f6" },
    ],
    repos: [
      {
        name: REPO,
        path: workdir,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: workdir, groupId: ALPHA },
          { branch: "extra", path: extraPath, groupId: ALPHA },
        ],
      },
    ],
  });
  server = await startServer({ tmpHome });
});

test.beforeEach(async () => {
  resetClientState(tmpHome);
  await trpcMutate(server.url, TOKEN, "groups.reorder", { ids: [ALPHA, BETA] });
  await trpcMutate(server.url, TOKEN, "worktrees.setGroup", { worktreeId: EXTRA, groupId: ALPHA });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
  rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function groupOf(worktreeId: string): Promise<string | null | undefined> {
  const { repos } = await trpcQuery<{
    repos: { worktrees: { worktreeId: string; groupId: string | null }[] }[];
  }>(server.url, TOKEN, "repos.list");
  return repos.flatMap((r) => r.worktrees).find((w) => w.worktreeId === worktreeId)?.groupId;
}

function near(actual: { x: number; y: number }, expected: { x: number; y: number }) {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(TOLERANCE_PX);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(TOLERANCE_PX);
}

for (const zoom of ZOOMS) {
  test.describe(`at ${Math.round(zoom * 100)}% zoom`, () => {
    test("S1: the terminal link popover opens at the clicked link", async ({ page }) => {
      test.setTimeout(120_000);
      const worktree = new WorktreePage(page, server.url, TOKEN);
      const menu = new TerminalLinkPopoverPage(page);
      await worktree.startAtZoom(zoom);
      await worktree.goto(MAIN);
      await worktree.waitForReady();
      await worktree.openTerminalTab();
      await worktree.waitForTerminalReady(75_000);
      await worktree.runInTerminal(`echo ${URL_TEXT}`);
      await worktree.clickTerminalFileLink(URL_TEXT);
      await expect(menu.popover).toBeVisible();
      const click = worktree.lastTerminalClick;
      expect(click).not.toBeNull();
      near(await menu.corner(), click!);
    });

    test("S2: the editor's right-click menu opens at the cursor", async ({ page }) => {
      const worktree = new WorktreePage(page, server.url, TOKEN);
      const selection = new SelectionMenu(page);
      await worktree.startAtZoom(zoom);
      await worktree.goto(MAIN);
      await worktree.waitForReady();
      await worktree.openFileLeaf(FILE_PATH, MAIN);
      const editor = worktree.fileLeafVisibilityMarker(true).first();
      const at = await selection.openOnEditorWordAt(editor, "gamma");
      await expect(selection.root).toBeVisible();
      near(await selection.cornerOfMenu(), at);
    });

    test("S3: the drag preview follows the cursor and the drop lands in the group", async ({
      page,
    }) => {
      const worktree = new WorktreePage(page, server.url, TOKEN);
      const sidebar = new SidebarGroupsPage(page);
      await worktree.startAtZoom(zoom);
      await worktree.goto(MAIN);
      await worktree.waitForReady();
      await expect(sidebar.row(EXTRA)).toBeVisible();
      const worst = await sidebar.dragToGroupMeasuringPreview(EXTRA, BETA);
      expect(worst).toBeLessThanOrEqual(TOLERANCE_PX);
      await expect.poll(() => groupOf(EXTRA)).toBe(BETA);
    });

    test("S4: groups reorder by drag in the sidebar and in Settings > Groups", async ({ page }) => {
      const worktree = new WorktreePage(page, server.url, TOKEN);
      const sidebar = new SidebarGroupsPage(page);
      await worktree.startAtZoom(zoom);
      await worktree.goto(MAIN);
      await worktree.waitForReady();
      await expect.poll(() => sidebar.headerOrder()).toEqual([ALPHA, BETA]);
      await sidebar.dragGroup(BETA, ALPHA, "top");
      await expect.poll(() => sidebar.headerOrder()).toEqual([BETA, ALPHA]);

      const settings = new SettingsPage(page, server.url, TOKEN);
      await settings.openDialog("groups");
      const ids = () =>
        settings
          .groupRows()
          .evaluateAll((els) => els.map((el) => el.getAttribute("data-group-id") ?? ""));
      await expect.poll(ids).toEqual([BETA, ALPHA]);
      await settings.dragGroupRow(BETA, ALPHA);
      await expect.poll(ids).toEqual([ALPHA, BETA]);
    });
  });
}
