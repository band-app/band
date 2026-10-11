/**
 * Find-in-terminal fixes from patches/@xterm__addon-search (from orca,
 * upstream PR xtermjs/xterm.js#6149):
 *
 * - One very long wrapped line (minified JSON, base64, a single huge log
 *   record). Unpatched, the addon rewound to the start of a wrapped line by
 *   recursing once per wrapped row and re-summed the whole line for every
 *   match, so a search over a line filling most of the 10,000-row scrollback
 *   overflowed the stack or froze the renderer, and the counter showed
 *   "No results".
 * - Whole word. Unpatched, a rejected first hit on a line ended the search of
 *   that line, so `needle` in `needleX needle` was never found.
 *
 * Boots the real production server against a fresh tmp home and a real git
 * worktree, and drives a real Chromium through page objects. No tRPC mocking,
 * no `page.route()` on own routes.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { git } from "./helpers/git";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-terminal-find-long-line-token";
const REPO = "find-long-line-repo";
const BRANCH = "main";
const WORKTREE = toWorktreeId(REPO, BRANCH, "local");

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
  const repoPath = join(tmpHome, REPO);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", BRANCH]);
  git(repoPath, ["commit", "--allow-empty", "-m", "initial"]);
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
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
  // Printing ~1 MB through the PTY and scanning it takes longer than the
  // default 30 s budget on a slow runner.
  test.setTimeout(90_000);
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await worktreePage.focusTerminal();
  await worktreePage.waitForTerminalRenderedPrompt(WORKTREE);
  await worktreePage.runInTerminalUntilRendered(WORKTREE, PRINT_LONG_LINE, /LONG_DONE/, {
    attempts: 1,
    renderTimeoutMs: 30_000,
  });

  await worktreePage.pressFindShortcut();
  const find = worktreePage.terminalPaneFindWidget();
  await expect(find.input).toBeFocused();
  await find.type("needle");
  await expect(find.count).toHaveText(`1/${MATCHES}`);

  // Stepping re-enters the line mid-way, which is where the recursion started.
  await find.press("Enter");
  await expect(find.count).toHaveText(`2/${MATCHES}`);
});

test("whole-word find matches a word after a rejected hit on the same line", async ({ page }) => {
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await worktreePage.goto(WORKTREE);
  await worktreePage.waitForReady();
  await worktreePage.focusTerminal();
  await worktreePage.waitForTerminalRenderedPrompt(WORKTREE);
  // The quotes keep the typed command's echo from holding a whole-word
  // `needle`; only the executed output `needleX needle` does.
  await worktreePage.runInTerminalUntilRendered(
    WORKTREE,
    "echo needleX' 'nee''dle",
    /needleX needle/,
  );

  await worktreePage.pressFindShortcut();
  const find = worktreePage.terminalPaneFindWidget();
  await expect(find.input).toBeFocused();
  await find.wholeWordToggle.click();
  await find.type("needle");
  // Only the output's second word. The echo holds no whole-word `needle`, and
  // neither does the long line the previous test may have left in this terminal.
  await expect(find.count).toHaveText("1/1");
});
