/**
 * End-to-end coverage for the chat tab's right-click actions: "Copy session
 * ID" and "Continue in terminal".
 *
 * Architecture (mirrors the rest of the e2e suite + the chat specs):
 *   - REAL production `dist/start-server.mjs` boots against a fresh tmp
 *     `$HOME`. No tRPC mocking.
 *   - The only stub is `apps/web/tests/fake-agent.mjs` — the boundary stub
 *     for the agent subprocess (Claude SDK protocol over stdio). Its
 *     scenario emits a `system.init` with a known `session_id`, so sending
 *     one message establishes the chat's `activeSessionId` exactly the way
 *     a real agent run would. That session id is what both context-menu
 *     actions operate on.
 *   - UI driven through page objects: `ChatPanePage` to send the message,
 *     `WorkspacePage` for the chat-tab context menu, clipboard capture, and
 *     the outer Terminal panel. The test body never touches raw `page.*`
 *     locators.
 *
 * What's asserted here is the UI wiring: the menu opens with both items,
 * "Copy session ID" copies the underlying session id, and "Continue in
 * terminal" spawns a terminal and surfaces the Terminal panel. The exact
 * resume argv (`claude --resume <id>`) is pinned by the backend integration
 * test (`apps/web/tests/chat-continue-in-terminal.test.ts`).
 */

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
import { ChatPanePage } from "./pages/ChatPanePage";
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-chat-continue-terminal-token";
const PROJECT = "continueproj";
const WORKSPACE = toWorkspaceId(PROJECT, "main");
const SESSION_ID = "continue-term-session-xyz";

// Wide viewport so the desktop dockview layout (with the outer Terminal tab)
// renders.
test.use({ viewport: { width: 1280, height: 800 } });

const FAKE_AGENT_PATH = join(import.meta.dirname, "..", "tests", "fake-agent.mjs");

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  // The worktree directory must exist on disk — the server resolves it and
  // (for "Continue in terminal") spawns a PTY with it as CWD.
  const repoDir = join(tmpHome, "repo");
  mkdirSync(repoDir, { recursive: true });

  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir }],
      },
    ],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [
      { id: "claude-code", type: "claude-code", label: "Claude Code", command: FAKE_AGENT_PATH },
    ],
  });

  // Fast scenario: emit session-start (so the chat persists activeSessionId)
  // then an assistant message + result so the round-trip completes and we
  // have a positive UI anchor to wait on before opening the menu.
  const scenarioPath = join(tmpHome, "scenario.json");
  writeFileSync(
    scenarioPath,
    JSON.stringify([
      { type: "system", subtype: "init", session_id: SESSION_ID },
      { type: "assistant", message: { content: [{ type: "text", text: "session ready" }] } },
      {
        type: "result",
        subtype: "success",
        session_id: SESSION_ID,
        duration_ms: 1,
        num_turns: 1,
        total_cost_usd: 0.0,
      },
    ]),
  );

  server = await startServer({ tmpHome, env: { FAKE_AGENT_SCENARIO: scenarioPath } });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Chat tab context menu — continue in terminal / copy session id", () => {
  test("copies the session id and continues the session in a terminal", async ({ page }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    const workspace = new WorkspacePage(page, server.url, TOKEN);

    // Record clipboard writes before any navigation.
    await workspace.installClipboardCapture();

    await chatPane.goto(WORKSPACE);
    await chatPane.waitForReady();

    // Send one message to establish the agent session. Waiting for the
    // assistant reply is the positive anchor that session-start was
    // processed and `activeSessionId` is persisted server-side.
    await chatPane.typeMessage("kick off a session");
    await chatPane.submit();
    await expect(chatPane.assistantMessage("session ready")).toBeVisible();

    // Open the chat tab's right-click menu — both items present.
    await workspace.openChatTabContextMenu();
    await expect(workspace.chatTabContextMenu).toBeVisible();
    await expect(workspace.continueInTerminalItem).toBeVisible();
    await expect(workspace.copySessionIdItem).toBeVisible();

    // "Copy session ID" copies the chat's underlying agent session id. The
    // item enables once the on-open `chats.get` resolves the active session;
    // assert that enabled transition as a positive anchor before clicking so
    // the click can't race the resolve.
    await expect(workspace.copySessionIdItem).toBeEnabled();
    await workspace.copySessionIdItem.click();
    await expect
      .poll(async () => (await workspace.readCopied()).at(-1), {
        message: "session id copied to clipboard",
        // The copy follows the on-open chats.get round-trip; give it room
        // beyond Playwright's 5 s expect.poll default so a slow CI run
        // doesn't flake.
        timeout: 15_000,
      })
      .toBe(SESSION_ID);

    // "Continue in terminal" spawns the resume terminal and surfaces the
    // outer Terminal panel so the user lands on it.
    await workspace.openChatTabContextMenu();
    await expect(workspace.continueInTerminalItem).toBeEnabled();
    await workspace.continueInTerminalItem.click();

    // Explicit timeout: the dockview setActive effect can be starved under
    // parallel-worker CI contention (mirrors workspace-maximize-state.spec.ts).
    await expect(workspace.tabContainer("terminal")).toHaveClass(/\bdv-active-tab\b/, {
      timeout: 15_000,
    });
    await workspace.waitForTerminalReady(75_000);
  });
});
