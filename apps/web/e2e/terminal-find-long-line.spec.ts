/**
 * Find-in-terminal over one very long wrapped line: minified JSON, base64, a
 * single huge log record. Unpatched, @xterm/addon-search rewound to the start
 * of a wrapped line by recursing once per wrapped row and re-summed the whole
 * line for every match, so a search over a line filling most of the 10,000-row
 * scrollback overflowed the stack or froze the renderer, and the find widget's
 * counter never updated. Fixed by patches/@xterm__addon-search (from orca,
 * upstream PR xtermjs/xterm.js#6149).
 *
 * Boots the real production server against a fresh tmp home and a real git
 * worktree, and drives a real Chromium through page objects. No tRPC mocking,
 * no `page.route()` on own routes.
 */

import { mkdirSync } from "node:fs";
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

const TOKEN = "e2e-terminal-find-long-line-token";
const PROJECT = "find-long-line-repo";
const BRANCH = "main";
const WORKSPACE = toWorkspaceId(PROJECT, BRANCH);

/** Screen rows the one logical line fills. Under the 10,000-row scrollback so
 *  no row is trimmed, and deep enough to overflow the old recursive rewind. */
const LINE_ROWS = 8000;
/** One `needle` every MATCH_STRIDE rows, so the line holds 200 matches. */
const MATCH_STRIDE = 40;
const MATCHES = LINE_ROWS / MATCH_STRIDE;

// Prints LINE_ROWS full-width rows with no newline between them, one match per
// MATCH_STRIDE rows, then a marker line. `process.stdout.columns` is the PTY
// width, so every row is exactly full and the whole thing is one wrapped line.
// The needle is split in the command text so its echo is not a match.
const PRINT_LONG_LINE =
  `node -e 'const c=process.stdout.columns;let s="";` +
  `for(let r=0;r<${LINE_ROWS};r++)s+=r%${MATCH_STRIDE}===${MATCH_STRIDE - 1}?("nee"+"dle").padEnd(c,"x"):"x".repeat(c);` +
  `process.stdout.write(s+"\\n")'; echo LONG_"DONE"`;

// Wide viewport so `useIsDesktop()` reports true and the center terminal renders.
test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoPath = join(tmpHome, PROJECT);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  git(repoPath, ["commit", "--allow-empty", "-m", "initial"]);
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
  // DOM renderer, so the test can wait for the marker in `.xterm-rows`.
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("find counts every match inside one line that wraps across 8,000 rows", async ({ page }) => {
  const workspacePage = new WorkspacePage(page, server.url, TOKEN);
  await workspacePage.goto(WORKSPACE);
  await workspacePage.waitForReady();
  await workspacePage.focusTerminal();
  await workspacePage.waitForTerminalRenderedPrompt(WORKSPACE);
  await workspacePage.runInTerminalUntilRendered(WORKSPACE, PRINT_LONG_LINE, /LONG_DONE/, {
    attempts: 1,
    renderTimeoutMs: 30_000,
  });

  await workspacePage.pressFindShortcut();
  const find = workspacePage.terminalPaneFindWidget();
  await expect(find.input).toBeFocused();
  await find.type("needle");
  await expect(find.count).toHaveText(new RegExp(`^\\d+/${MATCHES}$`));

  // Stepping re-enters the line mid-way, which is where the recursion started.
  await find.press("Enter");
  await expect(find.count).toHaveText(new RegExp(`^\\d+/${MATCHES}$`));
});
