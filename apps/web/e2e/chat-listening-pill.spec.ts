/**
 * The "Listening" pill (plan step S.6): a chat with subscriptions shows a pill
 * that lists each one and removes it on request.
 *
 * Architecture:
 *
 *   - REAL `dist/start-server.mjs` against a fresh `mkdtempSync()` home. The
 *     subscriptions are created through the real `subscriptions.create`
 *     procedure, as an agent or the CLI would, and the removal goes through
 *     the real `subscriptions.remove`.
 *   - NO tRPC mocking, no `page.route()`. The UI is driven through
 *     `ChatPanePage`.
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
import { trpcMutate, trpcQuery } from "./helpers/trpc";
import { ChatPanePage } from "./pages/ChatPanePage";

const TOKEN = "e2e-chat-listening-pill-token";
const REPO = "listeningproj";
const WORKTREE = toWorktreeId(REPO, "main", "local");
const CHAT_ID = "chat-listening-pill";

interface SubscriptionRow {
  id: string;
  source: string;
  cron?: string;
  maxWakeups: number;
}

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let tmpHome: string;

const listSubscriptions = () =>
  trpcQuery<SubscriptionRow[]>(server.url, TOKEN, "subscriptions.list", { chatId: CHAT_ID });

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

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  if (server) await server.close();
  cleanupTmpHome(tmpHome);
});

test.describe("Chat Listening pill", () => {
  test("lists a chat's subscriptions and removing one updates the list and the backend", async ({
    page,
  }) => {
    const chatPane = new ChatPanePage(page, server.url, TOKEN);
    await chatPane.goto(WORKTREE);
    await chatPane.waitForReady();

    // No subscriptions yet: no pill. The prompt is visible once the chat view
    // has mounted, and the pill's list query runs on mount against the real
    // server, so give it a moment to settle before asserting absence.
    await expect(chatPane.promptInput).toBeVisible();
    await expect.poll(listSubscriptions).toEqual([]);
    await expect(chatPane.listeningPill).toHaveCount(0);

    // An agent subscribes while the page is open. The pill appears on its own.
    await trpcMutate(server.url, TOKEN, "subscriptions.create", {
      source: "timer",
      chatId: CHAT_ID,
      cron: "0 9 * * *",
    });
    await trpcMutate(server.url, TOKEN, "subscriptions.create", {
      source: "webhook",
      chatId: CHAT_ID,
    });
    await expect(chatPane.listeningPill).toBeVisible();
    await expect(chatPane.listeningCount).toHaveText("2");

    await chatPane.openListening();
    await expect(chatPane.listeningItems).toHaveCount(2);

    const before = await listSubscriptions();
    expect(before).toHaveLength(2);
    const timer = before.find((s) => s.source === "timer");
    const hook = before.find((s) => s.source === "webhook");
    if (!timer || !hook) throw new Error("expected a timer and a webhook subscription");

    // Each row carries its data as attributes, so nothing here asserts on copy.
    const timerRow = chatPane.listeningItem(timer.id);
    await expect(timerRow).toHaveAttribute("data-source", "timer");
    await expect(timerRow).toHaveAttribute("data-cron", "0 9 * * *");
    await expect(timerRow).toHaveAttribute("data-wakeups", "0");
    await expect(timerRow).toHaveAttribute("data-max-wakeups", String(timer.maxWakeups));
    const expiresAt = Number(await timerRow.getAttribute("data-expires-at"));
    expect(expiresAt).toBeGreaterThan(Date.now());
    await expect(chatPane.listeningItem(hook.id)).toHaveAttribute("data-source", "webhook");

    // Remove the timer: its row leaves the list and the backend drops it.
    await chatPane.removeListening(timer.id);
    await expect(chatPane.listeningItem(timer.id)).toHaveCount(0);
    await expect(chatPane.listeningItem(hook.id)).toBeVisible();
    await expect(chatPane.listeningCount).toHaveText("1");
    await expect.poll(async () => (await listSubscriptions()).map((s) => s.id)).toEqual([hook.id]);

    // Removing the last one hides the pill.
    await chatPane.removeListening(hook.id);
    await expect(chatPane.listeningPill).toHaveCount(0);
    await expect.poll(listSubscriptions).toEqual([]);
  });
});
