/**
 * The chat composer's "More models" submenu in a window too short for it.
 *
 * An agent can offer dozens of models (OpenCode lists every provider's), so
 * the submenu is often taller than the space around the composer. It has to
 * stay inside the viewport and scroll, so every model can be reached with
 * the pointer and with the keyboard. Before the fix the submenu kept its
 * natural height and ran off the bottom of the window, and its last rows
 * could never be seen or clicked. On a phone there is no room beside the
 * main menu, so the submenu also has to narrow to the space it gets instead
 * of hanging off the left edge.
 *
 * The same has to hold under the app zoom (CSS `zoom` on <html>, set with
 * Ctrl+=). Radix reports the room beside the trigger in viewport pixels, and
 * before the fix the zoom scaled that room again: at 130% every submenu came
 * out 30% taller than the window allowed. OpenCode's provider submenus
 * (#717) are checked at that zoom too.
 *
 * Real server, no tRPC mocking. The ACP stub agent is the only stub; it
 * advertises MODELS (long names, one provider with many models and many
 * providers with one) and an effort option.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { acpStubEnv } from "./helpers/acp-stub";
import { expectInsideViewport } from "./helpers/geometry";
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
import { WorkspacePage } from "./pages/WorkspacePage";

const TOKEN = "e2e-chat-model-submenu-overflow-token";
const PROJECTS = ["submenudesktop", "submenumobile", "submenuzoom", "submenuopencode"] as const;
const pad = (n: number) => String(n).padStart(2, "0");
// Thirty models from one provider, then one model from each of twenty more.
// Claude Code lists them flat; OpenCode lists 21 providers under "More
// models", and the first provider's submenu holds 30 models.
const MODELS = [
  ...Array.from({ length: 30 }, (_, i) => ({
    value: `stub/stub-model-${i + 1}`,
    name: `Stub Provider/Stub Model ${pad(i + 1)} Long Name`,
  })),
  ...Array.from({ length: 20 }, (_, i) => ({
    value: `extra-${pad(i + 1)}/model`,
    name: `Extra Provider ${pad(i + 1)}/Extra Model ${pad(i + 1)}`,
  })),
];
const LAST = MODELS[MODELS.length - 1];
const LAST_MODEL = LAST.name;

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
      { id: "claude-code", type: "claude-code", label: "Claude Code" },
      { id: "opencode", type: "opencode", label: "OpenCode" },
    ],
  });
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      options: {
        models: MODELS,
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

async function expectEveryModelReachable(
  chatPane: ChatPanePage,
  viewport: { width: number; height: number },
): Promise<void> {
  await chatPane.typeMessage("first");
  await chatPane.submit();
  await expect(chatPane.assistantMessage(`Heard "first" on ${MODELS[0].value}.`)).toBeVisible();

  await chatPane.openModelMenu();
  await expectInsideViewport(chatPane.modelMenuContent, viewport);

  await chatPane.openMoreModels();
  await expect(chatPane.moreModelsOption(MODELS[1].name)).toBeInViewport();
  await expectInsideViewport(chatPane.moreModelsContent, viewport);

  // Keyboard: End focuses the last model and scrolls it fully into view.
  const last = chatPane.moreModelsOption(LAST_MODEL);
  await chatPane.focusLastMoreModel();
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 1 });

  // Pointer: from the top of the list, the wheel scrolls to the last model
  // and it can be clicked.
  await chatPane.scrollMoreModelsToTop();
  await expect(chatPane.moreModelsOption(MODELS[1].name)).toBeInViewport();
  await expect(last).not.toBeInViewport();
  await chatPane.wheelMoreModelsToEnd();
  await expect(last).toBeInViewport({ ratio: 1 });
  await chatPane.clickMoreModel(LAST_MODEL);
  await expect(chatPane.modelMenuButton).toContainText(LAST_MODEL);

  await chatPane.typeMessage("second");
  await chatPane.submit();
  await expect(chatPane.assistantMessage(`Heard "second" on ${LAST.value}.`)).toBeVisible();

  // The other submenus follow the same rules.
  await chatPane.openModelMenu();
  await chatPane.openEffortSubmenu();
  await expectInsideViewport(chatPane.effortSubmenuContent, viewport);
}

test.describe("More models submenu on a short desktop window", () => {
  const viewport = { width: 1280, height: 360 };
  test.use({ viewport });

  test("stays inside the window and scrolls to its last model", async ({ page }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("submenudesktop", "main"));
    await chatPane.waitForReady();
    await expectEveryModelReachable(chatPane, viewport);
  });
});

test.describe("More models submenu on a phone", () => {
  const viewport = { width: 390, height: 360 };
  test.use({ viewport });

  test("stays inside the screen and scrolls to its last model", async ({ page }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("submenumobile", "main"));
    await chatPane.waitForReady();
    await expectEveryModelReachable(chatPane, viewport);
  });
});

test.describe("Model submenus on a short window at 130% zoom", () => {
  const viewport = { width: 1280, height: 420 };
  test.use({ viewport });

  test("the flat model list stays inside the window and scrolls to its last model", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("submenuzoom", "main"));
    await chatPane.waitForReady();
    await workspacePage.zoomInBy(3);
    await expectEveryModelReachable(chatPane, viewport);
  });

  test("OpenCode's provider submenus stay inside the window and scroll to their last model", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    const workspacePage = new WorkspacePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("submenuopencode", "main"));
    await chatPane.openNewTabMenu();
    await chatPane.openNewChatAgentMenu();
    await chatPane.startChatWithAgent("opencode");
    await workspacePage.zoomInBy(3);

    await chatPane.typeMessage("first");
    await chatPane.submit();
    await expect(chatPane.assistantMessage(`Heard "first" on ${MODELS[0].value}.`)).toBeVisible();

    await chatPane.openModelMenu();
    await expectInsideViewport(chatPane.modelMenuContent, viewport);
    await chatPane.openMoreModels();
    await expectInsideViewport(chatPane.moreModelsContent, viewport);

    // The provider list scrolls to its last provider, whose submenu opens
    // inside the window.
    const lastProvider = chatPane.providerSubmenu("extra-20");
    await chatPane.focusLastMoreModel();
    await expect(lastProvider).toBeFocused();
    await expect(lastProvider).toBeInViewport({ ratio: 1 });
    await chatPane.openProvider("extra-20");
    await expectInsideViewport(chatPane.providerModelsContent("extra-20"), viewport);
    await expect(chatPane.providerModelOption("extra-20", "Extra Model 20")).toBeInViewport({
      ratio: 1,
    });

    // The long provider's submenu reaches its last model by keyboard and by
    // wheel, and the model can be picked.
    await chatPane.scrollMoreModelsToTop();
    await chatPane.openProvider("stub");
    await expectInsideViewport(chatPane.providerModelsContent("stub"), viewport);
    const lastStub = chatPane.providerModelOption("stub", "Stub Model 30 Long Name");
    await chatPane.focusLastProviderModel("stub");
    await expect(lastStub).toBeFocused();
    await expect(lastStub).toBeInViewport({ ratio: 1 });
    await chatPane.scrollProviderModelsToTop("stub");
    await expect(chatPane.providerModelOption("stub", "Stub Model 01 Long Name")).toBeInViewport();
    await expect(lastStub).not.toBeInViewport();
    await chatPane.wheelProviderModelsToEnd("stub");
    await expect(lastStub).toBeInViewport({ ratio: 1 });
    await chatPane.clickProviderModel("stub", "Stub Model 30 Long Name");
    await expect(chatPane.modelMenuModel).toHaveText("Stub Model 30 Long Name");

    await chatPane.typeMessage("second");
    await chatPane.submit();
    await expect(chatPane.assistantMessage('Heard "second" on stub/stub-model-30.')).toBeVisible();
  });
});
