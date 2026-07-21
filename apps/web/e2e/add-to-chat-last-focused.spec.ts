/**
 * End-to-end coverage for "Add to Chat" routing to the workspace's LAST-FOCUSED
 * chat pane when several chats are open.
 *
 * Before this feature every mounted `PromptInput` in the active workspace
 * listened to the raw `band:add-to-chat` event, so a file reference was
 * appended to *all* open chat panes. Now `SharedDockviewLayout` resolves the
 * server's last-focused chat (recorded as the user switches panes) and
 * re-dispatches a `band:chat-insert` scoped to that one chatId, so only the
 * pane the user was last using receives the reference.
 *
 * Architecture (mirrors `selection-tooltip-actions.spec.ts`): the REAL
 * production `dist/start-server.mjs` boots against a fresh tmp `$HOME` with an
 * on-disk git worktree; no tRPC mocking. The chat prompt values are read
 * straight from the rendered DOM, so the delivered reference is observed on the
 * real textarea it landed in.
 *
 * Determinism: focus is reported to the server fire-and-forget, so the test
 * polls `panelFocus.get` (via the page object) until the second pane is the
 * recorded chat focus before triggering "Add to Chat" — the action reads the
 * focus exactly once, so the record must be settled first. The two panes are
 * seeded with distinct markers ("AAA" / "BBB") so the assertion is independent
 * of dockview's DOM ordering of the split groups.
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

// Wide viewport so `useIsDesktop()` reports true and the diff editor renders
// (same reasoning as selection-tooltip-actions.spec / diff-horizontal-scroll).
test.use({ viewport: { width: 2400, height: 900 } });

const TOKEN = "e2e-add-to-chat-focus-token";
const REPO_NAME = "add-to-chat-focus-repo";
const BRANCH = "main";
const FILE_PATH = "src/notes.txt";
const FIRST_LINE = "alpha";
const EXPECTED_REFERENCE = `${FILE_PATH}:1`;
// Chat wraps the bare reference in a markdown code span (clickable file link)
// and appends a trailing space to separate it from the next keystroke.
const EXPECTED_CHAT_INSERT = `\`${EXPECTED_REFERENCE}\` `;

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
  // Leave a second line modified on disk so the Changes view lists the file.
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
// second chat pane created via the (now-removed) chat "Split right" toolbar
// button; split is keyboard-only in the unified center dockview.
test.describe
  .skip("Add to Chat — routes to the last-focused chat pane", () => {
    test("appends the reference only to the pane the user last focused", async ({ page }) => {
      const workspace = new WorkspacePage(page, server.url, TOKEN);
      const chat = new ChatPanePage(page, server.url, TOKEN);
      const tooltip = new SelectionTooltipPage(page);

      // Open the Changes panel (expand-all) so the diff is ready to select from,
      // then wait for the shared dockview to be interactive.
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

      // Open a second chat pane by splitting the chat group, then seed each pane
      // with a distinct marker. Filling a pane focuses it; the last one filled
      // (pane index 1) is the workspace's last-focused chat.
      await workspace.activateTab("chat");
      await chat.waitForReady();
      await workspace.clickChatSplitRight(workspaceId);
      await expect.poll(() => chat.promptCount(), { timeout: 15_000 }).toBe(2);

      // Focus pane 0 first and capture the chat id the server records for it.
      await chat.focusPromptAt(0);
      await chat.fillPromptAt(0, "AAA");
      await expect
        .poll(() => workspace.readServerPanelFocus(workspaceId).then((f) => f.chat), {
          message: "pane 0 recorded as the focused chat",
          timeout: 15_000,
        })
        .toBeTruthy();
      const pane0ChatId = (await workspace.readServerPanelFocus(workspaceId)).chat;

      // Focus pane 1 and wait until the server focus actually FLIPS away from
      // pane 0 — the barrier that matters, since "Add to Chat" reads the focus
      // exactly once (a mere truthy poll could pass on pane 0's earlier report
      // and route the reference into the wrong pane, which the one-shot read
      // can't self-heal). Mirrors the terminal spec's `.toBe(...)` barrier.
      await chat.focusPromptAt(1);
      await chat.fillPromptAt(1, "BBB");
      await expect
        .poll(() => workspace.readServerPanelFocus(workspaceId).then((f) => f.chat), {
          message: "focus flips to pane 1 (the last-focused chat)",
          timeout: 15_000,
        })
        .not.toBe(pane0ChatId);

      // Trigger "Add to Chat" from the diff selection tooltip.
      // NOTE(#643 Phase 2/5): the multi-file DiffView selection tooltip is now
      // mobile-only (desktop opens a bare per-path `diff` leaf), and this
      // describe was already skipped for the removed chat split button. The
      // body is never reached; this reveal only keeps it typechecking.
      await workspace.revealRightPanel();
      await changes.selectWordInDiff(FIRST_LINE);
      await tooltip.waitVisible();
      await tooltip.clickAddToChat();

      // Exactly one pane receives the reference — the last-focused one ("BBB") —
      // and the other ("AAA") is left untouched. Sorted comparison so the
      // assertion doesn't depend on dockview's DOM ordering of the split groups.
      await expect
        .poll(() => chat.allPromptValues().then((v) => [...v].sort()), {
          message: "reference lands only in the last-focused pane",
          timeout: 15_000,
        })
        .toEqual(["AAA", `BBB${EXPECTED_CHAT_INSERT}`].sort());
    });
  });
