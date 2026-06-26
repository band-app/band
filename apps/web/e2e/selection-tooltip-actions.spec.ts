/**
 * End-to-end coverage for the three selection-tooltip actions that
 * `selectionToChatExtension` renders inside the diff viewer (and file viewer):
 *
 *   - "Add to Chat"     → appends a bare `path:line` reference to the chat input.
 *   - "Copy reference"  → copies the bare reference to the clipboard.
 *   - "Add to Terminal" → surfaces the workspace's terminal and types the
 *                         reference into the running PTY session.
 *
 * Architecture (mirrors `copy-file-path.spec.ts` + `chat-continue-in-terminal.spec.ts`):
 *   - REAL production `dist/start-server.mjs` boots against a fresh tmp `$HOME`
 *     with an on-disk git worktree. No tRPC mocking — the diff comes through the
 *     same pipeline production uses.
 *   - Clipboard writes are captured via `WorkspacePage.installClipboardCapture`
 *     (which removes `navigator.clipboard` and records the `execCommand("copy")`
 *     fallback) — doubling as a guard that the action uses the shared
 *     `writeClipboardText` helper.
 *   - Terminal input is captured via `WorkspacePage.installTerminalSendCapture`,
 *     which records the STRING frames the page writes to the `/terminal?`
 *     WebSocket. That socket → server → `pty.write` IS the delivery path, and
 *     the WebGL-rendered terminal text can't be read from the DOM, so the
 *     outgoing frame is the deterministic proof surface (same approach as the
 *     terminal-reconnect spec's socket instrumentation).
 *
 * The seeded file is committed with one single-word line, then a second line is
 * left modified on disk so the Changes view lists it ("M") and the diff renders
 * both lines. The test double-clicks the FIRST line's word (file line 1 in both
 * old and new numbering, so the expected reference is unambiguous regardless of
 * the diff's line-number mapping): `src/notes.txt:1`.
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
import { ChangesPanelPage } from "./pages/ChangesPanelPage";
import { ChatPanePage } from "./pages/ChatPanePage";
import { SelectionTooltipPage } from "./pages/SelectionTooltipPage";
import { WorkspacePage } from "./pages/WorkspacePage";

// Wide viewport so `useIsDesktop()` reports true and the Changes panel's
// container clears the `@[40rem]/diff` query that gates the diff editor width.
// (Same reasoning as copy-file-path.spec / diff-horizontal-scroll.spec.)
test.use({ viewport: { width: 2400, height: 900 } });

const TOKEN = "e2e-selection-tooltip-token";
const REPO_NAME = "selection-tooltip-repo";
const BRANCH = "main";
const FILE_PATH = "src/notes.txt";
// Single-word line so the double-click word-select deterministically picks it.
const FIRST_LINE = "alpha";
// A single-line (word) selection of line 1 → bare reference is just `path:1`.
const EXPECTED_REFERENCE = `${FILE_PATH}:1`;

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;
let workspaceId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(join(repoPath, "src"), { recursive: true });

  // Commit the file with a single line, then leave a second line modified on
  // disk so the Changes view shows it as "M" and the diff renders both lines.
  git(repoPath, ["init", "-b", BRANCH]);
  writeFileSync(join(repoPath, FILE_PATH), `${FIRST_LINE}\n`);
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  writeFileSync(join(repoPath, FILE_PATH), `${FIRST_LINE}\nbeta\n`);

  seedState(tmpHome, {
    projects: [
      {
        name: REPO_NAME,
        path: repoPath,
        defaultBranch: BRANCH,
        worktrees: [{ branch: BRANCH, path: repoPath }],
      },
    ],
  });
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
  workspaceId = toWorkspaceId(REPO_NAME, BRANCH);
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Diff selection tooltip — copy reference / add to chat / add to terminal", () => {
  test("offers all three actions and delivers the file reference to each target", async ({
    page,
  }) => {
    const workspace = new WorkspacePage(page, server.url, TOKEN);
    const chat = new ChatPanePage(page, server.url, TOKEN);
    const tooltip = new SelectionTooltipPage(page);

    // Both init-script captures must be registered before the navigation that
    // `openWithFileExpanded` performs.
    await workspace.installClipboardCapture();
    await workspace.installTerminalSendCapture();

    const changes = await ChangesPanelPage.openWithFileExpanded({
      page,
      baseUrl: server.url,
      token: TOKEN,
      workspaceId,
      filename: FILE_PATH,
      fileStatus: "M",
      viewMode: "unified",
    });
    await workspace.waitForReady();

    // Boot the terminal (open socket → live PTY) so "Add to Terminal" has a
    // session to deliver into, then return to the Changes tab to drive the
    // tooltip. The terminal stays mounted as a hidden tab with its socket open.
    await workspace.openTerminalTab();
    await workspace.waitForTerminalReady();
    await workspace.tab("changes").click();

    // ── All three actions are present on a selection ──────────────────────
    await changes.selectWordInDiff(FIRST_LINE);
    await tooltip.waitVisible();
    await expect(tooltip.addToChat).toBeVisible();
    await expect(tooltip.addToTerminal).toBeVisible();
    await expect(tooltip.copyReference).toBeVisible();

    // ── Copy reference → bare `path:line` on the clipboard ────────────────
    await tooltip.clickCopyReference();
    await expect
      .poll(async () => (await workspace.readCopied()).at(-1), {
        message: "file reference copied to clipboard",
        timeout: 15_000,
      })
      .toBe(EXPECTED_REFERENCE);

    // ── Add to Chat → bare reference appended to the chat input ───────────
    await changes.selectWordInDiff(FIRST_LINE);
    await tooltip.waitVisible();
    await tooltip.clickAddToChat();
    await expect
      .poll(async () => chat.promptValue(), {
        message: "file reference appended to chat input",
        timeout: 15_000,
      })
      // Chat appends a trailing space so the reference is separated from
      // whatever the user types next.
      .toBe(`${EXPECTED_REFERENCE} `);

    // ── Add to Terminal → reference typed into the PTY session ────────────
    await changes.selectWordInDiff(FIRST_LINE);
    await tooltip.waitVisible();
    await tooltip.clickAddToTerminal();
    await expect
      .poll(async () => await workspace.readTerminalSent(), {
        message: "file reference written to the terminal socket",
        timeout: 15_000,
      })
      // Terminal receives the same bare reference + trailing space, no newline
      // (type-only — the agent/user decides when to submit).
      .toContain(`${EXPECTED_REFERENCE} `);
  });
});
