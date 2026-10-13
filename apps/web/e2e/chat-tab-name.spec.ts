/**
 * A chat tab's title follows the shared label rule (`@band-app/client/chat-tab-label`): the
 * agent's label for a chat with the hub's default name, and the name once someone names the
 * chat (`chats.update { name }`, which the phone's Rename calls).
 *
 * REAL `dist/start-server.mjs` against a fresh temp home; the rename goes through the real
 * `chats.update`. No tRPC mocking, no `page.route()`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { acpStubEnv } from "./helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcMutate } from "./helpers/trpc";
import { ChatPanePage } from "./pages/ChatPanePage";

const TOKEN = "e2e-chat-tab-name-token";
const REPO = "tabnameproj";
const WORKTREE = toWorktreeId(REPO, "main", "local");
const CHAT_ID = "chat-tab-name";

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const repoDir = join(tmpHome, "repo");
  mkdirSync(repoDir, { recursive: true });
  seedState(tmpHome, {
    repos: [
      {
        name: REPO,
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir }],
      },
    ],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  server = await startServer({ tmpHome, env: acpStubEnv(tmpHome) });
  await trpcMutate(server.url, TOKEN, "chats.create", {
    worktreeId: WORKTREE,
    id: CHAT_ID,
    agent: "claude-code",
  });
});

test.afterAll(async () => {
  if (server) await server.close();
  cleanupTmpHome(tmpHome);
});

test("a chat tab shows the agent's label, then the name the chat was given", async ({ page }) => {
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  await chatPane.goto(WORKTREE);
  await chatPane.waitForReady();
  await expect(chatPane.chatTab(CHAT_ID)).toHaveText("Claude Code");

  await trpcMutate(server.url, TOKEN, "chats.update", { chatId: CHAT_ID, name: "Parser fix" });
  await chatPane.reload();
  await expect(chatPane.chatTab(CHAT_ID)).toHaveText("Parser fix");
});
