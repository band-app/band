/**
 * Dialog edge colour in the dark theme.
 *
 * Tailwind v4 draws a bare `border` class in currentColor, which in the dark
 * theme is the near-white foreground. The shared `DialogContent` variants
 * used to rely on that fallback, so every modal (Settings, Quick Open, the
 * command palettes) showed a bright white outline. The fix pins the edge to
 * the theme's `--border` token. These tests read the computed edge colour of
 * one dialog per layout variant and compare it against the resolved tokens.
 *
 * The settings seed pins the theme to dark, the theme the bug was reported
 * in, so the tests keep covering it if the app default ever changes.
 *
 * Real production binary, no tRPC mocks, page objects only.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { readEdgeColors } from "./helpers/edge-colors";
import { gitInHome } from "./helpers/git";
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

const TOKEN = "e2e-dialog-border-token";
const PROJECT = "dialog-border-repo";
const DEFAULT_BRANCH = "main";
const WORKSPACE = toWorkspaceId(PROJECT, DEFAULT_BRANCH);

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(repoPath, "README.md"), "# Dialog border test\n");
  gitInHome(repoPath, ["init", "-b", DEFAULT_BRANCH], tmpHome);
  gitInHome(repoPath, ["add", "."], tmpHome);
  gitInHome(repoPath, ["commit", "-m", "init"], tmpHome);

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
  seedSettings(tmpHome, { tokenSecret: TOKEN, theme: "dark" });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Dialog edges use the theme border colour", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Settings (bottom-sheet variant) has a --border edge, not a white one", async ({ page }) => {
    const settingsPage = new SettingsPage(page, server.url, TOKEN);

    await settingsPage.goto();
    await settingsPage.openDialog();
    await expect(settingsPage.dialog).toHaveAttribute("data-variant", "bottom-sheet");

    const colors = await readEdgeColors(settingsPage.dialog);
    expect(colors.themeBorder).not.toBe(colors.foreground);
    expect(colors.edge).toBe(colors.themeBorder);
  });

  test("Quick Open (command-palette variant) has a --border edge, not a white one", async ({
    page,
  }) => {
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();
    await workspacePage.dispatchOpenQuickOpen();
    await expect(workspacePage.quickOpenDialog()).toHaveAttribute(
      "data-variant",
      "command-palette",
    );

    const colors = await readEdgeColors(workspacePage.quickOpenDialog());
    expect(colors.themeBorder).not.toBe(colors.foreground);
    expect(colors.edge).toBe(colors.themeBorder);
  });
});
