/**
 * Mobile bottom-drawer dialog coverage.
 *
 * On a narrow viewport the app's modal dialogs (Settings, workspace picker)
 * open as bottom sheets that slide up from the bottom edge. Two observable
 * contracts:
 *
 *   1. The sheet is anchored to the bottom of the viewport (its bottom edge
 *      meets the viewport bottom).
 *   2. It does NOT reach the very top — a gap is left so that on iOS the
 *      header/close button clears the notch / Dynamic Island. The gap is
 *      `env(safe-area-inset-top) + 1.5rem`; headless Chromium reports a zero
 *      safe-area inset, so the observable minimum gap here is the 1.5rem
 *      (~24px) cap baked into the `bottom-sheet` variant's max-height. On a
 *      real device the inset is added on top, widening the gap further.
 *
 * The desktop describe guards the "leave desktop unchanged" requirement: at a
 * wide viewport the same dialogs render as centred cards, not bottom sheets.
 *
 * Real production binary, no tRPC mocks, page objects only.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
import { SettingsPage } from "./pages/SettingsPage";
import { WorkspacePage } from "./pages/WorkspacePage";
import { WorkspacePicker } from "./pages/WorkspacePicker";

const TOKEN = "e2e-bottom-drawer-token";
const PROJECT = "bottom-drawer-repo";
const DEFAULT_BRANCH = "main";
const WORKSPACE = toWorkspaceId(PROJECT, DEFAULT_BRANCH);

function makeGitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@test.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

function git(cwd: string, args: string[], home: string): void {
  execFileSync("git", args, { cwd, env: makeGitEnv(home) });
}

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", DEFAULT_BRANCH], tmpHome);
  writeFileSync(join(repoPath, "README.md"), "# Bottom drawer test\n");
  git(repoPath, ["add", "."], tmpHome);
  git(repoPath, ["commit", "-m", "init"], tmpHome);

  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repoPath,
        defaultBranch: DEFAULT_BRANCH,
        worktrees: [{ branch: DEFAULT_BRANCH, path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Mobile bottom drawers", () => {
  const VIEWPORT = { width: 800, height: 900 };
  test.use({ viewport: VIEWPORT });

  test("Settings opens as a bottom drawer with a top safe-area gap", async ({ page }) => {
    const settingsPage = new SettingsPage(page, server.url, TOKEN);

    await settingsPage.goto();
    await settingsPage.openDialog();

    // The bottom-sheet variant is applied on mobile.
    await expect(settingsPage.dialog).toHaveAttribute("data-variant", "bottom-sheet");

    const box = await settingsPage.dialogBox();
    // Anchored to the bottom edge of the viewport.
    expect(Math.abs(box.y + box.height - VIEWPORT.height)).toBeLessThanOrEqual(2);
    // Spans the full width (bottom sheet, no side margins on mobile).
    expect(box.width).toBeGreaterThanOrEqual(VIEWPORT.width - 4);
    // Does NOT reach the top — a real gap is left for the notch. Settings is
    // taller than the cap, so height is clamped and the top sits at ~1.5rem.
    expect(box.y).toBeGreaterThanOrEqual(8);
    expect(box.height).toBeLessThan(VIEWPORT.height);
  });

  test("the workspace picker opens as a command-palette bottom drawer", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    const picker = new WorkspacePicker(page);

    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForMobileReady();
    await workspacePage.openSwitcherFromHeader();
    await picker.waitVisible();

    // The command-palette variant is a bottom drawer on mobile (input pinned
    // below the list) — see command-dialog-layout.spec.ts for the ordering.
    await expect(picker.dialog).toHaveAttribute("data-variant", "command-palette");

    const box = await picker.dialogBox();
    // Anchored to the bottom edge and spanning the full width.
    expect(Math.abs(box.y + box.height - VIEWPORT.height)).toBeLessThanOrEqual(2);
    expect(box.width).toBeGreaterThanOrEqual(VIEWPORT.width - 4);
    // Sits below the top of the viewport (a bottom drawer, not a full-screen or
    // top-anchored modal).
    expect(box.y).toBeGreaterThan(8);
  });

  test("Quick Open opens as a command-palette bottom drawer", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForMobileReady();

    // Same event the file-tree toolbar's "Quick Open" action fires.
    await workspacePage.dispatchOpenQuickOpen();
    await expect(workspacePage.quickOpenDialog()).toBeVisible();
    await expect(workspacePage.quickOpenDialog()).toHaveAttribute(
      "data-variant",
      "command-palette",
    );

    const box = await workspacePage.settledBoxOf(workspacePage.quickOpenDialog());
    expect(Math.abs(box.y + box.height - VIEWPORT.height)).toBeLessThanOrEqual(2);
    expect(box.width).toBeGreaterThanOrEqual(VIEWPORT.width - 4);
    expect(box.y).toBeGreaterThan(8);
  });

  test("Search in Files opens as a command-palette bottom drawer", async ({ page }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForMobileReady();

    // Same event the file-tree toolbar's "Search in Files" action fires.
    await workspacePage.dispatchOpenSearchFiles();
    await expect(workspacePage.searchFilesDialog()).toBeVisible();
    await expect(workspacePage.searchFilesDialog()).toHaveAttribute(
      "data-variant",
      "command-palette",
    );

    const box = await workspacePage.settledBoxOf(workspacePage.searchFilesDialog());
    expect(Math.abs(box.y + box.height - VIEWPORT.height)).toBeLessThanOrEqual(2);
    expect(box.width).toBeGreaterThanOrEqual(VIEWPORT.width - 4);
    expect(box.y).toBeGreaterThan(8);
  });
});

test.describe("Desktop dialogs stay centred", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Settings renders as a centred card, not a bottom drawer", async ({ page }) => {
    const settingsPage = new SettingsPage(page, server.url, TOKEN);

    await settingsPage.goto();
    await settingsPage.openDialog();

    const box = await settingsPage.dialogBox();
    // Not full-width — a centred card with side margins.
    expect(box.width).toBeLessThan(1000);
    // Horizontally centred within the viewport (±4px tolerance).
    expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThanOrEqual(4);
    // Not anchored to the bottom edge — there's a gap below it too.
    expect(box.y + box.height).toBeLessThan(800 - 8);
  });
});
