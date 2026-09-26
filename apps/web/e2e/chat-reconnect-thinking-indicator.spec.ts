/**
 * Regression: the chat "Thinking…" indicator spinning forever after the
 * agent has finished, until a full page reload.
 *
 * Failure mechanism (see the reducer's `subscription-opened` case in
 * `components/chat/transcript.ts`):
 *   1. A turn is running → the client reducer holds `taskRunning: true`,
 *      status `streaming`, so the thinking indicator + Stop button render.
 *   2. The turn's `turn-ended` never reaches the client: the server
 *      restarts mid-turn, killing the ACP agent subprocess before the turn
 *      can end, so nothing ever writes a `turn-ended` for it.
 *   3. On reconnect the server's `subscription-opened` correctly reports
 *      `taskRunning: false`. A reducer that only ever upgraded
 *      false→true would keep `taskRunning: true` → status stays
 *      `streaming` → the indicator spins forever.
 *
 * This test reproduces (2)+(3) deterministically by RESTARTING the real
 * server on the same port while a turn is mid-stream. The client's
 * `EventSource` auto-reconnects to the same URL and receives a fresh
 * `subscription-opened{taskRunning:false}`.
 *
 * The reducer trusts that authoritative `false` (no optimistic send is
 * pending) and settles status to a terminal state — clearing the
 * indicator and the Stop button and returning the composer to the send
 * state. On a regressed reducer this test times out waiting for the
 * indicator to disappear.
 *
 * Architecture (matches `chat-cancel.spec.ts`):
 *   - REAL `dist/start-server.mjs` against a fresh `mkdtempSync()` home,
 *     pinned to a fixed port so the restart rebinds the same address.
 *   - NO tRPC mocking, no `page.route()` on our own routes.
 *   - The ACP stub agent (`apps/web/tests/fixtures/acp-stub-agent.mjs`)
 *     streams one message chunk immediately (→ status `streaming`,
 *     indicator + Stop visible), then blocks until cancelled, so the turn
 *     is still running when we kill the server.
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

let server: ServerHandle;
let tmpHome: string;
let stubEnv: Record<string, string>;
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
      },
    ],
  });

  // Stream a short message chunk IMMEDIATELY so the client flips to
  // status="streaming" (indicator + Stop button render), then block. The
  // turn is still running server-side when we kill the server; the
  // restart is what models the lost completion. The post-restart message
  // gets a slow turn so its optimistic indicator stays observable.
  stubEnv = acpStubEnv(tmpHome, {
    turns: [
      { match: "work for me", steps: [{ say: "partial reply " }, { waitForCancel: true }] },
      { steps: [{ sleep: 30_000 }, { say: "never observed" }] },
    ],
  });

  // Pin the port so the post-restart server rebinds the same address and
  // the client's EventSource reconnects to it.
  port = await getRandomPort();
  server = await startServer({ tmpHome, port, env: stubEnv });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Chat reconnect — stuck thinking indicator recovers", () => {
  test("a lost turn-ended (server restart mid-turn) clears the indicator on reconnect", async ({
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

    // Restart the real server on the SAME port. This kills the blocked
    // stub agent mid-turn, so no `turn-ended` ever reaches the client. The
    // EventSource auto-reconnects and gets subscription-opened{taskRunning:false}.
    await server.close();
    try {
      server = await startServer({ tmpHome, port, env: stubEnv });
    } catch (err) {
      // If the re-bind fails (e.g. the OS hasn't released the port yet),
      // `server` would otherwise still hold the already-closed `beforeAll`
      // handle. `afterAll` would then call `close()` on a child that has
      // already exited and await an `exit` event that never re-fires —
      // hanging teardown. Swap in a no-op handle so teardown always
      // resolves promptly, then fail the test.
      server = { url: "", home: tmpHome, close: () => Promise.resolve() };
      throw err;
    }

    // Positive anchor: assert the alternate post-reconnect state rendered
    // BEFORE the negatives below. The conversation DOM survives the
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

    // Positive anchor: the composer is genuinely back in the send
    // state, not transiently flickering. A brand-new submission is accepted
    // and starts a fresh task. Two observable proofs that the task was SENT
    // (not queued):
    //   - The "second message" user bubble appears. `send()` only dispatches
    //     the optimistic user bubble when the message is sent immediately; if
    //     `taskRunning` were still stuck true (the bug), the message would be
    //     QUEUED instead — it would land in the queue list, not as a
    //     `chat-pane__user-message` bubble.
    //   - The thinking indicator returns: the optimistic `local-send` flips
    //     status back to `submitting` (a streaming-equivalent), so the
    //     standalone indicator re-renders for the new trailing user message.
    await chatPane.typeMessage("second message");
    await chatPane.submit();
    await expect(chatPane.userMessage("second message")).toBeVisible({ timeout: 15_000 });
    await expect(chatPane.thinkingIndicator).toBeVisible({ timeout: 15_000 });
  });
});
