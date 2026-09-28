/**
 * The agent's plan renders as the pinned TaskListWidget.
 *
 * Over the Agent Client Protocol (issue #648) an agent reports its todo
 * list as a `plan` session update carrying the whole list (Claude Code's
 * TodoWrite arrives this way through its ACP adapter). The server logs the
 * update, the chat event stream forwards it, `transcriptReducer` keeps the
 * latest plan, and `ChatView` pins the `TaskListWidget` above the prompt.
 *
 * What's covered:
 *
 *   - A `plan` update renders the dedicated widget with every entry, and
 *     does not render as a generic tool-call card. The assistant's text in
 *     the same turn still renders.
 *   - A later `plan` update replaces the list, and a plan whose entries are
 *     all completed hides the widget.
 *
 * Real server, no tRPC mocking; the ACP stub agent
 * (`apps/web/tests/fixtures/acp-stub-agent.mjs`) is the only stub.
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

const TOKEN = "e2e-todo-widget-token";
const PROJECT = "todoproj";
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
    defaultCodingAgent: "claude-code",
    codingAgents: [
      {
        id: "claude-code",
        type: "claude-code",
        label: "Claude Code",
      },
    ],
  });

  // Turn 1 reports a three-entry plan (one completed, one in progress, one
  // pending) and then a short text reply. Turn 2 reports the same plan with
  // every entry completed.
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [
        {
          match: "Plan the work",
          steps: [
            {
              update: {
                sessionUpdate: "plan",
                entries: [
                  { content: "Setup project", priority: "high", status: "completed" },
                  { content: "Write tests", priority: "medium", status: "in_progress" },
                  { content: "Deploy to prod", priority: "low", status: "pending" },
                ],
              },
            },
            { say: "Here is your todo list." },
          ],
        },
        {
          match: "Finish up",
          steps: [
            {
              update: {
                sessionUpdate: "plan",
                entries: [
                  { content: "Setup project", priority: "high", status: "completed" },
                  { content: "Write tests", priority: "medium", status: "completed" },
                  { content: "Deploy to prod", priority: "low", status: "completed" },
                ],
              },
            },
            { say: "All done." },
          ],
        },
      ],
    }),
  });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Agent plan renders as the TaskListWidget", () => {
  test("a plan update surfaces the dedicated widget, and a fully completed plan hides it", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(WORKSPACE);
    await chatPane.waitForReady();

    await chatPane.typeMessage("Plan the work");
    await chatPane.submit();

    // The widget is located by its BEM testid, not by the English "Todos".
    await expect(chatPane.taskListWidget).toBeVisible();
    // Every entry renders, the completed one included (the widget only
    // hides once *every* entry is completed).
    await expect(chatPane.taskListWidget).toContainText("Setup project");
    await expect(chatPane.taskListWidget).toContainText("Write tests");
    await expect(chatPane.taskListWidget).toContainText("Deploy to prod");

    // The assistant's text in the same turn still renders; the widget is
    // supplementary, not a replacement for the assistant bubble.
    await expect(chatPane.assistantMessage("Here is your todo list.")).toBeVisible();
    // A plan is not a tool call, so no generic tool-call card appears.
    await expect(chatPane.toolCallContainers).toHaveCount(0);

    // A later plan update replaces the whole list. With every entry
    // completed the widget hides. Positive anchor first: the turn's reply.
    await chatPane.typeMessage("Finish up");
    await chatPane.submit();
    await expect(chatPane.assistantMessage("All done.")).toBeVisible();
    await expect(chatPane.taskListWidget).toHaveCount(0);
  });
});
