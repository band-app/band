/**
 * Regression: the chat "Thinking…" indicator spinning forever after the
 * agent has finished, until a full page reload.
 *
 * Failure mechanism (see the reducer's `subscription-opened` case):
 *   1. A task is running → the client reducer holds `taskRunning: true`,
 *      status `streaming`, so the thinking indicator + Stop button render.
 *   2. The `task-completed` broadcast is LIVE-ONLY — never written to the
 *      JSONL transcript and evicted from the in-memory session buffer on
 *      server restart (or past MAX_BUFFER_SIZE). So if the completion fires
 *      while the client is detached — or the server restarts mid-task — the
 *      client never receives it.
 *   3. On reconnect the server's `subscription-opened` correctly reports
 *      `taskRunning: false`, but the pre-fix reducer only ever upgraded
 *      false→true. The client kept `taskRunning: true` → status stayed
 *      `streaming` → the indicator spun forever.
 *
 * This test reproduces (2)+(3) deterministically by RESTARTING the real
 * server on the same port while a task is mid-stream: the restart wipes the
 * in-memory buffer (so the completion is genuinely lost) and the client's
 * `EventSource` auto-reconnects to the same URL and receives a fresh
 * `subscription-opened{taskRunning:false}`.
 *
 * Under the fix the reducer trusts that authoritative `false` (no optimistic
 * send is pending) and settles status to a terminal state — clearing the
 * indicator and the Stop button and returning the composer to the send
 * state. On the buggy code this test times out waiting for the indicator to
 * disappear.
 *
 * Architecture (matches `chat-cancel.spec.ts`):
 *   - REAL `dist/start-server.mjs` against a fresh `mkdtempSync()` home,
 *     pinned to a fixed port so the restart rebinds the same address.
 *   - NO tRPC mocking, no `page.route()` on our own routes.
 *   - The stdio fake-agent (`apps/web/tests/fake-agent.mjs`) replays a
 *     scenario: emit a `text-delta` immediately (→ status `streaming`,
 *     indicator + Stop visible), then sleep 30 s so the task is still
 *     "running" when we kill the server.
 *   - UI driven through `ChatPanePage`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { fakeAgentPath } from "./helpers/fake-agent";
import {
  cleanupTmpHome,
  createTmpHome,
  getRandomPort,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChatPanePage } from "./pages/ChatPanePage";

const TOKEN = "e2e-chat-reconnect-token";
const PROJECT = "reconnectproj";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

test.use({ viewport: { width: 1280, height: 800 } });

const FAKE_AGENT_PATH = fakeAgentPath();

let server: ServerHandle;
let tmpHome: string;
let scenarioPath: string;
let port: number;

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

  // Emit a short text-delta IMMEDIATELY so the client flips to
  // status="streaming" (indicator + Stop button render), then sleep 30 s.
  // The task is still "running" server-side when we kill it — the restart
  // is what models the lost completion.
  scenarioPath = join(tmpHome, "scenario.json");
  writeFileSync(
    scenarioPath,
    JSON.stringify([
      { type: "system", subtype: "init", session_id: "reconnect-session" },
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
        session_id: "reconnect-session",
        duration_ms: 30_000,
        num_turns: 1,
        total_cost_usd: 0.0,
      },
    ]),
  );

  // Pin the port so the post-restart server rebinds the same address and
  // the client's EventSource reconnects to it.
  port = await getRandomPort();
  server = await startServer({ tmpHome, port, env: { FAKE_AGENT_SCENARIO: scenarioPath } });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Chat reconnect — stuck thinking indicator recovers", () => {
  test("a lost task-completed (server restart mid-task) clears the indicator on reconnect", async ({
    page,
  }) => {
    // The restart + reconnect + a second streaming task can exceed the
    // default 30 s test budget.
    test.setTimeout(90_000);

    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(WORKSPACE);
    await chatPane.waitForReady();

    await chatPane.typeMessage("work for me");
    await chatPane.submit();

    // Streaming phase: the agent streamed "partial reply " then went to
    // sleep, so status === "streaming" — the Stop button and the thinking
    // indicator are both on screen.
    await expect(chatPane.stopButton).toBeVisible({ timeout: 15_000 });
    await expect(chatPane.assistantMessage("partial reply")).toBeVisible();
    await expect(chatPane.thinkingIndicator).toBeVisible();

    // Restart the real server on the SAME port. This wipes the in-memory
    // session buffer (and kills the mid-sleep fake-agent), so the eventual
    // task-completed is gone for good — the client never sees it. The
    // EventSource auto-reconnects and gets subscription-opened{taskRunning:false}.
    await server.close();
    try {
      server = await startServer({ tmpHome, port, env: { FAKE_AGENT_SCENARIO: scenarioPath } });
    } catch (err) {
      // If the re-bind fails (e.g. the OS hasn't released the port yet),
      // `server` would otherwise still hold the already-closed `beforeAll`
      // handle. `afterAll` would then call `close()` on a child that has
      // already exited and await an `exit` event that never re-fires —
      // hanging teardown (TEST-14). Swap in a no-op handle so teardown
      // always resolves promptly, then fail the test.
      server = { url: "", home: tmpHome, close: () => Promise.resolve() };
      throw err;
    }

    // Positive anchor (TEST-25): assert the alternate post-reconnect state
    // rendered BEFORE the negatives. The conversation DOM survives the
    // restart — the partial text the agent streamed is preserved in the
    // reducer (React state outlives the EventSource reconnect) — so this
    // proves the pane re-rendered rather than blanked.
    await expect(chatPane.assistantMessage("partial reply")).toBeVisible();
    // The fix: with no optimistic send pending, the reducer trusts the
    // authoritative taskRunning:false and settles status to a terminal
    // state. The indicator and the Stop button disappear. On the buggy
    // reducer (`state.taskRunning || event.taskRunning`) they never would,
    // and these auto-retrying polls would time out.
    await expect(chatPane.thinkingIndicator).not.toBeVisible({ timeout: 30_000 });
    // Explicit 30 s timeout (not the 5 s config default): the Stop button
    // clears from the same reducer transition as the indicator, but under
    // slow CI it could lag the indicator's poll and spuriously time out.
    await expect(chatPane.stopButton).not.toBeVisible({ timeout: 30_000 });

    // Positive anchor (TEST-25): the composer is genuinely back in the send
    // state, not transiently flickering. A brand-new submission is accepted
    // and starts a fresh task. Two observable proofs that the task was SENT
    // (not queued):
    //   - The "second message" user bubble appears. `send()` only dispatches
    //     the optimistic user bubble when the message is sent immediately; if
    //     `taskRunning` were still stuck true (the bug), the message would be
    //     QUEUED instead — it would land in the queue list, not as a
    //     `chat-pane__user-message` bubble.
    //   - The thinking indicator returns: the optimistic `task-started` flips
    //     status back to `submitting` (a streaming-equivalent), so the
    //     standalone indicator re-renders for the new trailing user message.
    await chatPane.typeMessage("second message");
    await chatPane.submit();
    await expect(chatPane.userMessage("second message")).toBeVisible({ timeout: 15_000 });
    await expect(chatPane.thinkingIndicator).toBeVisible({ timeout: 15_000 });
  });
});
