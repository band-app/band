/**
 * Background of the terminal pane icon cluster.
 *
 * Once a terminal is split, each pane shows split-right / split-down / close
 * icons that float over the top-right corner of its terminal. Without a
 * background, terminal output running under that corner showed through the
 * icons and made them hard to see. The cluster now paints the terminal's own
 * background, so these tests read the cluster's computed background next to the
 * one xterm paints for the same pane, in the dark and the light theme.
 *
 * Real production binary, real PTYs, no tRPC mocks, page objects only.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-terminal-pane-actions-bg-token";
const BRANCH = "main";
const PROJECT = "term-pane-actions-bg";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);

// Wide viewport so `useIsDesktop()` reports true and terminals can split.
test.use({ viewport: { width: 1280, height: 800 } });

// The xterm theme backgrounds in lib/terminal-cache.ts, as `getComputedStyle`
// reports them. Pinning them proves the seeded theme took effect.
const THEMES = [
  { theme: "dark", background: "rgb(30, 30, 30)" },
  { theme: "light", background: "rgb(255, 255, 255)" },
] as const;

for (const { theme, background } of THEMES) {
  test.describe(`Terminal pane icons in the ${theme} theme`, () => {
    let server: ServerHandle;
    let tmpHome: string;

    test.beforeAll(async () => {
      tmpHome = createTmpHome();
      const repoPath = join(tmpHome, PROJECT);
      mkdirSync(repoPath, { recursive: true });
      git(repoPath, ["init", "-b", BRANCH]);
      writeFileSync(join(repoPath, "README.md"), "# pane actions\n");
      git(repoPath, ["add", "."]);
      git(repoPath, ["commit", "-m", "initial"]);
      seedState(tmpHome, {
        projects: [
          {
            name: PROJECT,
            path: repoPath,
            defaultBranch: BRANCH,
            worktrees: [{ branch: BRANCH, path: repoPath }],
          },
        ],
      });
      seedSettings(tmpHome, { tokenSecret: TOKEN, theme, useWebGLTerminalRenderer: false });
      server = await startServer({ tmpHome });
    });

    test.afterAll(async () => {
      await server.close();
      cleanupTmpHome(tmpHome);
    });

    test("the split and close icons sit on the terminal's background", async ({ page }) => {
      const workspacePage = new WorkspacePage(page, server.url, TOKEN);
      await workspacePage.goto(WORKSPACE);
      await workspacePage.waitForReady();

      // A lone pane hides its header, so split once to get the icon clusters.
      await workspacePage.focusTerminal();
      await workspacePage.splitTerminalRight();
      await expect(workspacePage.terminalPanes()).toHaveCount(2);

      for (const index of [0, 1]) {
        await expect(workspacePage.paneActions(index)).toBeAttached();
        await expect
          .poll(() => workspacePage.paneActionsBackground(index))
          .toEqual({ actions: background, terminal: background });
      }
    });
  });
}
