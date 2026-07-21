/**
 * End-to-end coverage for "Add to Terminal" routing to the workspace's
 * LAST-FOCUSED terminal when several terminals are open.
 *
 * The mirror of `add-to-chat-last-focused.spec.ts` for the terminal path.
 * Before this feature the reference went to whichever terminal happened to be
 * *visible*; now `SharedDockviewLayout` resolves the server's last-focused
 * terminal and re-dispatches a `band:terminal-insert` carrying that terminalId,
 * so only that terminal's PTY receives it.
 *
 * Architecture (mirrors `selection-tooltip-actions.spec.ts`): the REAL
 * production `dist/start-server.mjs` boots against a fresh tmp `$HOME` with an
 * on-disk git worktree; no tRPC mocking. Terminal input is captured via the
 * outgoing WebSocket frames (the `ws.send(reference)` → server → `pty.write`
 * path IS the delivery, and the WebGL-rendered terminal text can't be read from
 * the DOM). `installTerminalSendUrlCapture` records each frame with its socket
 * URL, so `terminalIdsThatReceived` can prove WHICH terminal got the reference.
 *
 * The two terminals are distinguished purely by server-recorded focus: after
 * splitting (which activates the NEW terminal), the test clicks back into the
 * FIRST terminal so the last-focused terminal is the older, non-newest one —
 * a meaningful "follows focus, not just the newest/visible tab" signal. Focus
 * is reported fire-and-forget, so the test polls `panelFocus.get` until the
 * recorded terminal actually changes to the re-focused pane before triggering
 * "Add to Terminal" (which reads the focus exactly once).
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
import { SelectionTooltipPage } from "./pages/SelectionTooltipPage";
import { WorkspacePage } from "./pages/WorkspacePage";

// Wide viewport so `useIsDesktop()` reports true and the diff editor renders.
test.use({ viewport: { width: 2400, height: 900 } });

const TOKEN = "e2e-add-to-terminal-focus-token";
const REPO_NAME = "add-to-terminal-focus-repo";
const BRANCH = "main";
const FILE_PATH = "src/notes.txt";
const FIRST_LINE = "alpha";
const EXPECTED_REFERENCE = `${FILE_PATH}:1`;
// Terminal receives the bare reference + trailing space, no newline.
const EXPECTED_TERMINAL_INSERT = `${EXPECTED_REFERENCE} `;

let server: ServerHandle;
let tmpHome: string;
let repoPath: string;
let workspaceId: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  repoPath = join(tmpHome, REPO_NAME);
  mkdirSync(join(repoPath, "src"), { recursive: true });

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

// TODO(#643 Phase 5): re-point to Cmd+D split / new toolbar. This spec needs a
// second terminal created via the (now-removed) terminal "Split right" toolbar
// button and asserts on the server-side inner layout (countTerminalPanels),
// which no longer projects the unified center dockview's localStorage layout.
test.describe
  .skip("Add to Terminal — routes to the last-focused terminal", () => {
    test("types the reference only into the terminal the user last focused", async ({ page }) => {
      const workspace = new WorkspacePage(page, server.url, TOKEN);
      const tooltip = new SelectionTooltipPage(page);

      // Must register before the navigation the factory performs.
      await workspace.installTerminalSendUrlCapture();

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

      // Open a first terminal (live PTY socket) and capture its id from the
      // server-recorded focus.
      await workspace.openTerminalTab();
      await workspace.waitForTerminalReady();
      await expect
        .poll(() => workspace.readServerPanelFocus(workspaceId).then((f) => f.terminal), {
          message: "first terminal recorded as focused",
          timeout: 15_000,
        })
        .toBeTruthy();
      const firstTerminalId = (await workspace.readServerPanelFocus(workspaceId)).terminal;

      // Split into a second terminal. Splitting activates the NEW terminal, so it
      // becomes the recorded focus (confirming focus tracking follows the split).
      await workspace.clickTerminalSplitRight(workspaceId);
      await expect
        .poll(() => workspace.countTerminalPanels(workspaceId), { timeout: 15_000 })
        .toBe(2);
      await expect
        .poll(() => workspace.readServerPanelFocus(workspaceId).then((f) => f.terminal), {
          message: "split terminal becomes the recorded focus",
          timeout: 15_000,
        })
        .not.toBe(firstTerminalId);

      // Click back into the FIRST terminal so the last-focused terminal is the
      // older pane — proving routing follows focus, not the newest/visible tab.
      await workspace.focusTerminalPane(0);
      await expect
        .poll(() => workspace.readServerPanelFocus(workspaceId).then((f) => f.terminal), {
          message: "re-focused (older) terminal becomes the recorded focus",
          timeout: 15_000,
        })
        .toBe(firstTerminalId);
      const targetTerminalId = firstTerminalId;

      // Trigger "Add to Terminal" from the diff selection tooltip.
      // NOTE(#643 Phase 2/5): the multi-file DiffView selection tooltip is now
      // mobile-only (desktop opens a bare per-path `diff` leaf), and this
      // describe was already skipped for the removed terminal split button. The
      // body is never reached; this reveal only keeps it typechecking.
      await workspace.revealRightPanel();
      await changes.selectWordInDiff(FIRST_LINE);
      await tooltip.waitVisible();
      await tooltip.clickAddToTerminal();

      // The reference reaches exactly the last-focused terminal — no sibling.
      await expect
        .poll(() => workspace.terminalIdsThatReceived(EXPECTED_TERMINAL_INSERT), {
          message: "reference typed only into the last-focused terminal",
          timeout: 15_000,
        })
        .toEqual([targetTerminalId]);
    });
  });
