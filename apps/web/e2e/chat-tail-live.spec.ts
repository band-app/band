/**
 * Frontend integration test for opening a long chat while a turn runs, and
 * for a chat shorter than one page.
 *
 * Boots the real production server with the scripted ACP agent. Two
 * worktrees each hold one chat on a session seeded in the stub agent's store
 * (Band imports it with `session/load` into its event log):
 *
 *   • `long` has 60 turns, more than the 20-turn page. The test starts a
 *     turn that streams slowly, opens the chat while it runs, and checks that
 *     the tail loads, the live text appends below it once, and the first
 *     message is not in the DOM.
 *   • `short` has 3 turns. It renders in full and the page never asks for an
 *     older page.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import { acpStubEnv, seedStubSession } from "./helpers/acp-stub";
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

const TOKEN = "e2e-chat-tail-live-token";
const REPO_LONG = "tailong";
const REPO_SHORT = "tailshort";
const LONG = {
  branch: "long",
  chat: "tail-long-chat",
  session: "33333333-4444-5555-6666-777777777777",
  turns: 60,
};
const SHORT = {
  branch: "short",
  chat: "tail-short-chat",
  session: "44444444-5555-6666-7777-888888888888",
  turns: 3,
};
const WORKTREE_LONG = toWorktreeId(REPO_LONG, "main", "local");
const WORKTREE_SHORT = toWorktreeId(REPO_SHORT, "main", "local");

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  const longDir = join(tmpHome, "long");
  const shortDir = join(tmpHome, "short");
  for (const dir of [longDir, shortDir]) mkdirSync(dir, { recursive: true });

  seedState(tmpHome, {
    repos: [
      {
        name: REPO_LONG,
        path: longDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: longDir }],
      },
      {
        name: REPO_SHORT,
        path: shortDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: shortDir }],
      },
    ],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    defaultCodingAgent: "claude-code",
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
  });

  for (const [chat, dir] of [
    [LONG, longDir],
    [SHORT, shortDir],
  ] as const) {
    seedStubSession(tmpHome, {
      sessionId: chat.session,
      cwd: dir,
      turns: Array.from({ length: chat.turns }, (_, i) => ({
        user: userText(chat.branch, i),
        agent: assistantText(chat.branch, i),
      })),
    });
  }

  server = await startServer({
    tmpHome,
    env: acpStubEnv(tmpHome, {
      turns: [
        {
          match: "run-live-turn",
          steps: [
            { say: "live-part-one-marker" },
            { sleep: 6000 },
            { say: "live-part-two-marker" },
          ],
        },
      ],
    }),
  });

  for (const [chat, worktreeId] of [
    [LONG, WORKTREE_LONG],
    [SHORT, WORKTREE_SHORT],
  ] as const) {
    await trpcMutate(server.url, TOKEN, "chats.create", {
      worktreeId,
      id: chat.chat,
      agent: "claude-code",
    });
    await trpcMutate(server.url, TOKEN, "chats.setActiveSession", {
      worktreeId,
      chatId: chat.chat,
      sessionId: chat.session,
    });
  }
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  if (server) await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Opening a chat at its tail", () => {
  test("a long chat opened mid-turn shows the tail, then the live text once, below it", async ({
    page,
  }) => {
    // Start the turn before the page opens, so the page attaches mid-turn.
    const res = await fetch(`${server.url}/api/chats/${LONG.chat}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
      body: JSON.stringify({ worktreeId: WORKTREE_LONG, text: "run-live-turn" }),
    });
    expect(res.status).toBeLessThan(300);

    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(WORKTREE_LONG);
    await chatPane.waitForReady();
    await chatPane.waitForVirtualList(15_000);

    await expect(chatPane.assistantMessage("live-part-two-marker")).toBeVisible({
      timeout: 30_000,
    });
    // The newest seeded turn is part of the tail, the first one is not loaded.
    await expect(chatPane.assistantMessage(assistantText(LONG.branch, LONG.turns - 1))).toHaveCount(
      1,
    );
    await expect(chatPane.userMessage(userText(LONG.branch, 0))).toHaveCount(0);
    // Streamed text and the prompt each appear once.
    await expect(chatPane.userMessage("run-live-turn")).toHaveCount(1);
    await expect(chatPane.assistantMessage("live-part-one-marker")).toHaveCount(1);
    await expect(chatPane.assistantMessage("live-part-two-marker")).toHaveCount(1);
  });

  test("a chat shorter than one page renders in full without asking for older pages", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    const historyRequests = chatPane.trackHistoryRequests();
    await chatPane.goto(WORKTREE_SHORT);
    await chatPane.waitForReady();

    await expect(chatPane.userMessage(userText(SHORT.branch, 0))).toBeVisible({ timeout: 30_000 });
    await expect(
      chatPane.assistantMessage(assistantText(SHORT.branch, SHORT.turns - 1)),
    ).toBeVisible();

    await chatPane.scrollToTop();
    await expect.poll(() => chatPane.readScrollTop()).toBe(0);
    // The scroll handler has run by now; no older-page request may follow.
    expect(historyRequests()).toHaveLength(0);
  });
});

function userText(branch: string, turn: number): string {
  return `${branch}-prompt-${turn}-marker`;
}

function assistantText(branch: string, turn: number): string {
  return `${branch}-reply-${turn}-marker`;
}
