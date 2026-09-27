/**
 * The chat composer's model settings menu and the new-chat agent picker.
 *
 *   - Model, effort and fast mode sit behind one trigger on the right of the
 *     composer. The trigger reads "<model> <effort>". Changing effort or fast
 *     mode sends `session/set_config_option` on the live session, and another
 *     model comes from the "More models" submenu.
 *   - Before the first message the chat has no session. Changing a setting
 *     then starts one, because only the agent keeps effort and fast mode.
 *   - The menu never offers other coding agents: a session belongs to the
 *     agent that started it.
 *   - The agent is picked when a chat is created, from the "New Chat"
 *     submenu of the tab bar's "+" menu.
 *
 * Real server, no tRPC mocking. The ACP stub agent is the only stub. Its
 * default reply names the session's model (`Heard "<prompt>" on <model>.`),
 * and its request log shows what Band sent. Codex is seeded with
 * `model: "stub-large"`, so a chat that runs on the Codex definition answers
 * "on stub-large" while the default Claude Code chat answers "on stub-small".
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { acpStubEnv, stubRequests } from "./helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChatPanePage } from "./pages/ChatPanePage";

const TOKEN = "e2e-chat-model-picker-token";
const PROJECTS = ["pickersettings", "pickerfresh", "pickeragent"] as const;

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const projects = PROJECTS.map((name) => {
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
    codingAgents: [
      { id: "codex", type: "codex", label: "Codex", model: "stub-large" },
      { id: "claude-code", type: "claude-code", label: "Claude Code" },
    ],
  });

  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      options: {
        extra: [
          {
            id: "effort",
            name: "Effort",
            category: "thought_level",
            options: [
              { value: "low", name: "Low" },
              { value: "high", name: "High" },
            ],
          },
          {
            id: "fast",
            name: "Fast mode",
            category: "model_config",
            options: [
              { value: "off", name: "Off" },
              { value: "on", name: "On" },
            ],
          },
        ],
      },
    }),
  });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Chat model settings menu", () => {
  test("groups model, effort and fast mode, and changes them on the live session", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("pickersettings", "main"));
    await chatPane.waitForReady();

    await chatPane.typeMessage("first");
    await chatPane.submit();
    await expect(chatPane.assistantMessage('Heard "first" on stub-small.')).toBeVisible();

    // One trigger: model name plus effort.
    await expect(chatPane.modelMenuButton).toContainText("Stub Small");
    await expect(chatPane.modelMenuEffort).toHaveText("Low");
    const sessionId = (
      stubRequests(tmpHome, "session/prompt").at(-1)?.params as {
        sessionId: string;
      }
    ).sessionId;
    const optionsBefore = stubRequests(tmpHome, "session/set_config_option").length;

    await chatPane.openModelMenu();
    await expect(chatPane.effortSubmenu).toContainText("Low");
    await expect(chatPane.fastModeSwitch).toHaveAttribute("data-state", "unchecked");
    await expect(chatPane.moreModelsSubmenu).toBeVisible();
    // No way to switch to another coding agent from inside the session.
    await expect(chatPane.modelMenuAgentOption("Codex")).toHaveCount(0);

    await chatPane.selectEffort("High");
    await expect(chatPane.modelMenuEffort).toHaveText("High");

    await chatPane.openModelMenu();
    await chatPane.toggleFastMode();
    await expect(chatPane.fastModeSwitch).toHaveAttribute("data-state", "checked");
    await chatPane.closeMenu();

    await chatPane.selectModel("Stub Large");
    await expect(chatPane.modelMenuButton).toContainText("Stub Large");

    await chatPane.typeMessage("second");
    await chatPane.submit();
    await expect(chatPane.assistantMessage('Heard "second" on stub-large.')).toBeVisible();

    const setOption = stubRequests(tmpHome, "session/set_config_option")
      .slice(optionsBefore)
      .map((r) => r.params);
    expect(setOption).toEqual([
      { sessionId, configId: "effort", value: "high" },
      { sessionId, configId: "fast", value: "on" },
      { sessionId, configId: "model", value: "stub-large" },
    ]);
  });

  test("changing effort and fast mode in a new session before its first message starts it and applies them", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("pickerfresh", "main"));
    await chatPane.waitForReady();

    // One turn so the agent's options are known, then "New session": the
    // chat has no session until something needs one.
    await chatPane.typeMessage("warm up");
    await chatPane.submit();
    await expect(chatPane.assistantMessage('Heard "warm up" on stub-small.')).toBeVisible();
    await chatPane.openSessionHistory();
    await chatPane.clickNewSession();
    await expect(chatPane.emptyConversation).toBeVisible();
    const sessionsBefore = stubRequests(tmpHome, "session/new").length;
    const optionsBefore = stubRequests(tmpHome, "session/set_config_option").length;

    await chatPane.openModelMenu();
    await chatPane.selectEffort("High");
    await expect(chatPane.modelMenuEffort).toHaveText("High");
    await chatPane.openModelMenu();
    await chatPane.toggleFastMode();
    await expect(chatPane.fastModeSwitch).toHaveAttribute("data-state", "checked");
    await chatPane.closeMenu();

    // The first change started a session and both changes reached it.
    await expect.poll(() => stubRequests(tmpHome, "session/new").length).toBe(sessionsBefore + 1);
    const setOption = stubRequests(tmpHome, "session/set_config_option")
      .slice(optionsBefore)
      .map((r) => r.params);
    expect(setOption).toHaveLength(2);
    const sessionId = (setOption[0] as { sessionId: string }).sessionId;
    expect(setOption).toEqual([
      { sessionId, configId: "effort", value: "high" },
      { sessionId, configId: "fast", value: "on" },
    ]);

    // The first message runs in that session.
    await chatPane.typeMessage("go");
    await chatPane.submit();
    await expect(chatPane.assistantMessage('Heard "go" on stub-small.')).toBeVisible();
    const prompts = stubRequests(tmpHome, "session/prompt").map(
      (r) => (r.params as { sessionId: string }).sessionId,
    );
    expect(prompts.at(-1)).toBe(sessionId);
  });
});

test.describe("New chat agent picker", () => {
  test("the New Chat submenu lists the agents, default first, and starts the chat on the picked one", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("pickeragent", "main"));

    await chatPane.openNewTabMenu();
    await chatPane.openNewChatAgentMenu();
    await expect(chatPane.newChatAgentItems).toHaveCount(2);
    await expect(chatPane.newChatAgentItems.nth(0)).toContainText("Claude Code");
    await expect(chatPane.newChatAgentItems.nth(1)).toContainText("Codex");

    await chatPane.startChatWithAgent("codex");

    await chatPane.typeMessage("hello");
    await chatPane.submit();
    // The Codex definition's model: the chat runs on the picked agent.
    await expect(chatPane.assistantMessage('Heard "hello" on stub-large.')).toBeVisible();
  });
});
