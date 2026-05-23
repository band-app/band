/**
 * End-to-end coverage for the Stop button — cancelling an in-flight
 * chat task and asserting the UI clears.
 *
 * The backend cancel path is covered by the vitest integration test
 * `chat-events.test.ts > cancel / abort terminates the in-flight task`
 * (POST /trpc/tasks.abort → task-error event). This Playwright test
 * covers the UI side: while a task is mid-stream and the Stop button
 * is showing, clicking it must:
 *
 *   1. Disappear the Stop button (status leaves "streaming").
 *   2. Disappear the thinking indicator.
 *   3. Leave any partial text rendered (user can see what the agent
 *      managed to say before they cancelled).
 *
 * Architecture follows `docs/frontend-testing.md` + the
 * `write-integration-test` skill:
 *
 *   - REAL `dist/start-server.mjs` against a fresh `mkdtempSync()` home.
 *   - NO tRPC mocking. `tasks.abort` runs for real against the in-memory
 *     task map.
 *   - The fake-agent at `apps/web/tests/fake-agent.mjs` (stdio-protocol
 *     subprocess stub — the only allowed mock) emits a `text-delta`
 *     immediately, then sleeps 30 s. The sleep gives us time to click
 *     Stop while the task is still mid-stream (status === "streaming",
 *     i.e. the Stop button is visible).
 *   - UI driven through `ChatPanePage`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import {
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

const FAKE_AGENT_PATH = join(import.meta.dirname, "..", "tests", "fake-agent.mjs");

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
        command: FAKE_AGENT_PATH,
      },
    ],
  });

  // Scenario: emit a short text-delta IMMEDIATELY so the client flips
  // to status="streaming" and the Stop button renders, then sleep
  // 30 s. That sleep window is what the test cancels into.
  const scenarioPath = join(tmpHome, "scenario.json");
  writeFileSync(
    scenarioPath,
    JSON.stringify([
      { type: "system", subtype: "init", session_id: "cancel-session" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "partial reply " }] },
      },
      { _sleep_ms: 30_000 },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "never observed" }] },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "cancel-session",
        duration_ms: 30_000,
        num_turns: 1,
        total_cost_usd: 0.0,
      },
    ]),
  );

  server = await startServer({
    tmpHome,
    env: { FAKE_AGENT_SCENARIO: scenarioPath },
  });
});

test.afterAll(async () => {
  await server.close();
  rmSync(tmpHome, { recursive: true, force: true });
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
    // status === "streaming" and the Stop button renders. The
    // fake-agent's "partial reply " text-delta triggers this within
    // a second; the subsequent 30 s sleep keeps the Stop button on
    // screen until we click it.
    await expect(chatPane.stopButton).toBeVisible();
    await expect(chatPane.userMessage("partial reply")).toBeVisible();
    // While streaming, the inline thinking indicator IS rendered (the
    // trailing-assistant indicator's condition + the inline
    // `showThinking` branch both fire). We don't assert its absence
    // here — the Stop button visibility is the unambiguous signal.

    // Click Stop. The hook's `cancel()` fires `tasks.abort` on the
    // server; the subscription emits `task-error`; the reducer flips
    // status to "error" → isStreaming = false → the Stop button
    // unmounts and the thinking indicator unmounts.
    await chatPane.clickStop();

    await expect(chatPane.stopButton).not.toBeVisible();
    await expect(chatPane.thinkingIndicator).not.toBeVisible();
    // The partial text the agent had already streamed remains in the
    // conversation — cancelling preserves what was rendered, doesn't
    // wipe it.
    await expect(chatPane.userMessage("partial reply")).toBeVisible();
  });
});
