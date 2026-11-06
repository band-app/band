/**
 * A mermaid diagram in an agent's chat message follows the light/dark mode,
 * and switching the mode in Settings > Appearance re-renders the open chat's
 * diagram without a reload (both directions).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
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
import { AppearancePage } from "./pages/AppearancePage";
import { ChatPanePage } from "./pages/ChatPanePage";

const TOKEN = "e2e-chat-mermaid-theme-token";
const REPO = "chat-mermaid-repo";
const REPLY =
  "Here:\n\n```mermaid\nsequenceDiagram\n  Alice->>Bob: Hello Bob\n  Bob-->>Alice: Hi Alice\n```\n";

test.use({ viewport: { width: 1280, height: 900 } });
test.setTimeout(90_000);

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const dir = join(tmpHome, REPO);
  mkdirSync(dir, { recursive: true });
  seedState(tmpHome, {
    repos: [
      { name: REPO, path: dir, defaultBranch: "main", worktrees: [{ branch: "main", path: dir }] },
    ],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    theme: "dark",
    useWebGLTerminalRenderer: false,
    defaultCodingAgent: "claude-code",
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Stub" }],
  });
  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [{ match: "^diagram", steps: [{ say: REPLY }] }],
    }),
  });
});

test.afterAll(async () => {
  await server.close();
  cleanupTmpHome(tmpHome);
});

test("a chat diagram is dark in dark mode and re-renders when the mode switches", async ({
  page,
}) => {
  resetClientState(tmpHome);
  const chat = new ChatPanePage(page, server.url, TOKEN);
  const appearance = new AppearancePage(page, server.url, TOKEN);
  await chat.goto(toWorktreeId(REPO, "main", "local"));
  await chat.waitForReady();
  await chat.typeMessage("diagram please");
  await chat.submit();
  await expect.poll(() => chat.mermaidTextBrightness()).toBeGreaterThan(160);

  await appearance.settings.openDialog("appearance");
  await appearance.chooseMode("light");
  await page.keyboard.press("Escape");
  await expect.poll(() => chat.mermaidTextBrightness()).toBeLessThan(100);

  await appearance.settings.openDialog("appearance");
  await appearance.chooseMode("dark");
  await page.keyboard.press("Escape");
  await expect.poll(() => chat.mermaidTextBrightness()).toBeGreaterThan(160);
});
