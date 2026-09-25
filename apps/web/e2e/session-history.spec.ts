/**
 * Session-history dropdown against the real server (issue #648).
 *
 * Past sessions come from the agent over the Agent Client Protocol: the
 * dropdown lists them with `session/list`, and picking one attaches the chat
 * to it, which replays it with `session/load` (or reads it back from Band's
 * own event log when Band recorded it). The ACP stub agent
 * (`apps/web/tests/fixtures/acp-stub-agent.mjs`) is the only stub; it keeps
 * its sessions in the test's tmp home, so they survive the agent process.
 *
 * What's covered here:
 *
 *   1. Empty state ("No sessions yet") when the agent has no sessions for
 *      the workspace.
 *   2. After a real message, the session shows up in the dropdown under
 *      its first prompt; "New session" clears the chat to the empty state;
 *      picking the past session brings its messages back.
 *
 * Each test uses its own workspace, because the stub filters `session/list`
 * by working directory, so the tests don't depend on running order.
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

const TOKEN = "e2e-session-history-token";
const EMPTY_PROJECT = "histempty";
const FLOW_PROJECT = "histflow";

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();

  const projects = [EMPTY_PROJECT, FLOW_PROJECT].map((name) => {
    const repoDir = join(tmpHome, name);
    mkdirSync(repoDir, { recursive: true });
    return {
      name,
      path: repoDir,
      defaultBranch: "main",
      worktrees: [{ branch: "main", path: repoDir }],
    };
  });
  seedState(tmpHome, { projects });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    defaultCodingAgent: "claude-code",
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });

  // Fast-completing turn so the session exists before the dropdown opens.
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, { turns: [{ steps: [{ say: "noted" }] }] }),
  });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Session history dropdown", () => {
  test("empty state — opening the dropdown on a fresh workspace shows 'No sessions yet'", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId(EMPTY_PROJECT, "main"));
    await chatPane.waitForReady();

    await chatPane.openSessionHistory();

    // The agent has no sessions for this workspace's directory yet.
    await expect(chatPane.sessionHistoryEmpty).toBeVisible();
  });

  test("a sent message's session is listed, and picking it after 'New session' brings it back", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId(FLOW_PROJECT, "main"));
    await chatPane.waitForReady();

    await chatPane.typeMessage("remember this conversation");
    await chatPane.submit();
    await expect(chatPane.assistantMessage("noted")).toBeVisible();

    // "New session" detaches the chat: the conversation clears.
    await chatPane.openSessionHistory();
    await chatPane.clickNewSession();
    await expect(chatPane.emptyConversation).toBeVisible();
    await expect(chatPane.userMessage("remember this conversation")).toHaveCount(0);

    // The finished session is listed under its first prompt. Picking it
    // re-attaches the chat and its messages come back.
    await chatPane.openSessionHistory();
    await expect(chatPane.sessionHistoryItem("remember this conversation")).toBeVisible();
    await chatPane.selectPastSession("remember this conversation");
    await expect(chatPane.userMessage("remember this conversation")).toBeVisible();
    await expect(chatPane.assistantMessage("noted")).toBeVisible();
  });
});
