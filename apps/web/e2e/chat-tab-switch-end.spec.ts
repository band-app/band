/**
 * Two chats in one worktree: each shows its newest message at the bottom
 * when its tab is shown again.
 *
 * A switched-away tab keeps its transcript mounted, so coming back must put it
 * at its end (not wherever the last scroll left it). The first chat is
 * scrolled up before the switch to prove the return trip re-pins it.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { acpStubEnv, type SeededTurn, seedStubSession } from "./helpers/acp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcMutate } from "./helpers/trpc";
import { ChatPanePage } from "./pages/ChatPanePage";
import { WorktreePage } from "./pages/WorktreePage";

const TOKEN = "e2e-chat-tab-switch-token";
const REPO = "switchproj";
const WORKTREE = toWorktreeId(REPO, "main", "local");
const TURNS = 40;
const CHATS = [
  { id: "switch-chat-a", session: "44444444-5555-6666-7777-888888888881", tag: "alpha" },
  { id: "switch-chat-b", session: "44444444-5555-6666-7777-888888888882", tag: "bravo" },
];

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
    defaultCodingAgent: "claude-code",
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });
  for (const chat of CHATS) {
    seedStubSession(tmpHome, {
      sessionId: chat.session,
      cwd: repoDir,
      turns: buildTurns(chat.tag, TURNS),
    });
  }
  server = await startServer({ tmpHome, env: acpStubEnv(tmpHome) });
  for (const chat of CHATS) {
    await trpcMutate(server.url, TOKEN, "chats.create", {
      worktreeId: WORKTREE,
      id: chat.id,
      agent: "claude-code",
    });
    await trpcMutate(server.url, TOKEN, "chats.setActiveSession", {
      worktreeId: WORKTREE,
      chatId: chat.id,
      sessionId: chat.session,
    });
  }
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  if (server) await server.close();
  cleanupTmpHome(tmpHome);
});

test("switching away from a chat tab and back shows each chat at its newest message", async ({
  page,
}) => {
  const [a, b] = CHATS;
  const chatPane = new ChatPanePage(page, server.url, TOKEN);
  const worktreePage = new WorktreePage(page, server.url, TOKEN);
  await chatPane.goto(WORKTREE);
  await chatPane.waitForReady();

  await worktreePage.activateChatTab(a.id);
  await expect(chatPane.assistantMessage(reply(a.tag, TURNS - 1))).toBeVisible({
    timeout: 30_000,
  });
  // Leave chat A scrolled up, so a stale position would show.
  await chatPane.scrollToTop();
  await expect(chatPane.assistantMessage(reply(a.tag, TURNS - 1))).toHaveCount(0);

  await worktreePage.activateChatTab(b.id);
  await expect(chatPane.assistantMessage(reply(b.tag, TURNS - 1))).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(() => chatPane.distanceFromBottom()).toBeLessThan(4);

  await worktreePage.activateChatTab(a.id);
  await expect(chatPane.assistantMessage(reply(a.tag, TURNS - 1))).toBeVisible({
    timeout: 15_000,
  });
  await expect.poll(() => chatPane.distanceFromBottom()).toBeLessThan(4);

  await worktreePage.activateChatTab(b.id);
  await expect(chatPane.assistantMessage(reply(b.tag, TURNS - 1))).toBeVisible({
    timeout: 15_000,
  });
  await expect.poll(() => chatPane.distanceFromBottom()).toBeLessThan(4);
});

function buildTurns(tag: string, turns: number): SeededTurn[] {
  return Array.from({ length: turns }, (_, i) => ({
    user: `${tag}-prompt-${i}-marker`,
    agent: reply(tag, i),
  }));
}

function reply(tag: string, turn: number): string {
  return `${tag}-reply-${turn}-marker`;
}
