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
 * Real server, no tRPC mocking. The ACP stub agent is the only stub; it
 * advertises MODEL_COUNT models with long names.
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

const TOKEN = "e2e-chat-model-submenu-overflow-token";
const PROJECTS = ["submenudesktop", "submenumobile"] as const;
const MODEL_COUNT = 40;
const MODELS = Array.from({ length: MODEL_COUNT }, (_, i) => ({
  value: `stub-model-${i + 1}`,
  name: `Stub Provider/Stub Model ${String(i + 1).padStart(2, "0")} Long Name`,
}));
const LAST_MODEL = MODELS[MODEL_COUNT - 1].name;

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
  seedSettings(tmpHome, { tokenSecret: TOKEN, defaultCodingAgent: "claude-code" });
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

async function expectEveryModelReachable(
  chatPane: ChatPanePage,
  viewport: { width: number; height: number },
): Promise<void> {
  await chatPane.typeMessage("first");
  await chatPane.submit();
  await expect(chatPane.assistantMessage(`Heard "first" on ${MODELS[0].value}.`)).toBeVisible();

  await chatPane.openModelMenu();
  const menu = await chatPane.readBox(chatPane.modelMenuContent);
  expect(menu.top).toBeGreaterThanOrEqual(0);
  expect(menu.bottom).toBeLessThanOrEqual(viewport.height);
  expect(menu.left).toBeGreaterThanOrEqual(0);
  expect(menu.right).toBeLessThanOrEqual(viewport.width);

  await chatPane.openMoreModels();
  await expect(chatPane.moreModelsOption(MODELS[1].name)).toBeInViewport();
  const submenu = await chatPane.readBox(chatPane.moreModelsContent);
  expect(submenu.top).toBeGreaterThanOrEqual(0);
  expect(submenu.bottom).toBeLessThanOrEqual(viewport.height);
  expect(submenu.left).toBeGreaterThanOrEqual(0);
  expect(submenu.right).toBeLessThanOrEqual(viewport.width);

  // Keyboard: End focuses the last model and scrolls it fully into view.
  const last = chatPane.moreModelsOption(LAST_MODEL);
  await chatPane.focusLastMoreModel();
  await expect(last).toBeFocused();
  await expect(last).toBeInViewport({ ratio: 1 });

  // Pointer: from the top of the list, the last model can be scrolled to
  // and clicked.
  await chatPane.scrollMoreModelsToTop();
  await expect(chatPane.moreModelsOption(MODELS[1].name)).toBeInViewport();
  await chatPane.scrollToMoreModel(LAST_MODEL);
  await expect(last).toBeInViewport({ ratio: 1 });
  await chatPane.clickMoreModel(LAST_MODEL);
  await expect(chatPane.modelMenuButton).toContainText(LAST_MODEL);

  await chatPane.typeMessage("second");
  await chatPane.submit();
  await expect(
    chatPane.assistantMessage(`Heard "second" on ${MODELS[MODEL_COUNT - 1].value}.`),
  ).toBeVisible();
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
