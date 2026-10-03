/**
 * Subscription storage, routing and delivery (plan step S.1).
 *
 * Events enter through `SubscriptionService.ingest`, which has no HTTP or
 * tRPC surface until the later steps add sources, so this file drives the
 * services in-process: the real SQLite database and the real task queue
 * under a temp `BAND_HOME`, with every coding agent running as the scripted
 * ACP stub (`BAND_TEST_ACP_AGENT`). It asserts on what the stub agent
 * received over ACP. Same direct-service style as `sync-service.test.ts`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { toWorkspaceId } from "@band-app/shared/workspace-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../src/server/infra/db/connection";
import type { SubscriptionEvent } from "../src/server/infra/subscriptions/event";
import { agentSessionService } from "../src/server/services/agent-session-service";
import { chatService } from "../src/server/services/chat-service";
import { subscriptionService } from "../src/server/services/subscription-service";
import { submitOrQueueTask } from "../src/server/services/task-service";
import { workspaceService } from "../src/server/services/workspace-service";
import { TEST_TOKEN, writeStubScenario } from "./helpers/acp-chat";
import { assertTempBandHome } from "./helpers/band-home";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome } from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const PROJECT = "testproject";
const MAIN = toWorkspaceId(PROJECT, "main");
const FEATURE = toWorkspaceId(PROJECT, "feat");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: gitEnv, stdio: "ignore" });
}

let home: string;
let stubLog: string;
let seq = 0;

/** Prompts the stub agent received, in order. */
function prompts(): string[] {
  if (!existsSync(stubLog)) return [];
  return readFileSync(stubLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; params: { prompt?: { text?: string }[] } })
    .filter((r) => r.method === "session/prompt")
    .map((r) => r.params.prompt?.[0]?.text ?? "");
}

function promptsAbout(key: string): string[] {
  return prompts().filter((p) => p.includes(key));
}

function uniqueKey(): string {
  seq += 1;
  return `github:pr:owner/repo#${seq}`;
}

let eventSeq = 0;
function event(key: string, over: Partial<SubscriptionEvent> = {}): SubscriptionEvent {
  eventSeq += 1;
  return {
    id: `evt-${eventSeq}`,
    source: "github",
    kind: "comment",
    key,
    url: `https://github.com/owner/repo/pull/${seq}#c${eventSeq}`,
    actor: "octocat",
    summary: `comment number ${eventSeq}`,
    at: Date.now(),
    ...over,
  };
}

function subscribeChat(key: string, over: Record<string, unknown> = {}) {
  const chat = chatService.create(MAIN);
  const sub = subscriptionService.create({
    chatId: chat.id,
    workspaceId: MAIN,
    source: "github",
    filterKey: key,
    coalesceSeconds: 0,
    ...over,
  });
  return { chat, sub };
}

beforeAll(() => {
  home = realpathSync(createTmpHome("band-subscriptions-"));
  process.env.BAND_HOME = join(home, ".band");
  assertTempBandHome();
  const repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["commit", "--allow-empty", "-m", "initial"]);
  const featurePath = join(home, "repo-feat");
  git(repo, ["worktree", "add", "-b", "feat", featurePath]);
  seedState(home, {
    projects: [
      {
        name: PROJECT,
        path: repo,
        defaultBranch: "main",
        worktrees: [
          { branch: "main", path: repo },
          { branch: "feat", path: featurePath },
        ],
      },
    ],
  });
  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  stubLog = join(home, "acp-stub-log.jsonl");
  process.env.BAND_TEST_ACP_LOG = stubLog;
  process.env.BAND_TEST_ACP_STATE = join(home, "acp-stub-state");
  process.env.BAND_TEST_ACP_SCENARIO = writeStubScenario(home, [
    { match: "slow-turn", steps: [{ sleep: 1500 }, { say: "slow done" }] },
    { steps: [{ say: "ok" }] },
  ]);
  subscriptionService.start();
});

afterAll(() => {
  // BAND_HOME is the temp home from the first line of setup, so cleanup is
  // safe even when setup crashed. If it is not, throw before any service
  // opens the real ~/.band.
  assertTempBandHome();
  subscriptionService.stop();
  for (const chat of [...chatService.list(MAIN), ...chatService.list(FEATURE)]) {
    agentSessionService.stop(chat.id);
  }
  closeDb();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("subscriptions", () => {
  it("S1: one matching event reaches the chat as an untrusted-event block", async () => {
    const key = uniqueKey();
    const { sub } = subscribeChat(key);
    const evt = event(key, { summary: "please look at this" });
    subscriptionService.ingest(evt);

    const [message] = await waitFor(() => {
      const found = promptsAbout(key);
      return found.length > 0 ? found : undefined;
    });
    expect(promptsAbout(key)).toHaveLength(1);
    expect(message).toMatch(
      /<untrusted-event [^>]*>[\s\S]*please look at this[\s\S]*<\/untrusted-event>/,
    );
    expect(message).toContain(evt.url);
    expect(message).toContain("Re-read the source");
    expect(subscriptionService.list({ chatId: sub.chatId })[0]?.wakeups).toBe(1);
  });

  it("S2: three events inside the coalesce window arrive as one message", async () => {
    const key = uniqueKey();
    subscribeChat(key, { coalesceSeconds: 2 });
    for (const summary of ["first one", "second one", "third one"]) {
      subscriptionService.ingest(event(key, { summary }));
    }
    const [message] = await waitFor(
      () => {
        const found = promptsAbout(key);
        return found.length > 0 ? found : undefined;
      },
      { timeoutMs: 10_000 },
    );
    expect(message).toContain("3 new events");
    for (const summary of ["first one", "second one", "third one"]) {
      expect(message).toContain(summary);
    }
    expect(promptsAbout(key)).toHaveLength(1);
  });

  it("S3: the same event id is delivered once", async () => {
    const key = uniqueKey();
    subscribeChat(key);
    const evt = event(key);
    subscriptionService.ingest(evt);
    subscriptionService.ingest(evt);
    await waitFor(() => (promptsAbout(key).length > 0 ? true : undefined));
    subscriptionService.ingest(evt);
    // A repeat after delivery is dropped too; give it time to (wrongly) fire.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(promptsAbout(key)).toHaveLength(1);
    expect(promptsAbout(key)[0]).toContain("1 new event ");
  });

  it("S4: maxWakeups ends the subscription, and an expired one never delivers", async () => {
    const key = uniqueKey();
    const { sub } = subscribeChat(key, { maxWakeups: 2 });
    for (const round of [1, 2]) {
      subscriptionService.ingest(event(key));
      await waitFor(() => (promptsAbout(key).length === round ? true : undefined));
      // The chat's turn must end before the next burst starts a new one.
      await waitFor(() => (chatService.get(sub.chatId)?.status === "idle" ? true : undefined));
    }
    expect(subscriptionService.list({ chatId: sub.chatId })).toHaveLength(0);
    subscriptionService.ingest(event(key));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(promptsAbout(key)).toHaveLength(2);

    const expiredKey = uniqueKey();
    const { sub: expired } = subscribeChat(expiredKey, { expiresAt: Date.now() + 150 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    subscriptionService.ingest(event(expiredKey));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(promptsAbout(expiredKey)).toHaveLength(0);
    expect(subscriptionService.list({ chatId: expired.chatId })).toHaveLength(0);
  });

  it("S5: an event for a chat with a running turn queues behind it", async () => {
    const key = uniqueKey();
    const { chat } = subscribeChat(key);
    submitOrQueueTask({ workspaceId: MAIN, chatId: chat.id, prompt: `slow-turn ${key}` });
    await waitFor(() => (promptsAbout(key).length === 1 ? true : undefined));

    subscriptionService.ingest(event(key, { summary: "arrived during the turn" }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The turn sleeps 1.5 s; the event must not have started a second one.
    expect(promptsAbout(key)).toHaveLength(1);

    await waitFor(() => (promptsAbout(key).length === 2 ? true : undefined), {
      timeoutMs: 10_000,
    });
    expect(promptsAbout(key)[1]).toContain("arrived during the turn");
  });

  it("S6: removing a chat or a workspace deletes its subscriptions", async () => {
    const chatKey = uniqueKey();
    const { chat, sub } = subscribeChat(chatKey);
    chatService.remove(chat.id);
    expect(subscriptionService.list({ chatId: chat.id })).toHaveLength(0);
    subscriptionService.ingest(event(chatKey));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(promptsAbout(chatKey)).toHaveLength(0);
    expect(subscriptionService.events(sub.id)).toHaveLength(0);

    const featureChat = chatService.create(FEATURE);
    subscriptionService.create({
      chatId: featureChat.id,
      workspaceId: FEATURE,
      source: "github",
      filterKey: uniqueKey(),
    });
    expect(subscriptionService.list({ workspaceId: FEATURE })).toHaveLength(1);
    await workspaceService.remove({ project: PROJECT, name: "feat" });
    expect(subscriptionService.list({ workspaceId: FEATURE })).toHaveLength(0);
  });
});
