/**
 * OpenCode's model picker, grouped by provider.
 *
 * OpenCode offers every configured provider's models in one flat list, ids
 * `<providerId>/<modelId>` and names "<provider>/<model>". In an OpenCode
 * chat, "More models" lists the providers, and each opens a submenu of its
 * own models named without the provider. The composer trigger and the
 * selected row show the model name alone. The selected model and its
 * provider carry a check. Other agents keep the flat list with full names.
 *
 * Real server, no tRPC mocking. The ACP stub agent is the only stub; it
 * advertises MODELS and answers `Heard "<prompt>" on <model id>.`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorkspaceId } from "@/dashboard";
import { acpStubEnv } from "./helpers/acp-stub";
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

const TOKEN = "e2e-chat-opencode-model-providers-token";
const PROJECTS = ["providersopencode", "providersclaude"] as const;
const MODELS = [
  { value: "opencode/big-pickle", name: "OpenCode Zen/Big Pickle" },
  {
    value: "opencode/nemotron-3.5-lightning-free",
    name: "OpenCode Zen/Nemotron 3.5 Lightning Free",
  },
  { value: "epic/claude-fable-5-1", name: "Epic Portkey/Claude Fable 5.1" },
  // The model id has a slash of its own; the provider is still `lmstudio`.
  { value: "lmstudio/qwen/qwen3-coder-30b", name: "LM Studio (local)/Qwen3 Coder 30B" },
  {
    value: "mtplx/mtplx-qwen38-27b-optimized-speed",
    name: "MTPLX (local)/MTPLX mtplx-qwen38-27b-optimized-speed",
  },
];

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
    defaultCodingAgent: "opencode",
    codingAgents: [
      { id: "opencode", type: "opencode", label: "OpenCode" },
      { id: "claude-code", type: "claude-code", label: "Claude Code" },
    ],
  });
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, { options: { models: MODELS } }),
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("OpenCode model picker", () => {
  test("groups More models by provider and shows model names without the provider", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("providersopencode", "main"));
    await chatPane.waitForReady();

    await chatPane.typeMessage("first");
    await chatPane.submit();
    await expect(chatPane.assistantMessage('Heard "first" on opencode/big-pickle.')).toBeVisible();
    await expect(chatPane.modelMenuModel).toHaveText("Big Pickle");

    await chatPane.openModelMenu();
    await expect(chatPane.selectedModelItem).toHaveText("Big Pickle");

    // Providers in the order OpenCode lists them; the selected model's
    // provider is checked.
    await chatPane.openMoreModels();
    await expect(chatPane.moreModelsRows).toHaveText([
      "OpenCode Zen",
      "Epic Portkey",
      "LM Studio (local)",
      "MTPLX (local)",
    ]);
    await expect(chatPane.selectedCheck(chatPane.providerSubmenu("opencode"))).toBeVisible();
    await expect(chatPane.selectedCheck(chatPane.providerSubmenu("lmstudio"))).toHaveCount(0);

    // A provider's submenu lists its models by name, the selected one checked.
    await chatPane.openProvider("opencode");
    const pickle = chatPane.providerModelOption("opencode", "Big Pickle");
    const nemotron = chatPane.providerModelOption("opencode", "Nemotron 3.5 Lightning Free");
    await expect(pickle).toBeVisible();
    await expect(nemotron).toBeVisible();
    await expect(chatPane.selectedCheck(pickle)).toBeVisible();
    await expect(chatPane.selectedCheck(nemotron)).toHaveCount(0);

    await chatPane.openProvider("lmstudio");
    await chatPane.clickProviderModel("lmstudio", "Qwen3 Coder 30B");
    await expect(chatPane.modelMenuModel).toHaveText("Qwen3 Coder 30B");

    await chatPane.typeMessage("second");
    await chatPane.submit();
    await expect(
      chatPane.assistantMessage('Heard "second" on lmstudio/qwen/qwen3-coder-30b.'),
    ).toBeVisible();

    // The check moves with the selection.
    await chatPane.openModelMenu();
    await expect(chatPane.selectedModelItem).toHaveText("Qwen3 Coder 30B");
    await chatPane.openMoreModels();
    await expect(chatPane.selectedCheck(chatPane.providerSubmenu("lmstudio"))).toBeVisible();
    await expect(chatPane.selectedCheck(chatPane.providerSubmenu("opencode"))).toHaveCount(0);
    await chatPane.openProvider("lmstudio");
    await expect(
      chatPane.selectedCheck(chatPane.providerModelOption("lmstudio", "Qwen3 Coder 30B")),
    ).toBeVisible();
  });
});

test.describe("Other agents' model picker", () => {
  test("keeps the flat More models list with full model names", async ({ page }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(toWorkspaceId("providersclaude", "main"));
    await chatPane.openNewTabMenu();
    await chatPane.openNewChatAgentMenu();
    await chatPane.startChatWithAgent("claude-code");

    await chatPane.typeMessage("first");
    await chatPane.submit();
    await expect(chatPane.assistantMessage('Heard "first" on opencode/big-pickle.')).toBeVisible();
    await expect(chatPane.modelMenuModel).toHaveText("OpenCode Zen/Big Pickle");

    await chatPane.openModelMenu();
    await expect(chatPane.selectedModelItem).toHaveText("OpenCode Zen/Big Pickle");
    await chatPane.openMoreModels();
    await expect(chatPane.moreModelsRows).toHaveText(MODELS.slice(1).map((m) => m.name));
  });
});
