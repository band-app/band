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
import { toWorktreeId } from "@/dashboard";
import { readEdgeColors } from "./helpers/edge-colors";
import { gitInHome } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-dialog-border-token";
const REPO = "dialog-border-repo";
const DEFAULT_BRANCH = "main";
const WORKTREE = toWorktreeId(REPO, DEFAULT_BRANCH, "local");

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  const repoPath = join(tmpHome, REPO);
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(repoPath, "README.md"), "# Dialog border test\n");
  gitInHome(repoPath, ["init", "-b", DEFAULT_BRANCH], tmpHome);
  gitInHome(repoPath, ["add", "."], tmpHome);
  gitInHome(repoPath, ["commit", "-m", "init"], tmpHome);

  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repoPath,
        defaultBranch: DEFAULT_BRANCH,
        worktrees: [{ branch: DEFAULT_BRANCH, path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN, theme: "dark" });
  server = await startServer({ tmpHome });
});

// UI state lives on the server now: start each test from none, like the
// fresh localStorage each test's browser context used to give it.
test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Dialog edges use the theme border colour", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Quick Open (command-palette variant) has a --border edge, not a white one", async ({
    page,
  }) => {
    const worktreePage = new WorktreePage(page, server.url, TOKEN);

    await worktreePage.goto(WORKTREE);
    await worktreePage.waitForReady();
    await worktreePage.dispatchOpenQuickOpen();
    await expect(worktreePage.quickOpenDialog()).toHaveAttribute("data-variant", "command-palette");

    const colors = await readEdgeColors(worktreePage.quickOpenDialog());
    expect(colors.themeBorder).not.toBe(colors.foreground);
    expect(colors.edge).toBe(colors.themeBorder);
  });
});
