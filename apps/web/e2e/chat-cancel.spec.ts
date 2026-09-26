/**
 * End-to-end coverage for the Stop button — cancelling an in-flight
 * chat task and asserting the UI clears.
 *
 * The backend cancel path is covered by the vitest integration test
 * `acp-chat.test.ts > stops a turn with session/cancel ...`
 * (POST /trpc/tasks.abort → ACP `session/cancel` → a `cancelled` turn end). This Playwright test
 * covers the UI side: while a task is mid-stream and the Stop button
 * is showing, clicking it must:
 *
 *   1. Disappear the Stop button (status leaves "streaming").
 *   2. Disappear the thinking indicator, and show the "stopped" notice.
 *   3. Leave any partial text rendered (user can see what the agent
 *      managed to say before they cancelled).
 *
 * Architecture:
 *
 *   - REAL `dist/start-server.mjs` against a fresh `mkdtempSync()` home.
 *   - NO tRPC mocking. `tasks.abort` runs for real and sends ACP
 *     `session/cancel` to the agent subprocess.
 *   - The ACP stub agent at `apps/web/tests/fixtures/acp-stub-agent.mjs`
 *     (stdio subprocess stub, the only allowed mock) streams a message
 *     chunk immediately, then blocks until Band sends `session/cancel`.
 *     That gives us time to click Stop while the task is still mid-stream
 *     (status === "streaming", i.e. the Stop button is visible).
 *   - UI driven through `ChatPanePage`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { acpStubEnv } from "./helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChatPanePage } from "./pages/ChatPanePage";

const TOKEN = "e2e-chat-cancel-token";
const PROJECT = "cancelproj";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

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
      {
        id: "claude-code",
        type: "claude-code",
        label: "Claude Code",
      },
    ],
  });

  // Scenario: stream a short message chunk IMMEDIATELY so the client
  // flips to status="streaming" and the Stop button renders, then block
  // until `session/cancel`. That wait is what the test cancels into.
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [{ steps: [{ say: "partial reply " }, { waitForCancel: true }] }],
    }),
  });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Chat cancel — Stop button aborts the task", () => {
  test("Stop button appears when the agent starts streaming, then clearing the indicator on click", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(WORKSPACE);
    await chatPane.waitForReady();

    await chatPane.typeMessage("cancel me");
    await chatPane.submit();

    // Wait until the agent has started streaming text — at that point
    // status === "streaming" and the Stop button renders. The stub's
    // "partial reply " chunk triggers this within a second; its
    // `waitForCancel` step keeps the Stop button on screen until we
    // click it.
    await expect(chatPane.stopButton).toBeVisible();
    // "partial reply" is the agent's streamed text (an ACP
    // `agent_message_chunk`), so scope to the assistant role. The page object's
    // `assistantMessage`/`userMessage` locators are role-scoped on
    // `chat-pane__assistant-message` / `chat-pane__user-message` —
    // a future rendering change that places user text inside an
    // assistant bubble (or vice versa) trips this locator instead
    // of silently passing.
    await expect(chatPane.assistantMessage("partial reply")).toBeVisible();
    // While streaming, the inline thinking indicator IS rendered (the
    // trailing-assistant indicator's condition + the inline
    // `showThinking` branch both fire). We don't assert its absence
    // here — the Stop button visibility is the unambiguous signal.

    // Click Stop. The hook's `cancel()` fires `tasks.abort`; the server
    // sends `session/cancel`, the stub ends the turn with stopReason
    // `cancelled`, and the stream's `turn-ended` flips the reducer to
    // idle, so the Stop button and the thinking indicator unmount.
    await chatPane.clickStop();

    // Positive anchor: the prompt becomes interactive again once
    // status leaves "streaming". Asserting this BEFORE the two
    // not-toBeVisible() calls below proves the cancel reached
    // a settled state — without the anchor the negatives could
    // pass vacuously against a still-mid-transition UI.
    await expect(chatPane.promptInput).toBeEnabled();
    // The cancelled turn ends with an info-level "stopped" notice.
    await expect(chatPane.notices).toHaveAttribute("data-level", "info");
    await expect(chatPane.stopButton).not.toBeVisible();
    await expect(chatPane.thinkingIndicator).not.toBeVisible();
    // The partial text the agent had already streamed remains in the
    // conversation — cancelling preserves what was rendered, doesn't
    // wipe it.
    await expect(chatPane.assistantMessage("partial reply")).toBeVisible();
  });
});
