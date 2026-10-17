/**
 * Opening a long chat over a slow link shows its newest messages first.
 *
 * The browser reaches the hub through a latency proxy that delays every request
 * and releases the event stream's replay in small slices, so the tail of the
 * chat arrives in several batches. Older history must load only after the user
 * scrolls up.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { toWorktreeId } from "@/dashboard";

import { type LatencyProxy, startLatencyProxy } from "./fixtures/latency-proxy";
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

const TOKEN = "e2e-chat-open-slow-link-token";
const REPO = "slowproj";
const WORKTREE = toWorktreeId(REPO, "main", "local");
const CHAT_ID = "slow-chat-deterministic-id";
const SESSION_ID = "33333333-4444-5555-6666-777777777777";
const TURNS = 60;

test.use({ viewport: { width: 1280, height: 800 } });

let server: ServerHandle;
let proxy: LatencyProxy;
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
  seedStubSession(tmpHome, { sessionId: SESSION_ID, cwd: repoDir, turns: buildTurns(TURNS) });
  server = await startServer({ tmpHome, env: acpStubEnv(tmpHome) });
  await trpcMutate(server.url, TOKEN, "chats.create", {
    worktreeId: WORKTREE,
    id: CHAT_ID,
    agent: "claude-code",
  });
  await trpcMutate(server.url, TOKEN, "chats.setActiveSession", {
    worktreeId: WORKTREE,
    chatId: CHAT_ID,
    sessionId: SESSION_ID,
  });
  proxy = await startLatencyProxy({
    target: server.url,
    latencyMs: 250,
    chunkBytes: 2500,
    chunkDelayMs: 150,
  });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await proxy?.close();
  if (server) await server.close();
  cleanupTmpHome(tmpHome);
});

test("a long chat opened over a slow link starts at its end and loads no older page", async ({
  page,
}) => {
  const chatPane = new ChatPanePage(page, proxy.url, TOKEN);
  await chatPane.installOpenSampler(assistantText(TURNS - 1));
  await chatPane.goto(WORKTREE);
  await chatPane.waitForReady();
  await chatPane.waitForVirtualList(30_000);
  await expect(chatPane.assistantMessage(assistantText(TURNS - 1))).toBeVisible({
    timeout: 30_000,
  });
  // Observe more than 150 revealed frames, so a late jump or a stray
  // older-page request would show up.
  await expect
    .poll(async () => (await chatPane.readOpenSamples()).filter((s) => s.revealed).length, {
      timeout: 15_000,
    })
    .toBeGreaterThan(150);

  const samples = await chatPane.readOpenSamples();
  // Every frame the user could see shows the newest message, even while the
  // replay's later batches are still arriving.
  const revealed = samples.filter((s) => s.revealed);
  expect(revealed.length).toBeGreaterThan(0);
  expect(revealed.filter((s) => !s.newestInView)).toHaveLength(0);
  // Older history is fetched only on scroll.
  expect(proxy.requests.filter((r) => r.includes("/history?"))).toHaveLength(0);
});

function buildTurns(turns: number): SeededTurn[] {
  return Array.from({ length: turns }, (_, i) => ({ user: userText(i), agent: assistantText(i) }));
}

function userText(turn: number): string {
  return `slow-prompt-${turn}-marker`;
}

function assistantText(turn: number): string {
  return `slow-reply-${turn}-marker`;
}
