/**
 * Wide emoji take two terminal cells.
 *
 * Bug: in Band's terminal, text printed right after an emoji such as U+1F7E0
 * (orange circle) overlapped the emoji's right half. Claude Code's status line
 * rendered "🟠Anthropic" with no gap. xterm defaults to the Unicode 6 width
 * tables, which count emoji added after Unicode 6 as one cell, while the
 * program writing them (and every other terminal) counts two.
 *
 * Fix: the client xterm and the server's headless mirror both load the
 * Unicode 11 addon and set `unicode.activeVersion = "11"`. The mirror has to
 * match too: a reconnect replays its serialized screen, and that snapshot
 * restores the cursor to the column the mirror computed.
 *
 * The spec draws two rows on an alt screen through a real shell. Row 0 prints
 * the emoji and the text back to back, which the client must lay out itself.
 * Row 1 prints the emoji, then moves the cursor to column 3 (1-based) before
 * the text, the way a TUI positions a status line. Both rows must put the
 * emoji in columns 0-1 and the text from column 2. After a reload the client
 * draws the screen from the mirror's snapshot. A Unicode 6 mirror stores row 1
 * as emoji, empty cell, text, and replaying that on a Unicode 11 client pushes
 * the text to column 3, so the reload check covers the mirror.
 *
 * Renderer note: `useWebGLTerminalRenderer: false` so `runInTerminalUntilRendered`
 * can read the printed text from the DOM renderer's `.xterm-rows`. The
 * assertion itself reads the buffer, which is renderer-independent.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-emoji-width-token";
const PROJECT = "alpha-emoji-width";
const WORKSPACE = toWorkspaceId(PROJECT, "main");
const EMOJI = "\u{1F7E0}";
const TEXT = "GAPTAIL";
// Emoji (two cells: the glyph, then an empty right half) followed by TEXT.
const EXPECTED_CELLS = [EMOJI, "", ...TEXT];
// Both rows lay out the same way; the cursor ends after row 1's text.
const EXPECTED_SCREEN = {
  rows: [EXPECTED_CELLS, EXPECTED_CELLS],
  cursor: { x: 2 + TEXT.length, y: 1 },
};

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;
let workdir: string;

function makeGitWorkdir(prefix: string, home: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir, env });
  return dir;
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  workdir = makeGitWorkdir("band-emoji-", tmpHome);
  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: workdir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: workdir }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN, useWebGLTerminalRenderer: false });
  server = await startServer({ tmpHome });
});

test.afterAll(async () => {
  if (server) await server.close();
  if (tmpHome) cleanupTmpHome(tmpHome);
  if (workdir) rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test.describe("Terminal wide emoji width", () => {
  test("text after a wide emoji starts two columns later, live and after replay", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);

    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await workspacePage.waitForTerminalReady(20_000);
    await workspacePage.waitForTerminalRenderedPrompt(WORKSPACE);

    // Enter the alt screen and draw both rows, then block on `read` so no
    // prompt moves the cursor. The script holds the emoji bytes, so only the
    // short `bash <path>` line is typed.
    const drawScript = join(workdir, "draw.sh");
    const draw = `\\033[?1049h\\033[1;1H${EMOJI}${TEXT}\\033[2;1H${EMOJI}\\033[2;3H${TEXT}`;
    writeFileSync(drawScript, `printf '${draw}'\nread -r _\n`, "utf-8");
    await workspacePage.runInTerminalUntilRendered(
      WORKSPACE,
      `bash ${drawScript}`,
      new RegExp(TEXT),
    );

    await expect
      .poll(() => workspacePage.readTerminalBufferCells(WORKSPACE, 2, EXPECTED_CELLS.length), {
        timeout: 10_000,
      })
      .toEqual(EXPECTED_SCREEN);

    // Tear the client down and reconnect: the new client draws the screen
    // from the server mirror's serialized snapshot.
    await workspacePage.navigateToBlank();
    await workspacePage.goto(WORKSPACE);
    await workspacePage.waitForReady();
    await workspacePage.openTerminalTab();
    await workspacePage.waitForTerminalReady(20_000);

    await expect
      .poll(() => workspacePage.readTerminalBufferCells(WORKSPACE, 2, EXPECTED_CELLS.length), {
        timeout: 20_000,
      })
      .toEqual(EXPECTED_SCREEN);
  });
});
