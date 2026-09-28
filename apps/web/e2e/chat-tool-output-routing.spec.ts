/**
 * End-to-end coverage for issue #509, carried over to ACP (issue #648): a
 * tool call's later status update must land on the tool card that owns the
 * matching `toolCallId`, NOT on whatever message is "current" when the
 * update arrives, and not as a second card.
 *
 * The original bug dropped tool results that arrived after the turn's
 * completion event, leaving the card stuck in progress with its orange
 * status dot pulsing forever (the renderer-CPU regression tracked in #508
 * was downstream of that leak). Over ACP the same shape is a
 * `tool_call_update` that arrives in a LATER turn than its `tool_call`.
 * `transcriptReducer` routes it by `toolCallId` across the whole
 * transcript.
 *
 * Architecture:
 *
 *   - REAL `dist/start-server.mjs` against a fresh `mkdtempSync()` home.
 *   - NO tRPC mocking. The chat events stream is the production SSE path.
 *   - The ACP stub agent (`apps/web/tests/fixtures/acp-stub-agent.mjs`,
 *     the only allowed mock) scripts two turns: the first completes one
 *     tool call and leaves a second in progress when the turn ends; the
 *     second turn completes that second call.
 *   - UI driven through `ChatPanePage` + the `tool-call__container` /
 *     `tool-call__status-dot` test IDs on `ToolCall` / `StatusDot`.
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

const TOKEN = "e2e-tool-output-routing-token";
const PROJECT = "toolrouting";
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

  // Turn 1: tool call 1 runs start to finish (the happy path). Tool call
  // 2 starts and is still in progress when the turn ends. Turn 2: the
  // agent reports tool call 2 as completed. That update crosses a turn
  // boundary, which is the case the original bug dropped.
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [
        {
          match: "run the tools",
          steps: [
            {
              tool: {
                toolCallId: "tc-bash-1",
                title: "ls",
                kind: "execute",
                status: "in_progress",
                rawInput: { command: "ls" },
              },
            },
            {
              toolUpdate: {
                toolCallId: "tc-bash-1",
                status: "completed",
                content: [{ type: "content", content: { type: "text", text: "file1\nfile2" } }],
              },
            },
            {
              tool: {
                toolCallId: "tc-read-1",
                title: "Read README.md",
                kind: "read",
                status: "in_progress",
                rawInput: { path: "README.md" },
              },
            },
            { say: "Reading the README." },
          ],
        },
        {
          match: "keep going",
          steps: [
            {
              toolUpdate: {
                toolCallId: "tc-read-1",
                status: "completed",
                content: [{ type: "content", content: { type: "text", text: "# Project" } }],
              },
            },
            { say: "Read it." },
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

test.describe("chat tool-output routing — issue #509 regression", () => {
  test("a tool call's completion from a later turn lands on its original card", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(WORKSPACE);
    await chatPane.waitForReady();

    await chatPane.typeMessage("run the tools");
    await chatPane.submit();

    // Turn 1 ended with tool call 2 still running. We assert the
    // `data-status` attribute rather than the Tailwind class: status is
    // the user-observable signal; classes are an implementation detail.
    await expect(chatPane.assistantMessage("Reading the README.")).toBeVisible();
    await expect(chatPane.toolCallContainers).toHaveCount(2);
    await expect(chatPane.toolCallContainers.nth(0)).toHaveAttribute("data-status", "complete");
    await expect(chatPane.toolCallContainers.nth(1)).toHaveAttribute("data-status", "in-progress");

    // Turn 2 completes tool call 2.
    await chatPane.typeMessage("keep going");
    await chatPane.submit();
    await expect(chatPane.assistantMessage("Read it.")).toBeVisible();

    // The update landed on the existing card: still two cards, both
    // complete, none lingering in progress.
    await expect(chatPane.toolCallContainers).toHaveCount(2);
    await expect(chatPane.toolCallContainers.nth(0)).toHaveAttribute("data-status", "complete");
    await expect(chatPane.toolCallContainers.nth(1)).toHaveAttribute("data-status", "complete");

    // Status dots must mirror the container status. Pinning both surfaces
    // guards against a regression that updates one and forgets the other.
    await expect(chatPane.toolCallStatusDots).toHaveCount(2);
    await expect(chatPane.toolCallStatusDots.nth(0)).toHaveAttribute("data-status", "complete");
    await expect(chatPane.toolCallStatusDots.nth(1)).toHaveAttribute("data-status", "complete");
  });
});
