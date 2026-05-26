/**
 * End-to-end coverage for issue #509 — `tool-output-available` events must
 * resolve onto the assistant message that owns the matching `toolCallId`,
 * NOT onto whatever message is "current" at the moment the output arrives.
 *
 * The pre-fix reducer in `chat-event-reducer.ts` gated the
 * `tool-output-available` handler on `state.currentAssistantId`, which is
 * reset to `undefined` by `user-message` / `task-started` / `task-completed`
 * / `task-error`. Any tool result that arrived after any of those resets
 * was silently dropped, leaving the part stuck in `input-available` and
 * its orange status dot pulsing forever. The renderer-CPU regression
 * tracked in #508 was downstream of that leak.
 *
 * Architecture follows `docs/frontend-testing.md` + the
 * `write-integration-test` skill (`.claude/skills/write-integration-test/`):
 *
 *   - REAL `dist/start-server.mjs` against a fresh `mkdtempSync()` home.
 *   - NO tRPC mocking. The chat events stream is the production SSE path.
 *   - The fake-agent at `apps/web/tests/fake-agent.mjs` (stdio stub — the
 *     only allowed mock) replays a hand-crafted SDK transcript that
 *     completes a tool call across a `task-completed` boundary.
 *   - UI driven through `ChatPanePage` + the `tool-call__container` /
 *     `tool-call__status-dot` test IDs on `ToolCall` / `StatusDot`.
 *
 * The reducer-level proof lives in `apps/web/tests/chat-event-reducer.test.ts`
 * — those tests pin the exact event sequences that triggered Mode 1 of
 * the bug (output after `user-message`, output after `task-completed`,
 * output for an unknown `toolCallId`). This spec is the end-to-end safety
 * net: it boots the full stack and verifies the rendered tool-call dot
 * lands in the `complete` state with no "unknown toolCallId" console
 * warnings — which together would be the smoke signal for a regression
 * back into the silent-drop behaviour.
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

const TOKEN = "e2e-tool-output-routing-token";
const PROJECT = "toolrouting";
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
    defaultCodingAgent: "claude-code",
    codingAgents: [
      {
        id: "claude-code",
        type: "claude-code",
        label: "Claude Code",
        command: FAKE_AGENT_PATH,
      },
    ],
  });

  // Scenario: a tool call whose `tool_result` is emitted by the agent
  // AFTER the terminal `result` message — i.e. the chat-events stream
  // delivers `task-completed` BEFORE `tool-output-available`. This is
  // exactly Mode 1 of the bug: `task-completed` clears
  // `state.currentAssistantId`, and the pre-fix reducer dropped any
  // tool result that arrived next on the silent `if (!assistantId)
  // return` guard. Under the fix, the result is routed by `toolCallId`
  // and lands on the original assistant message regardless.
  //
  // Both tool calls follow the standard order; the second one is the
  // bug-triggering case. Keeping both in one scenario also exercises
  // the happy path so a regression that only broke the "happy" route
  // would still trip the test.
  const scenarioPath = join(tmpHome, "scenario.json");
  writeFileSync(
    scenarioPath,
    JSON.stringify([
      { type: "system", subtype: "init", session_id: "tool-routing-session" },
      // Tool 1 (happy path): tool_use → tool_result → ... arrive in the
      // expected order before the terminal `result`.
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tc-bash-1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tc-bash-1",
              content: "file1\nfile2",
              is_error: false,
            },
          ],
        },
      },
      // Tool 2 (bug-triggering path): tool_use is broadcast, the
      // terminal `result` event fires next (→ `task-completed` on the
      // chat-events stream), and the `tool_result` arrives only
      // AFTER. The pre-fix reducer would lose this output to the
      // `currentAssistantId === undefined` guard.
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tc-read-1",
              name: "Read",
              input: { path: "README.md" },
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "tool-routing-session",
        duration_ms: 10,
        num_turns: 1,
        total_cost_usd: 0.0,
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tc-read-1",
              content: "# Project",
              is_error: false,
            },
          ],
        },
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

test.describe("chat tool-output routing — issue #509 regression", () => {
  test("every tool call lands in the `complete` state once its output arrives, with no 'unknown toolCallId' console warnings", async ({
    page,
  }) => {
    // Capture every console.warn emitted by the page. Under the fix, a
    // mis-routed `tool-output-available` triggers a loud warning with
    // the unknown `toolCallId`. Asserting on this output is half the
    // regression net for the silent-drop bug — the other half is the
    // `data-status` assertion on the tool-call container.
    const warnings: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "warning") warnings.push(msg.text());
    });

    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(WORKSPACE);
    await chatPane.waitForReady();

    await chatPane.typeMessage("run the tools");
    await chatPane.submit();

    // Both tool calls must render and reach the `complete` state. We
    // poll the `data-status` attribute rather than the Tailwind class —
    // status is the user-observable signal; classes are an
    // implementation detail. Two container instances are expected (the
    // scenario emits two `tool_use` blocks); both must reach
    // `data-status="complete"` and neither may linger in `in-progress`.
    await expect(chatPane.toolCallContainers).toHaveCount(2);
    await expect(chatPane.toolCallContainers.nth(0)).toHaveAttribute("data-status", "complete");
    await expect(chatPane.toolCallContainers.nth(1)).toHaveAttribute("data-status", "complete");

    // Status dots must mirror the container status — pinning both
    // surfaces guards against a regression that updates one and
    // forgets the other.
    await expect(chatPane.toolCallStatusDots).toHaveCount(2);
    await expect(chatPane.toolCallStatusDots.nth(0)).toHaveAttribute("data-status", "complete");
    await expect(chatPane.toolCallStatusDots.nth(1)).toHaveAttribute("data-status", "complete");

    // No spurious `tool-output-available` drops. The fix's
    // console.warn fires only when a tool result has no owning
    // assistant message — which under the new routing should never
    // happen for normally-emitted events.
    const dropped = warnings.filter((w) =>
      w.includes("tool-output-available for unknown toolCallId"),
    );
    expect(dropped).toEqual([]);
  });
});
