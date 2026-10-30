/**
 * The keyboard-highlighted row of a list is clearly visible in dark and light
 * mode. Real server, no mocks: the worktree picker and the command palette are
 * opened with their shortcuts and the computed backgrounds of the highlighted
 * row and a normal row are compared.
 */

import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { AppearancePage } from "./pages/AppearancePage";
import { CommandPalette } from "./pages/CommandPalette";
import { MenuSurfacesPage } from "./pages/MenuSurfacesPage";
import { WorktreePage } from "./pages/WorktreePage";
import { WorktreePicker } from "./pages/WorktreePicker";

const TOKEN = "e2e-list-highlight-token";
const REPOS = ["alpha-hl", "bravo-hl", "charlie-hl"];
const WS = REPOS.map((r) => toWorktreeId(r, "main", "local"));

// Least contrast the highlighted row keeps against a normal row. Derived themes guarantee 1.3 (LIST_HIGHLIGHT_CONTRAST).
const MIN_CONTRAST = 1.2;

test.use({ viewport: { width: 1280, height: 800 } });

for (const theme of ["dark", "light"] as const) {
  test.describe(`${theme} mode`, () => {
    let server: ServerHandle;
    let tmpHome: string;

    test.beforeAll(async () => {
      tmpHome = createTmpHome();
      seedState(tmpHome, {
        repos: REPOS.map((name) => ({
          name,
          path: `/tmp/fake/${name}`,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: `/tmp/fake/${name}` }],
        })),
      });
      seedSettings(tmpHome, { tokenSecret: TOKEN, theme });
      server = await startServer({ tmpHome });
    });

    test.beforeEach(() => resetClientState(tmpHome));

    test.afterAll(async () => {
      await server.close();
      cleanupTmpHome(tmpHome);
    });

    test("the worktree picker's highlighted row stands out", async ({ page }, testInfo) => {
      const worktreePage = new WorktreePage(page, server.url, TOKEN);
      const picker = new WorktreePicker(page);
      await worktreePage.goto(WS[0] as string);
      await worktreePage.waitForReady();
      await worktreePage.openWorktreePickerViaShortcut();
      await picker.waitVisible();
      await testInfo.attach(`worktree-picker-${theme}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      expect(await picker.highlightContrast(WS[2] as string)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    });

    test("the command palette's highlighted row stands out", async ({ page }, testInfo) => {
      const worktreePage = new WorktreePage(page, server.url, TOKEN);
      const palette = new CommandPalette(page);
      await worktreePage.goto(WS[0] as string);
      await worktreePage.waitForReady();
      await palette.open();
      await expect(palette.dialog).toBeVisible();
      await testInfo.attach(`command-palette-${theme}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      const ids = await palette.rowIds();
      expect(ids.length).toBeGreaterThan(1);
      expect(await palette.highlightContrast(ids[ids.length - 1] as string)).toBeGreaterThanOrEqual(
        MIN_CONTRAST,
      );
    });

    test("a dropdown menu's highlighted row stands out", async ({ page }, testInfo) => {
      const worktreePage = new WorktreePage(page, server.url, TOKEN);
      const menus = new MenuSurfacesPage(page);
      await worktreePage.goto(WS[0] as string);
      await worktreePage.waitForReady();
      const ratio = await menus.dropdownHighlightContrast(REPOS[0] as string);
      await testInfo.attach(`dropdown-menu-${theme}`, {
        body: await menus.screenshot(),
        contentType: "image/png",
      });
      expect(ratio).toBeGreaterThanOrEqual(MIN_CONTRAST);
    });

    test("a context menu's highlighted row stands out", async ({ page }, testInfo) => {
      const worktreePage = new WorktreePage(page, server.url, TOKEN);
      const menus = new MenuSurfacesPage(page);
      await worktreePage.goto(WS[0] as string);
      await worktreePage.waitForReady();
      const ratio = await menus.contextMenuHighlightContrast(WS[1] as string);
      await testInfo.attach(`context-menu-${theme}`, {
        body: await menus.screenshot(),
        contentType: "image/png",
      });
      expect(ratio).toBeGreaterThanOrEqual(MIN_CONTRAST);
    });

    test("a select's highlighted option stands out", async ({ page }, testInfo) => {
      const appearance = new AppearancePage(page, server.url, TOKEN);
      await appearance.open();
      const ratio = await appearance.presetHighlightContrast();
      await testInfo.attach(`select-${theme}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      expect(ratio).toBeGreaterThanOrEqual(MIN_CONTRAST);
    });
  });
}
