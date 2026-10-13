/**
 * Menus on a phone. A submenu opens as a drill-in (the menu's content is
 * replaced by the submenu's items under a "Back" row) instead of Radix's
 * fly-out, which on a phone landed off-screen or under the composer's send
 * button and swallowed the tap on "More models". Every step is one touch tap.
 *
 * Real server, no tRPC mocking. The ACP stub agent is the only stub.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { acpStubEnv, stubRequests } from "./helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { ChatPanePage } from "./pages/ChatPanePage";

const TOKEN = "e2e-chat-model-menu-mobile-token";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, "phonemenu");
  mkdirSync(repoDir, { recursive: true });
  seedState(tmpHome, {
    repos: [
      {
        name: "phonemenu",
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
      { id: "claude-code", type: "claude-code", label: "Claude Code" },
      { id: "codex", type: "codex", label: "Codex", model: "stub-large" },
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

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

async function openWarmChat(chatPane: ChatPanePage) {
  await chatPane.goto(toWorktreeId("phonemenu", "main", "local"));
  await chatPane.waitForReady();
  await chatPane.typeMessage("first");
  await chatPane.tapSend();
  await expect(chatPane.assistantMessage('Heard "first" on stub-small.')).toBeVisible();
}

test("one tap on More models drills in, Back returns, and a model selects", async ({
  page,
}, testInfo) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  await openWarmChat(chatPane);

  await chatPane.tapOpenModelMenu();
  await chatPane.tapMoreModels();
  await expect(chatPane.drillBack).toBeVisible();
  // The first-level rows are replaced, not shown beside the submenu.
  await expect(chatPane.fastModeItem).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("more-models-drilled.png") });

  await chatPane.tapBack();
  await expect(chatPane.modelMenuContent).toBeVisible();
  await expect(chatPane.fastModeItem).toBeVisible();
  await expect(chatPane.moreModelsContent).toBeHidden();

  await chatPane.tapMoreModels();
  await chatPane.moreModelsOption("Stub Large").tap();
  await expect(chatPane.modelMenuContent).toBeHidden();
  await expect(chatPane.modelMenuButton).toContainText("Stub Large");
});

test("one tap picks an effort level from its drilled-in submenu", async ({ page }) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  await openWarmChat(chatPane);

  await chatPane.tapOpenModelMenu();
  await chatPane.effortSubmenu.tap();
  await expect(chatPane.drillBack).toBeVisible();
  await chatPane.effortOption("High").tap();
  await expect(chatPane.modelMenuContent).toBeHidden();
  await expect(chatPane.modelMenuEffort).toHaveText("High");
});

test("one tap flips the Fast mode switch and keeps the menu open", async ({ page }) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  await openWarmChat(chatPane);
  const before = stubRequests(tmpHome, "session/set_config_option").length;

  await chatPane.tapOpenModelMenu();
  await chatPane.fastModeItem.tap();
  await expect(chatPane.fastModeSwitch).toHaveAttribute("data-state", "checked");
  await expect(chatPane.modelMenuContent).toBeVisible();
  expect(stubRequests(tmpHome, "session/set_config_option").length).toBe(before + 1);
});

test("the New agent submenu of the + menu drills in and one tap starts the chat", async ({
  page,
}) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  await chatPane.goto(toWorktreeId("phonemenu", "main", "local"));
  await chatPane.waitForReady();

  await page.getByTestId("worktree-center__new-tab-button").filter({ visible: true }).first().tap();
  await page.getByTestId("worktree-center__new-tab--agent").filter({ visible: true }).first().tap();
  await expect(chatPane.drillBack).toBeVisible();
  await expect(chatPane.newChatAgentItems.first()).toBeVisible();
  await chatPane.newChatAgentItems.and(page.getByTestId("worktree-center__new-agent--codex")).tap();
  await expect(chatPane.newChatAgentItems.first()).toBeHidden();
});
