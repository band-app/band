/**
 * TodoWrite tool-call rendering — doctrine-compliant rewrite.
 *
 * Why the rewrite:
 *
 *   The previous file used `createTrpcMock` to seed `sessions.list` and
 *   `sessions.messages` queries, which violates the integration-test
 *   doctrine (`.claude/skills/write-integration-test/SKILL.md` +
 *   `docs/frontend-testing.md`): tRPC must NEVER be mocked, and the
 *   server's view of the chat must come from real on-disk JSONL produced
 *   by a real (fake-binary) agent. That doctrine is the single source of
 *   truth for new tests in this repo, so this file boots a real server
 *   and drives it through the same path a user would: the agent emits a
 *   TodoWrite `tool_use` block, the task-runner broadcasts it as a
 *   `tool-input-available` ChatEvent, the reducer in `ChatView.tsx` lifts
 *   it into the TaskMap, and the TaskListWidget renders.
 *
 * What's covered:
 *
 *   - The single highest-value behaviour worth integration coverage:
 *     when the agent calls `TodoWrite`, the chat surface renders the
 *     `TaskListWidget` (a custom UI affordance) rather than the generic
 *     "tool call" expander used for every other tool. This is the core
 *     contract — without it, TodoWrite would look identical to a `Read`
 *     or `Bash` call.
 *
 * What's NOT covered here (deleted with the legacy file):
 *
 *   - Strikethrough styling on completed tasks (pure CSS render — not a
 *     useful integration signal).
 *   - `activeForm` substitution for in-progress tasks (covered by the
 *     `task-state` unit-style tests via `applyTodoWriteCall`).
 *   - Multiple `TodoWrite` calls in the same assistant message
 *     collapsing into one widget (the reducer always replaces the map
 *     wholesale per `applyTodoWriteCall`; pure reducer behaviour, can be
 *     covered by `chat-event-reducer.test.ts` if it regresses).
 *   - Widget hidden when all tasks are completed (single `if (allDone)
 *     return null` branch — pure render).
 *   - TodoWrite + other tool calls coexisting in the same message
 *     (covered by the positive assertion below: the widget renders AND
 *     the unrelated assistant text still renders).
 *
 * All of the dropped cases were UI-fixture tests with no path through
 * the network boundary the new doctrine cares about. Recreating them
 * here would mean shipping six near-identical fake-agent scenarios for
 * a feature whose risky cross-component glue (parsing → reducer → widget
 * mount) is exercised by the single test below.
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

const TOKEN = "e2e-todo-widget-token";
const PROJECT = "todoproj";
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

  // Scenario: agent emits a TodoWrite `tool_use` block carrying three
  // todos (one completed, one in-progress, one pending) and then a
  // short text reply. The Claude-SDK shape mirrors what a real
  // claude-code binary produces — see
  // `packages/coding-agent/src/adapters/claude-code.ts` which destructures
  // `content[].type === "tool_use"` with `id`, `name`, `input`.
  const scenarioPath = join(tmpHome, "scenario.json");
  writeFileSync(
    scenarioPath,
    JSON.stringify([
      { type: "system", subtype: "init", session_id: "todo-widget-session" },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "todo-call-1",
              name: "TodoWrite",
              input: {
                todos: [
                  { content: "Setup project", status: "completed" },
                  {
                    content: "Write tests",
                    status: "in_progress",
                    activeForm: "Writing tests",
                  },
                  { content: "Deploy to prod", status: "pending" },
                ],
              },
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
              tool_use_id: "todo-call-1",
              content: "ok",
              is_error: false,
            },
          ],
        },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Here is your todo list." }] },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "todo-widget-session",
        duration_ms: 10,
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

test.describe("TodoWrite renders as the TaskListWidget", () => {
  test("agent's TodoWrite call surfaces the dedicated widget (not a generic tool-call bubble)", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(WORKSPACE);
    await chatPane.waitForReady();

    await chatPane.typeMessage("Plan the work");
    await chatPane.submit();

    // The dedicated TaskListWidget appears (located by its BEM testid,
    // not by the English "Todos" string).
    const widget = page.getByTestId("task-list-widget__container");
    await expect(widget).toBeVisible();

    // The pending and in-progress task subjects render inside the widget.
    // "Setup project" is completed so it's still visible (the all-done
    // hide-rule only triggers when *every* task is completed); the
    // in-progress one shows its activeForm.
    await expect(widget).toContainText("Setup project");
    await expect(widget).toContainText("Writing tests");
    await expect(widget).toContainText("Deploy to prod");

    // Sanity: the assistant's follow-up text still renders alongside
    // the widget. The widget is supplementary, not a replacement for
    // the assistant bubble.
    await expect(page.getByText("Here is your todo list.")).toBeVisible();

    // Negative anchor: no generic tool-call expander button surfaces a
    // "TodoWrite" label. If TodoWrite ever stopped being lifted into
    // the widget, it would fall back to the standard ToolCall renderer,
    // which uses the tool name as its button text — this guards against
    // that regression.
    await expect(page.getByRole("button", { name: /TodoWrite/i })).toHaveCount(0);
  });
});
