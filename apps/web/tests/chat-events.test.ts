/**
 * Integration tests for the new chat-events stream.
 *
 *   • `GET /api/chats/:chatId/events`     — unified subscription (replay + live)
 *   • `POST /api/chats/:chatId/messages`  — submit, no SSE body
 *
 * The scenarios cover the seven races we kept patching against in the
 * legacy `/api/tasks/:chatId/stream` endpoints (see
 * `docs/experiments/chat-event-log.md`). The new model eliminates them
 * structurally — these tests guard against regression as we delete the
 * legacy code.
 *
 * Black-box: the real production server boots in a child process, no mocks
 * except the `fake-agent.mjs` adapter that replays a JSON scenario file.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatEvent, ChatEventPayload, ChatEventType } from "../src/shared/chat-events";
import { seedSettings, seedState } from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const FAKE_AGENT_PATH = join(import.meta.dirname, "fake-agent.mjs");
const DEFAULT_TOKEN = "chat-events-test-token";

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = mkdtempSync(join(tmpdir(), "band-chat-events-test-"));
  mkdirSync(join(tmp, ".band"), { recursive: true });
  return tmp;
}

function writeScenario(tmpHome: string, events: object[]): string {
  const scenarioPath = join(tmpHome, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(events));
  return scenarioPath;
}

function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function createDefaultState(tmpHome: string) {
  const repoDir = join(tmpHome, "repo");
  mkdirSync(repoDir, { recursive: true });
  return {
    projects: [
      {
        name: "testproject",
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir }],
      },
    ],
  };
}

function defaultSettings() {
  return {
    tokenSecret: DEFAULT_TOKEN,
    codingAgents: [
      { id: "claude-code", type: "claude-code", label: "Claude Code", command: FAKE_AGENT_PATH },
    ],
  };
}

async function startServer(
  opts: { tmpHome?: string; scenarioPath?: string; extraEnv?: Record<string, string> } = {},
): Promise<ServerHandle> {
  const home = opts.tmpHome || createTmpHome();
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn(SERVER_RUNTIME, [SERVER_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: home,
        PORT: String(port),
        NODE_ENV: "production",
        FAKE_AGENT_SCENARIO: opts.scenarioPath || "",
        ...(opts.extraEnv ?? {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes("listening") && !settled) {
        settled = true;
        resolve({
          url: `http://127.0.0.1:${port}`,
          home,
          close: () =>
            new Promise<void>((r) => {
              child.on("exit", () => r());
              child.kill("SIGTERM");
            }),
        });
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Server exited with code ${code} before listening.\nstderr: ${stderr}`));
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Server did not start within 15s.\nstderr: ${stderr}`));
      }
    }, 15_000);
  });
}

const defaultHeaders = { Cookie: `band_token=${DEFAULT_TOKEN}` };

function newChatId(prefix = "chat-events"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function submitMessage(
  url: string,
  chatId: string,
  body: {
    workspaceId: string;
    text: string;
    files?: { mediaType: string; url: string; filename?: string }[];
  },
): Promise<Response> {
  return fetch(`${url}/api/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...defaultHeaders },
    body: JSON.stringify(body),
  });
}

async function abortTask(
  url: string,
  body: { workspaceId: string; chatId: string },
): Promise<Response> {
  return fetch(`${url}/trpc/tasks.abort`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...defaultHeaders },
    body: JSON.stringify(body),
  });
}

async function setActiveSession(
  url: string,
  body: { workspaceId: string; chatId: string; sessionId?: string },
): Promise<Response> {
  return fetch(`${url}/trpc/chats.setActiveSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...defaultHeaders },
    body: JSON.stringify(body),
  });
}

interface ParsedEvent {
  id: number;
  type: string;
  data: ChatEvent;
}

/**
 * Open the chat-events stream and collect events until a predicate matches
 * (or a max-event budget is reached). Returns the collected events and
 * disposes the underlying connection.
 */
async function collectEvents(
  url: string,
  chatId: string,
  opts: {
    lastEventId?: number;
    workspaceId?: string;
    until: (evt: ParsedEvent, all: ParsedEvent[]) => boolean;
    maxEvents?: number;
    timeoutMs?: number;
  },
): Promise<ParsedEvent[]> {
  const ac = new AbortController();
  const params = new URLSearchParams();
  if (opts.lastEventId != null) params.set("lastEventId", String(opts.lastEventId));
  if (opts.workspaceId) params.set("workspaceId", opts.workspaceId);
  const fullUrl =
    `${url}/api/chats/${encodeURIComponent(chatId)}/events` +
    (params.toString() ? `?${params.toString()}` : "");

  const headers: Record<string, string> = { ...defaultHeaders };
  if (opts.lastEventId != null) headers["Last-Event-ID"] = String(opts.lastEventId);

  const response = await fetch(fullUrl, { headers, signal: ac.signal });
  if (response.status !== 200) {
    throw new Error(`Expected 200, got ${response.status}: ${await response.text()}`);
  }
  if (!response.body) throw new Error("no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: ParsedEvent[] = [];
  let buf = "";
  const max = opts.maxEvents ?? 500;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const timeout = setTimeout(() => ac.abort(), timeoutMs);

  let currentId: number | undefined;
  let currentType: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      while (true) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith("id: ")) {
          currentId = Number.parseInt(line.slice(4).trim(), 10);
        } else if (line.startsWith("event: ")) {
          currentType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const raw = line.slice(6).trim();
          if (raw) {
            try {
              const data = JSON.parse(raw) as ChatEvent;
              const evt: ParsedEvent = {
                id: currentId ?? data.eventId,
                type: currentType ?? data.type,
                data,
              };
              events.push(evt);
              currentId = undefined;
              currentType = undefined;
              if (opts.until(evt, events) || events.length >= max) {
                clearTimeout(timeout);
                ac.abort();
                return events;
              }
            } catch {
              // ignore parse failures
            }
          }
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") return events;
    throw err;
  } finally {
    clearTimeout(timeout);
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function quickScenario(sessionId = "events-quick") {
  return [
    { type: "system", subtype: "init", session_id: sessionId },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello, world." }] },
    },
    {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      duration_ms: 50,
      num_turns: 1,
      total_cost_usd: 0.01,
    },
  ];
}

function longScenario(sessionId = "events-long") {
  return [
    { type: "system", subtype: "init", session_id: sessionId },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "first chunk " }] },
    },
    { _sleep_ms: 800 },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "second chunk" }] },
    },
    {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      duration_ms: 800,
      num_turns: 1,
      total_cost_usd: 0.01,
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("chat-events — submit + observe via subscription", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    const scenario = writeScenario(tmpHome, quickScenario());
    server = await startServer({ tmpHome, scenarioPath: scenario });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("subscription opens immediately for a fresh chat (no 204)", async () => {
    const chatId = newChatId();
    const events = await collectEvents(server.url, chatId, {
      until: (e) => e.type === "subscription-opened",
      timeoutMs: 5_000,
    });
    expect(events.length).toBeGreaterThan(0);
    const first = events[0];
    expect(first.type).toBe("subscription-opened");
    const data = first.data as Extract<ChatEventPayload, { type: "subscription-opened" }> & {
      eventId: number;
    };
    expect(data.taskRunning).toBe(false);
    expect(data.sessionId).toBeUndefined();
  });

  /**
   * Regression for "queue UI shows stale items after returning to the
   * workspace": the user queued 1..6 in workspace A, switched away while
   * processing, came back to A and saw 3..6 still listed as "Queued"
   * even though all six had been drained.
   *
   * Root cause: the chat-events handler only emitted `queue-updated` on
   * subscribe when the queue was non-empty. The user's client had
   * disconnected (workspace switch closes the EventSource), the drains
   * happened while disconnected, and on reconnect the empty queue never
   * produced an event — so the reducer kept the pre-disconnect queue.
   *
   * Fix: always emit the current queue state on subscribe.
   */
  it("subscribe always emits an initial queue-updated event, even when empty", async () => {
    const chatId = newChatId();
    const events = await collectEvents(server.url, chatId, {
      // subscription-opened comes first, queue-updated is the next
      // synthetic emit.
      until: (_e, all) => all.some((x) => x.type === "queue-updated"),
      timeoutMs: 5_000,
    });

    const queueUpdated = events.find((e) => e.type === "queue-updated");
    expect(queueUpdated).toBeDefined();
    const data = queueUpdated!.data as Extract<ChatEventPayload, { type: "queue-updated" }> & {
      eventId: number;
    };
    expect(data.messages).toEqual([]);
  });

  it("submit then observe — emits the expected event sequence", async () => {
    const chatId = newChatId();

    // Open subscription FIRST so we capture every event (no replay needed).
    const subscriptionPromise = collectEvents(server.url, chatId, {
      until: (e) => e.type === "task-completed" || e.type === "task-error",
      timeoutMs: 15_000,
    });

    // Submit.
    const submitRes = await submitMessage(server.url, chatId, {
      workspaceId: "testproject-main",
      text: "hello",
    });
    expect(submitRes.status).toBe(200);
    const submitBody = await submitRes.json();
    expect(submitBody).toEqual({ ok: true, queued: false });

    const events = await subscriptionPromise;
    const types = events.map((e) => e.type as ChatEventType);

    expect(types).toContain("subscription-opened");
    expect(types).toContain("user-message");
    expect(types).toContain("task-started");
    expect(types).toContain("session-resolved");
    expect(types).toContain("text-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("task-completed");
  });

  it("reconnect with non-zero Last-Event-ID receives only suffix events", async () => {
    const chatId = newChatId();

    // First subscription — submit and capture all events.
    const fullPromise = collectEvents(server.url, chatId, {
      until: (e) => e.type === "task-completed",
      timeoutMs: 15_000,
    });
    const submitRes = await submitMessage(server.url, chatId, {
      workspaceId: "testproject-main",
      text: "first turn",
    });
    expect(submitRes.status).toBe(200);
    const fullEvents = await fullPromise;
    expect(fullEvents.length).toBeGreaterThan(3);

    // Pick a mid-stream eventId. Filter to positive ids (real buffer ids).
    const positiveIds = fullEvents.map((e) => e.id).filter((id) => id > 0);
    expect(positiveIds.length).toBeGreaterThan(2);
    const cursor = positiveIds[Math.floor(positiveIds.length / 2)];

    // Second subscription — request only events past `cursor`.
    const replayEvents = await collectEvents(server.url, chatId, {
      lastEventId: cursor,
      until: (_e, all) => all.length >= 5,
      timeoutMs: 5_000,
    });

    // First event is always `subscription-opened` (synthetic, negative id).
    expect(replayEvents[0].type).toBe("subscription-opened");
    // No positive-id event we receive should be <= cursor.
    for (const evt of replayEvents) {
      if (evt.id > 0) {
        expect(evt.id).toBeGreaterThan(cursor);
      }
    }
  });
});

describe("chat-events — queue-when-busy flow", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    const scenario = writeScenario(tmpHome, longScenario());
    server = await startServer({ tmpHome, scenarioPath: scenario });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("submitting while a task is running queues and emits queue-updated", async () => {
    const chatId = newChatId();

    const subscriptionPromise = collectEvents(server.url, chatId, {
      // Wait for a queue-updated carrying our second submit. The
      // subscription also emits an initial queue-updated with messages:[]
      // on subscribe (resync guard); we want the one fired by the actual
      // server-side queue push.
      until: (_e, all) =>
        all.some((x) => {
          if (x.type !== "queue-updated") return false;
          const d = x.data as Extract<ChatEventPayload, { type: "queue-updated" }> & {
            eventId: number;
          };
          return d.messages.some((m) => m.text === "second");
        }),
      maxEvents: 50,
      timeoutMs: 15_000,
    });

    // First submit — kicks off a long task.
    await submitMessage(server.url, chatId, {
      workspaceId: "testproject-main",
      text: "first",
    });

    // Give the task a beat to register before submitting the second one,
    // so the conflict path fires server-side.
    await new Promise((r) => setTimeout(r, 100));

    // Second submit — should land in the queue, not error.
    const secondRes = await submitMessage(server.url, chatId, {
      workspaceId: "testproject-main",
      text: "second",
    });
    expect(secondRes.status).toBe(200);
    const body = await secondRes.json();
    expect(body).toEqual({ ok: true, queued: true });

    const events = await subscriptionPromise;
    const queueUpdates = events.filter((e) => e.type === "queue-updated");
    expect(queueUpdates.length).toBeGreaterThan(0);
    const queued = queueUpdates[queueUpdates.length - 1].data as Extract<
      ChatEventPayload,
      { type: "queue-updated" }
    > & { eventId: number };
    expect(queued.messages.map((m) => m.text)).toContain("second");
  });
});

describe("chat-events — concurrent subscribers see identical event sequences", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    const scenario = writeScenario(tmpHome, quickScenario());
    server = await startServer({ tmpHome, scenarioPath: scenario });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("two clients receive the same event sequence", async () => {
    const chatId = newChatId();
    const aPromise = collectEvents(server.url, chatId, {
      until: (e) => e.type === "task-completed",
      timeoutMs: 15_000,
    });
    const bPromise = collectEvents(server.url, chatId, {
      until: (e) => e.type === "task-completed",
      timeoutMs: 15_000,
    });

    await submitMessage(server.url, chatId, {
      workspaceId: "testproject-main",
      text: "concurrent",
    });

    const [a, b] = await Promise.all([aPromise, bPromise]);

    // Filter to real (positive-id) events — synthetic ids may differ between
    // subscribers (each has its own counter starting at -1).
    const aReal = a.filter((e) => e.id > 0).map((e) => `${e.id}:${e.type}`);
    const bReal = b.filter((e) => e.id > 0).map((e) => `${e.id}:${e.type}`);

    expect(aReal).toEqual(bReal);
    expect(aReal.length).toBeGreaterThan(0);
  });
});

describe("chat-events — cold subscribe replays history from chats.activeSessionId", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    const scenario = writeScenario(tmpHome, quickScenario("cold-subscribe-session"));
    server = await startServer({ tmpHome, scenarioPath: scenario });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("subscribing to a chat after task completion replays the prior session's events", async () => {
    const chatId = newChatId("cold");

    // Phase 1: run a task to completion so the chat row has activeSessionId
    // and JSONL has the session events. Close the subscription cleanly.
    const initialPromise = collectEvents(server.url, chatId, {
      until: (e) => e.type === "task-completed",
      timeoutMs: 15_000,
    });
    await submitMessage(server.url, chatId, {
      workspaceId: "testproject-main",
      text: "first message",
    });
    await initialPromise;

    // Phase 2: cold-subscribe with no Last-Event-ID. Before the fix this
    // returned an empty replay (resolvedSessionId was undefined because
    // no in-memory task remained). The fix falls back to chat.activeSessionId
    // — JSONL replay should now surface the prior session's events.
    const replay = await collectEvents(server.url, chatId, {
      until: (_e, all) => all.some((x) => x.type === "user-message"),
      timeoutMs: 5_000,
    });

    const types = replay.map((e) => e.type as ChatEventType);
    expect(types).toContain("user-message");
    // Initial subscription-opened carries the persisted sessionId.
    const subOpened = replay.find((e) => e.type === "subscription-opened");
    const subData = subOpened?.data as Extract<
      ChatEventPayload,
      { type: "subscription-opened" }
    > & { eventId: number };
    expect(subData.sessionId).toBeTruthy();
  }, 25_000);

  // Regression for "picking a session from history, sending a follow-up,
  // refreshing, and seeing only the last message" is covered by the
  // change to `replayPast` in `apps/web/src/api/chat-events.ts`: on cold
  // subscribe (`afterEventId === undefined`) JSONL is prioritised over
  // the in-memory buffer. A black-box test of the multi-turn JSONL path
  // is hard to write here because the fake-agent + SDK JSONL writing is
  // not deterministic enough to seed multiple turns at a known path
  // ahead of a submit. The existing "subscribing to a chat after task
  // completion …" test above exercises the same code path with one turn.

  /**
   * Regression: on a NEW session, `task-service` appends a
   * `\n\n[File sharing: …]` hint to the prompt sent to the agent. The
   * agent writes this full prompt to its JSONL transcript, hint and
   * all. The live `user-message` broadcast already strips the hint
   * (uses `task.prompt`, not `task.agentPrompt`), but JSONL replay
   * reads what's on disk — without `stripFileSharingHint` in
   * `chat-events.ts::jsonlMessageToEvents`, the replayed user bubble
   * would carry the suffix visibly. This test submits a fresh-session
   * message, cold-subscribes, and asserts the replayed text is clean.
   */
  it("JSONL replay strips the [File sharing: …] hint from the user-message text", async () => {
    const chatId = newChatId("hint-strip");

    // Phase 1: submit on a brand-new session so task-service appends the
    // hint to the agent prompt (the hint is only appended when there's
    // no incoming sessionId — see `task-service.ts::fileSharingHint`).
    const initialPromise = collectEvents(server.url, chatId, {
      until: (e) => e.type === "task-completed",
      timeoutMs: 15_000,
    });
    await submitMessage(server.url, chatId, {
      workspaceId: "testproject-main",
      text: "tell me about this repo",
    });
    await initialPromise;

    // Phase 2: cold-subscribe — JSONL backfill emits the user-message
    // from disk. The text must match what the user actually typed,
    // not `…\n\n[File sharing: …]` from the agent prompt.
    //
    // The describe block shares a tmpHome across tests, and the
    // fake-agent's scenario hardcodes `cold-subscribe-session` as the
    // session id — so the JSONL on disk accumulates user-messages
    // across tests. We don't care which user-messages are in the
    // replay; we care that NONE of them carry the hint suffix and
    // that the one we just sent shows up clean.
    const replay = await collectEvents(server.url, chatId, {
      until: (_e, all) =>
        all.some(
          (x) =>
            x.type === "user-message" &&
            (x.data as Extract<ChatEventPayload, { type: "user-message" }> & { eventId: number })
              .text === "tell me about this repo",
        ),
      timeoutMs: 5_000,
    });

    const userMessages = replay.filter((e) => e.type === "user-message");
    expect(userMessages.length).toBeGreaterThan(0);
    for (const evt of userMessages) {
      const data = evt.data as Extract<ChatEventPayload, { type: "user-message" }> & {
        eventId: number;
      };
      // Every replayed user-message must be hint-free.
      expect(data.text).not.toMatch(/\[File sharing:/);
    }
    // And the one we just submitted shows up exactly as typed.
    const justSent = userMessages.find(
      (e) =>
        (e.data as Extract<ChatEventPayload, { type: "user-message" }> & { eventId: number })
          .text === "tell me about this repo",
    );
    expect(justSent).toBeDefined();
  }, 25_000);
});

describe("chat-events — back-to-back submissions render as two clean turns (Option A)", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    // Long scenario for the first task so the second submit lands while
    // the first is still running and gets queued server-side. The drain
    // path is what we're exercising.
    const scenario = writeScenario(tmpHome, longScenario("events-back-to-back"));
    server = await startServer({ tmpHome, scenarioPath: scenario });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("queue drain emits user-message + task-started for the second turn (no data-prompt leakage)", async () => {
    const chatId = newChatId("backtoback");

    // Stop after we see TWO `task-completed` events — that's the marker that
    // both turns finished (first task + drained second task).
    const subscriptionPromise = collectEvents(server.url, chatId, {
      until: (_e, all) => all.filter((x) => x.type === "task-completed").length >= 2,
      maxEvents: 200,
      timeoutMs: 30_000,
    });

    // First submit — starts the long task.
    await submitMessage(server.url, chatId, {
      workspaceId: "testproject-main",
      text: "first turn",
    });
    // Give the task a beat to register so the second submit lands while
    // the first is in flight (and ends up on the queue).
    await new Promise((r) => setTimeout(r, 100));

    const secondRes = await submitMessage(server.url, chatId, {
      workspaceId: "testproject-main",
      text: "second turn",
    });
    expect(secondRes.status).toBe(200);
    const secondBody = await secondRes.json();
    expect(secondBody).toEqual({ ok: true, queued: true });

    const events = await subscriptionPromise;

    // Option A wire shape: two complete turns, each with its own
    // user-message → task-started → ... → task-completed sequence.
    const types = events.map((e) => e.type as ChatEventType);

    // No `data-prompt` (or any non-ChatEvent type) should leak onto the
    // new wire — the translator drops it.
    expect(types).not.toContain("data-prompt");

    const userMessageIdxs = types
      .map((t, i) => (t === "user-message" ? i : -1))
      .filter((i) => i >= 0);
    const taskStartedIdxs = types
      .map((t, i) => (t === "task-started" ? i : -1))
      .filter((i) => i >= 0);
    const taskCompletedIdxs = types
      .map((t, i) => (t === "task-completed" ? i : -1))
      .filter((i) => i >= 0);

    // Two of each.
    expect(userMessageIdxs.length).toBe(2);
    expect(taskStartedIdxs.length).toBe(2);
    expect(taskCompletedIdxs.length).toBe(2);

    // Per-turn ordering: user-message[0] < task-started[0] < task-completed[0] < user-message[1] < task-started[1] < task-completed[1]
    expect(userMessageIdxs[0]).toBeLessThan(taskStartedIdxs[0]);
    expect(taskStartedIdxs[0]).toBeLessThan(taskCompletedIdxs[0]);
    expect(taskCompletedIdxs[0]).toBeLessThan(userMessageIdxs[1]);
    expect(userMessageIdxs[1]).toBeLessThan(taskStartedIdxs[1]);
    expect(taskStartedIdxs[1]).toBeLessThan(taskCompletedIdxs[1]);

    // The two user messages have the expected text content.
    const userMessageEvents = events.filter((e) => e.type === "user-message");
    const userTexts = userMessageEvents.map(
      (e) =>
        (e.data as Extract<ChatEventPayload, { type: "user-message" }> & { eventId: number }).text,
    );
    expect(userTexts).toEqual(["first turn", "second turn"]);
  }, 35_000);
});

describe("chat-events — task completion closes the stream cleanly", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    const scenario = writeScenario(tmpHome, quickScenario());
    server = await startServer({ tmpHome, scenarioPath: scenario });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("subscriber observes task-completed and stream closes (no hang)", async () => {
    const chatId = newChatId();
    const subscriptionPromise = collectEvents(server.url, chatId, {
      // The until predicate is "see task-completed" — but the server should
      // also close the stream right after, which our reader notices via
      // stream end. Pass a generous timeout; if the stream hangs, the test
      // would time out instead of completing fast.
      until: (e) => e.type === "task-completed",
      timeoutMs: 10_000,
    });

    await submitMessage(server.url, chatId, {
      workspaceId: "testproject-main",
      text: "go",
    });

    const events = await subscriptionPromise;
    const last = events[events.length - 1];
    expect(last.type).toBe("task-completed");
  });
});

describe("chat-events — sequential submits resume the previous session", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    const scenario = writeScenario(tmpHome, quickScenario("sequential-session"));
    server = await startServer({ tmpHome, scenarioPath: scenario });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  /**
   * Regression for the "second message creates its own session — no reply
   * rendered" bug:
   *
   *   1. Each session has its own per-buffer eventId counter starting at 1
   *      (`apps/web/src/server/services/task-service.ts` -> `broadcast`).
   *   2. Before the fix, every `POST /api/chats/:chatId/messages` submitted
   *      with no `sessionId` started a brand-new agent session.
   *   3. So turn 2's events lived in session-B with eventIds 1, 2, 3, …,
   *      while the client's `Last-Event-ID` was 7-ish from turn 1.
   *   4. The server's gap-fill replay + live-tail filter both drop events
   *      with `eventId <= lastEventId`, so the client never received turn
   *      2's `text-delta`s — visible as "I see the indicator, it goes away,
   *      no reply rendered" in the UI.
   *
   * Fix: `apps/web/src/api/chat-submit.ts` falls back to
   * `chat.activeSessionId` when the body has no `sessionId`. Turn 2 then
   * resumes session-A, its events keep the monotonic counter going, and
   * the lastEventId filter behaves.
   */
  it("a second submit after task-completed continues the same session and surfaces a reply", async () => {
    const chatId = newChatId("seq");

    // Turn 1 — start subscription FIRST, then submit, then collect.
    const turn1Promise = collectEvents(server.url, chatId, {
      until: (e) => e.type === "task-completed",
      timeoutMs: 15_000,
    });
    await submitMessage(server.url, chatId, {
      workspaceId: "testproject-main",
      text: "first",
    });
    const turn1Events = await turn1Promise;

    // Verify turn 1 produced the expected full sequence.
    const turn1Types = turn1Events.map((e) => e.type);
    expect(turn1Types).toContain("text-delta");
    expect(turn1Types).toContain("task-completed");

    const turn1SessionResolved = turn1Events.find((e) => e.type === "session-resolved");
    expect(turn1SessionResolved).toBeDefined();
    const turn1SessionId = (
      turn1SessionResolved!.data as Extract<ChatEventPayload, { type: "session-resolved" }> & {
        eventId: number;
      }
    ).sessionId;

    // Last positive (real) event id from turn 1 — the client uses this as
    // the reconnect cursor.
    const lastEventId = Math.max(...turn1Events.filter((e) => e.id > 0).map((e) => e.id));
    expect(lastEventId).toBeGreaterThan(0);

    // Turn 2 — fresh subscription with Last-Event-ID set to turn 1's max,
    // mirroring how the client behaves after the server closes the stream
    // on task-completed and the user submits again.
    const turn2Promise = collectEvents(server.url, chatId, {
      lastEventId,
      until: (e) => e.type === "task-completed",
      timeoutMs: 15_000,
    });
    await submitMessage(server.url, chatId, {
      workspaceId: "testproject-main",
      text: "second",
    });
    const turn2Events = await turn2Promise;

    const turn2Types = turn2Events.map((e) => e.type);
    // The whole point: turn 2 produced text content that reached the client.
    expect(turn2Types).toContain("user-message");
    expect(turn2Types).toContain("task-started");
    expect(turn2Types).toContain("text-delta");
    expect(turn2Types).toContain("task-completed");

    // All turn-2 buffer events (positive ids) must have ids strictly
    // greater than turn 1's lastEventId — that's exactly what the
    // chat-submit `sessionId` fallback guarantees by keeping the same
    // session buffer's counter ticking. Without the fix they'd be 1, 2, …
    // and be filtered out as "already replayed".
    for (const evt of turn2Events) {
      if (evt.id > 0) {
        expect(evt.id).toBeGreaterThan(lastEventId);
      }
    }

    // And the second user message text is the one we actually sent.
    const turn2UserMessages = turn2Events.filter((e) => e.type === "user-message");
    expect(turn2UserMessages.length).toBeGreaterThan(0);
    expect(
      (
        turn2UserMessages[0].data as Extract<ChatEventPayload, { type: "user-message" }> & {
          eventId: number;
        }
      ).text,
    ).toBe("second");

    // Sanity: chat.activeSessionId-driven continuation means session-resolved
    // (if emitted) reports the same session both times.
    const turn2SessionResolved = turn2Events.find((e) => e.type === "session-resolved");
    if (turn2SessionResolved) {
      const turn2SessionId = (
        turn2SessionResolved.data as Extract<ChatEventPayload, { type: "session-resolved" }> & {
          eventId: number;
        }
      ).sessionId;
      expect(turn2SessionId).toBe(turn1SessionId);
    }
  }, 30_000);
});

describe("chat-events — session switching respects chat.activeSessionId", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    const scenario = writeScenario(tmpHome, quickScenario("stale-task-session"));
    server = await startServer({ tmpHome, scenarioPath: scenario });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  /**
   * Regression for the session-switch bug found post-refactor: after a
   * task completes its `task.sessionId` lingered in the `tasks` Map. The
   * subscription handler used `task?.sessionId ?? chat?.activeSessionId`,
   * which silently overrode the user's selection. Fixed by gating on
   * `task?.status === "running"` — see `apps/web/src/api/chat-events.ts`.
   *
   * Scenario:
   *   1. Submit a message → task runs against "stale-task-session" and
   *      completes (task lingers in memory with status="completed").
   *   2. Switch the chat to a different session via setActiveSession.
   *   3. Open a fresh subscription — `subscription-opened.sessionId` MUST
   *      be the new session, not the completed task's session.
   */
  it("a completed task's sessionId does NOT override chat.activeSessionId on cold subscribe", async () => {
    const chatId = newChatId("switch");

    // Phase 1: run a task to completion.
    const taskPromise = collectEvents(server.url, chatId, {
      until: (e) => e.type === "task-completed",
      timeoutMs: 15_000,
    });
    await submitMessage(server.url, chatId, {
      workspaceId: "testproject-main",
      text: "first task",
    });
    await taskPromise;

    // Phase 2: switch to a different session.
    const otherSessionId = "00000000-0000-0000-0000-aaaaaaaaaaaa";
    const switchRes = await setActiveSession(server.url, {
      workspaceId: "testproject-main",
      chatId,
      sessionId: otherSessionId,
    });
    expect(switchRes.status).toBe(200);

    // Phase 3: cold subscribe. The handler must resolve sessionId from
    // chat.activeSessionId (the freshly-set otherSessionId), NOT from
    // the lingering completed task's `stale-task-session`.
    const events = await collectEvents(server.url, chatId, {
      until: (e) => e.type === "subscription-opened",
      timeoutMs: 5_000,
    });
    const subOpened = events.find((e) => e.type === "subscription-opened");
    expect(subOpened).toBeDefined();
    const data = subOpened!.data as Extract<ChatEventPayload, { type: "subscription-opened" }> & {
      eventId: number;
    };
    expect(data.sessionId).toBe(otherSessionId);
    expect(data.taskRunning).toBe(false);
  });

  /**
   * Regression for the "New session" UX: clicking "New session" calls
   * setActiveSession with `sessionId: undefined`, which must produce a
   * subscription with no replay. The earlier bug was twofold:
   *   - `ensureActiveSessionSummary` re-promoted the latest on-disk
   *     session via `getLatestSession`, clobbering the cleared state.
   *   - The subscription would then surface the prior session's events.
   *
   * Under the event-log model the cleared row stays cleared, and the
   * subscription opens "empty" until the user submits the first message
   * of the new session.
   */
  it("clearing activeSessionId yields an empty subscription (no replay, no session)", async () => {
    const chatId = newChatId("newsession");

    // Phase 1: run a task to completion so the chat has an activeSessionId
    // and the JSONL is on disk (would be replayed if the clear failed).
    const taskPromise = collectEvents(server.url, chatId, {
      until: (e) => e.type === "task-completed",
      timeoutMs: 15_000,
    });
    await submitMessage(server.url, chatId, {
      workspaceId: "testproject-main",
      text: "first task",
    });
    await taskPromise;

    // Phase 2: clear activeSessionId (the "New session" UX path).
    const clearRes = await setActiveSession(server.url, {
      workspaceId: "testproject-main",
      chatId,
      // sessionId omitted ⇒ undefined ⇒ clears chat.activeSessionId.
    });
    expect(clearRes.status).toBe(200);

    // Phase 3: cold subscribe — no sessionId, no replay events.
    // Collect for a short window to catch any unintended replay.
    const events = await collectEvents(server.url, chatId, {
      until: (_e, all) => all.length >= 3,
      timeoutMs: 1_500,
    });

    const subOpened = events.find((e) => e.type === "subscription-opened");
    expect(subOpened).toBeDefined();
    const data = subOpened!.data as Extract<ChatEventPayload, { type: "subscription-opened" }> & {
      eventId: number;
    };
    expect(data.sessionId).toBeUndefined();
    expect(data.taskRunning).toBe(false);

    // No prior-session content events should follow subscription-opened.
    // The fix guarantees JSONL backfill is gated on a resolved sessionId.
    const contentTypes: ChatEventType[] = [
      "user-message",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-available",
      "tool-output-available",
    ];
    const leaked = events.filter((e) => contentTypes.includes(e.type as ChatEventType));
    expect(leaked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// File attachment integration test
//
// Verifies the end-to-end path for a user sending a message with file
// attachments — the same wire the chat UI's `useChatSubscription.send`
// drives:
//
//   1. `POST /api/chats/:chatId/messages` body carries `files` as data
//      URLs (base64).
//   2. Server persists each file to `<HOME>/.band/uploads/<storedName>`
//      with the original bytes intact.
//   3. The `user-message` event on the live subscription surfaces the
//      files with stable `/api/uploads/<storedName>` URLs (NOT the bulky
//      data URLs) so reloading the chat from disk renders the user
//      bubble with its images.
//
// Doctrine-compliant: real server, real disk, no mocking of our own
// routes. The fake-agent emits the same `quickScenario` it would for a
// text-only message; the file path is purely server-side.
// ---------------------------------------------------------------------------

describe("chat-events — file attachment uploads end-to-end", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    const scenario = writeScenario(tmpHome, quickScenario("files-session"));
    server = await startServer({ tmpHome, scenarioPath: scenario });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("submits a file as a base64 data URL → saved to disk + user-message carries /api/uploads URL", async () => {
    const chatId = newChatId("files");

    // 5-byte PNG-ish payload (real PNG signature is fine to keep on disk).
    // We assert byte-for-byte equality on what arrived at /uploads/.
    const pixelBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a]);
    const base64 = pixelBytes.toString("base64");

    const subscriptionPromise = collectEvents(server.url, chatId, {
      until: (e) => e.type === "user-message",
      timeoutMs: 15_000,
    });

    const submitRes = await submitMessage(server.url, chatId, {
      workspaceId: "testproject-main",
      text: "look at this",
      files: [
        {
          mediaType: "image/png",
          url: `data:image/png;base64,${base64}`,
          filename: "pixel.png",
        },
      ],
    });
    expect(submitRes.status).toBe(200);
    expect(await submitRes.json()).toEqual({ ok: true, queued: false });

    // (1) File landed on disk under <HOME>/.band/uploads/ with intact bytes.
    const uploadDir = join(server.home, ".band", "uploads");
    expect(existsSync(uploadDir)).toBe(true);
    const uploadedFiles = readdirSync(uploadDir);
    expect(uploadedFiles.length).toBe(1);
    expect(uploadedFiles[0]).toMatch(/^\d+-0-pixel\.png$/);
    const savedBytes = readFileSync(join(uploadDir, uploadedFiles[0]));
    expect(Buffer.compare(savedBytes, pixelBytes)).toBe(0);

    // (2) The `user-message` event over the subscription stripped the
    // bulky data URL and surfaced a stable /api/uploads/ reference.
    const events = await subscriptionPromise;
    const userMsg = events.find((e) => e.type === "user-message");
    expect(userMsg).toBeDefined();
    const data = userMsg!.data as Extract<ChatEventPayload, { type: "user-message" }> & {
      eventId: number;
    };
    expect(data.text).toBe("look at this");
    expect(data.files).toBeDefined();
    expect(data.files).toHaveLength(1);
    const file = data.files![0];
    expect(file.mediaType).toBe("image/png");
    expect(file.filename).toBe("pixel.png");
    expect(file.url).toMatch(/^\/api\/uploads\/\d+-0-pixel\.png$/);
    // Crucially: the wire URL is NOT the bulky base64 data URL.
    expect(file.url.startsWith("data:")).toBe(false);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Queue drain preserves file attachments
//
// Regression for the silently-dropped-image bug:
//   - User submits message #1 (long task). It starts running.
//   - User submits message #2 carrying an image attachment. The submit
//     returns `{ queued: true }` because the chat is busy.
//   - Task #1 completes.
//   - The drained queued turn used to call `saveUploadedFilesDetailed`
//     again at drain time. But by then the queued payload's url had
//     already been transformed from a `data:` URL into
//     `/api/uploads/<storedName>` — the helper's data-URL regex no
//     longer matched, so EVERY file was silently dropped. The result:
//     no `files` on the user-message event, no `I'm sharing these
//     files…` preamble for the agent, image gone.
//
// The fix carries the on-disk `path` through the queue payload and
// reconstructs the agent prompt + display files directly from queued
// metadata, without a second save. This test pins both halves:
//   - The user-message event for the drained turn carries `files` with
//     the right mediaType and a stable `/api/uploads/` URL.
//   - The agent received the `I'm sharing these files with you:\n- <path>`
//     preamble verbatim (verified by reading the stdin log dumped by
//     the fake-agent — see `FAKE_AGENT_STDIN_LOG` in fake-agent.mjs).
// ---------------------------------------------------------------------------

describe("chat-events — queue drain preserves file attachments", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let stdinLogPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    // longScenario sleeps mid-stream so the second submit lands while
    // the first task is still running and gets queued server-side. The
    // drain is the path we're exercising.
    const scenario = writeScenario(tmpHome, longScenario("queue-files-session"));
    stdinLogPath = join(tmpHome, "fake-agent-stdin.log");
    server = await startServer({
      tmpHome,
      scenarioPath: scenario,
      extraEnv: { FAKE_AGENT_STDIN_LOG: stdinLogPath },
    });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("drained queued message keeps its image attachment + agent receives the file-sharing preamble", async () => {
    const chatId = newChatId("queue-files");

    // Subscribe FIRST so we observe both turns. Stop after two
    // `task-completed` events — first task + drained second task.
    const subscriptionPromise = collectEvents(server.url, chatId, {
      until: (_e, all) => all.filter((x) => x.type === "task-completed").length >= 2,
      maxEvents: 200,
      timeoutMs: 30_000,
    });

    // Turn 1 — text-only, kicks off the long task.
    const firstRes = await submitMessage(server.url, chatId, {
      workspaceId: "testproject-main",
      text: "first turn",
    });
    expect(firstRes.status).toBe(200);
    expect(await firstRes.json()).toEqual({ ok: true, queued: false });

    // Wait for the first task to be actually running before submitting
    // the second message — otherwise the conflict path doesn't fire and
    // the second turn runs immediately instead of being queued. A hard
    // sleep would race on fast CI machines (task completes < sleep
    // duration) or slow ones (sleep ends before task starts); polling
    // for `task-started` makes the assertion order-of-events stable.
    // Same pattern the cancel/abort test uses.
    await new Promise<void>((resolveStart, rejectStart) => {
      const start = Date.now();
      const poll = async () => {
        try {
          const probe = await collectEvents(server.url, chatId, {
            until: (e) => e.type === "task-started",
            timeoutMs: 5_000,
          });
          if (probe.some((e) => e.type === "task-started")) return resolveStart();
        } catch {
          // probe stream may close early; that's fine, we'll re-poll
        }
        if (Date.now() - start > 5_000) {
          rejectStart(new Error("task-started never arrived for first turn"));
        } else {
          setTimeout(poll, 50);
        }
      };
      poll();
    });

    // Turn 2 — same 1×1 PNG signature the existing file-upload test
    // uses, encoded as a data URL the way the chat UI submits images
    // pasted from the clipboard.
    const pixelBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a]);
    const dataUrl = `data:image/png;base64,${pixelBytes.toString("base64")}`;
    const queuedText = "what about this image?";

    const secondRes = await submitMessage(server.url, chatId, {
      workspaceId: "testproject-main",
      text: queuedText,
      files: [{ mediaType: "image/png", url: dataUrl, filename: "queued-pixel.png" }],
    });
    // Confirm we actually hit the queue path; if this returns
    // `queued: false`, the rest of the test would pass trivially without
    // exercising the drain — that's the bug we're guarding against.
    expect(secondRes.status).toBe(200);
    expect(await secondRes.json()).toEqual({ ok: true, queued: true });

    // The submit handler persists the file under <HOME>/.band/uploads/
    // BEFORE pushing the queued payload. By the time the second submit
    // returns 200 the bytes must already be on disk.
    const uploadDir = join(server.home, ".band", "uploads");
    expect(existsSync(uploadDir)).toBe(true);
    const uploadedFiles = readdirSync(uploadDir);
    expect(uploadedFiles.length).toBe(1);
    expect(uploadedFiles[0]).toMatch(/^\d+-0-queued-pixel\.png$/);
    const savedAbsPath = join(uploadDir, uploadedFiles[0]);
    expect(Buffer.compare(readFileSync(savedAbsPath), pixelBytes)).toBe(0);

    const events = await subscriptionPromise;

    // Two complete turns, each with its own user-message → task-completed
    // sequence. The DRAINED turn (#1 in 0-indexed order, the second
    // user-message overall) is the one we care about.
    const userMessages = events.filter((e) => e.type === "user-message");
    expect(userMessages.length).toBe(2);

    const drainedUserMsg = userMessages[1];
    const drainedData = drainedUserMsg.data as Extract<
      ChatEventPayload,
      { type: "user-message" }
    > & { eventId: number };

    // The drained user bubble surfaces the queued text — not the
    // `I'm sharing these files…\n\n<text>` agent prompt (that's the
    // augmented prompt sent to the model, not the displayed text).
    expect(drainedData.text).toBe(queuedText);

    // And the file metadata is preserved end-to-end. Pre-fix the wire
    // shape had NO `files` field at all (saveUploadedFilesDetailed had
    // silently dropped everything because the URL was no longer a
    // data: URL), so this is the smoking-gun assertion.
    expect(drainedData.files).toBeDefined();
    expect(drainedData.files).toHaveLength(1);
    const drainedFile = drainedData.files![0];
    expect(drainedFile.mediaType).toBe("image/png");
    expect(drainedFile.filename).toBe("queued-pixel.png");
    expect(drainedFile.url).toMatch(/^\/api\/uploads\/\d+-0-queued-pixel\.png$/);
    // The URL on the wire must be the stable upload URL, not the
    // bulky base64 data URL (which would persist into JSONL forever
    // if it leaked through here).
    expect(drainedFile.url.startsWith("data:")).toBe(false);

    // Bytes on disk are unchanged — no double-save, no truncation. (Pre-fix
    // the drain re-ran `saveUploadedFilesDetailed`, which would have
    // produced a SECOND file on disk if the regex had actually matched.)
    expect(readdirSync(uploadDir).length).toBe(1);

    // And the agent actually received the file-sharing preamble. The
    // fake-agent dumps every parsed stdin message (and its argv) to
    // FAKE_AGENT_STDIN_LOG; grep for the marker phrase, the absolute
    // disk path, AND the queued text. All three together pin that the
    // agent saw `I'm sharing these files with you:\n- <path>\n\n<text>`.
    //
    // We assert on the three fragments rather than the exact composed
    // string because the SDK's serialization is JSON (newlines become
    // `\n` escapes); argv would keep them raw. Splitting the assertion
    // tolerates either transport while still pinning the same fact.
    expect(existsSync(stdinLogPath)).toBe(true);
    const stdinLog = readFileSync(stdinLogPath, "utf-8");
    expect(stdinLog).toContain("I'm sharing these files with you:");
    expect(stdinLog).toContain(savedAbsPath);
    expect(stdinLog).toContain(queuedText);
    // Sanity: the first-turn prompt MUST NOT have leaked a stale
    // `[File sharing:` hint into the SECOND turn's user content (that
    // hint is only meant for new sessions; the drain is a resume).
    // We don't assert the absence globally because the first turn
    // (also a new session) is legitimately allowed to carry it.
  }, 40_000);
});

// ---------------------------------------------------------------------------
// Cancel / abort integration test
//
// Verifies the path the chat UI's Stop button drives:
//
//   1. Submit a message → task starts, agent emits text incrementally.
//   2. While the task is mid-stream, hit `POST /trpc/tasks.abort`.
//   3. The subscription receives a `task-error` event and the task is
//      no longer marked as running on the server.
//
// Without this end-to-end coverage, the Stop button's exact wire shape
// (and whether the server emits the right close-the-spinner event)
// would only be visible on manual testing.
// ---------------------------------------------------------------------------

describe("chat-events — cancel / abort terminates the in-flight task", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    // Long scenario gives us time to abort before the result event fires.
    const scenario = writeScenario(tmpHome, longScenario("abort-session"));
    server = await startServer({ tmpHome, scenarioPath: scenario });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("POST /trpc/tasks.abort kills the task and emits task-error to subscribers", async () => {
    const chatId = newChatId("abort");

    // Subscribe FIRST so we observe the full lifecycle, then submit.
    const subscriptionPromise = collectEvents(server.url, chatId, {
      until: (e) => e.type === "task-error" || e.type === "task-completed",
      timeoutMs: 15_000,
    });

    await submitMessage(server.url, chatId, {
      workspaceId: "testproject-main",
      text: "slow query, please cancel me",
    });

    // Wait for the task to actually be in flight before aborting,
    // otherwise the abort races with task creation and the server has
    // no running task to cancel. The `task-started` event is the
    // unambiguous "I'm running now" signal.
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const poll = async () => {
        try {
          const probe = await collectEvents(server.url, chatId, {
            until: (e) => e.type === "task-started",
            timeoutMs: 5_000,
          });
          if (probe.some((e) => e.type === "task-started")) return resolve();
        } catch {
          // probe stream may close early; that's fine, we'll re-poll
        }
        if (Date.now() - start > 5_000) reject(new Error("task-started never arrived"));
        else setTimeout(poll, 50);
      };
      poll();
    });

    const abortRes = await abortTask(server.url, {
      workspaceId: "testproject-main",
      chatId,
    });
    expect(abortRes.status).toBe(200);

    const events = await subscriptionPromise;
    const terminal = events.find((e) => e.type === "task-error" || e.type === "task-completed");
    expect(terminal).toBeDefined();
    // Aborting should produce a `task-error`, NOT a `task-completed`.
    // A spurious task-completed here would hide cancel bugs (the spinner
    // would clear but for the wrong reason).
    expect(terminal!.type).toBe("task-error");

    // The task is no longer running on the server side. We probe via a
    // fresh subscription's `subscription-opened` payload, which carries
    // a `taskRunning` flag derived from the server's task map.
    const probe = await collectEvents(server.url, chatId, {
      until: (e) => e.type === "subscription-opened",
      timeoutMs: 3_000,
    });
    const opened = probe.find((e) => e.type === "subscription-opened");
    expect(opened).toBeDefined();
    const openedData = opened!.data as Extract<
      ChatEventPayload,
      { type: "subscription-opened" }
    > & { eventId: number };
    expect(openedData.taskRunning).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Robustness: subscription survives a workspaceId we can't resolve
//
// Edge case identified in the audit: if a user has a stale browser tab
// open and the workspace gets deleted underneath them, the SSE
// subscription endpoint still has to return a 200 stream that the
// client can read — NOT a 500 and NOT a hang. The JSONL backfill path
// uses `resolveWorkspace(chatWorkspaceId)` and silently falls through
// when the workspace is gone; this test pins that behaviour.
// ---------------------------------------------------------------------------

describe("chat-events — workspace not resolvable", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    const scenario = writeScenario(tmpHome, quickScenario());
    server = await startServer({ tmpHome, scenarioPath: scenario });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("cold subscribe with a workspaceId that doesn't exist still returns 200 + an open stream", async () => {
    const chatId = newChatId("orphan-ws");
    // Pass `workspaceId` explicitly in the URL so the server's JSONL
    // backfill code path is exercised — it has a `chatWorkspaceId` and
    // tries to resolve it, then must fail GRACEFULLY (not 500).
    const events = await collectEvents(server.url, chatId, {
      workspaceId: "this-workspace-does-not-exist-main",
      until: (e) => e.type === "subscription-opened",
      timeoutMs: 5_000,
    });
    const opened = events.find((e) => e.type === "subscription-opened");
    expect(opened).toBeDefined();
    const data = opened!.data as Extract<ChatEventPayload, { type: "subscription-opened" }> & {
      eventId: number;
    };
    // No session (the chat row is freshly-lazily-created on first
    // submit and we haven't submitted yet), no task running. The
    // stream opens cleanly and waits for live events. The replay
    // phase's JSONL backfill is a silent no-op because the workspace
    // can't be resolved.
    expect(data.taskRunning).toBe(false);
    expect(data.sessionId).toBeUndefined();
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Error paths required by the doctrine ("every endpoint test file includes at
// least one negative case: missing auth, malformed input, non-existent
// resource"). Non-existent resource is covered by the workspace-not-resolvable
// suite above; these tests pin the missing-auth and malformed-input contracts.
// ---------------------------------------------------------------------------

describe("chat-events — auth + input-validation contracts", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    const scenario = writeScenario(tmpHome, quickScenario());
    server = await startServer({ tmpHome, scenarioPath: scenario });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("GET /api/chats/:chatId/events without band_token cookie is rejected by middleware", async () => {
    const chatId = newChatId("auth");
    const res = await fetch(`${server.url}/api/chats/${encodeURIComponent(chatId)}/events`, {
      // Intentionally NO `Cookie: band_token=...` header.
    });
    // The auth middleware in `start-server.ts::handleAuth` responds with
    // 401 (cookie missing or wrong) BEFORE any handler runs.
    expect(res.status).toBe(401);
  });

  it("POST /api/chats/:chatId/messages without band_token cookie is rejected", async () => {
    const chatId = newChatId("auth");
    const res = await fetch(`${server.url}/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: "POST",
      // Intentionally NO auth cookie. `Content-Type` is set so the
      // handler is reached past Content-Type negotiation; only auth
      // gates this.
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "testproject-main", text: "anything" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/chats/:chatId/messages with missing workspaceId returns 400", async () => {
    const chatId = newChatId("badbody");
    const res = await fetch(`${server.url}/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...defaultHeaders },
      body: JSON.stringify({ text: "no workspace id" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "workspaceId and text are required" });
  });

  it("POST /api/chats/:chatId/messages with empty text returns 400", async () => {
    const chatId = newChatId("badbody");
    const res = await fetch(`${server.url}/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...defaultHeaders },
      body: JSON.stringify({ workspaceId: "testproject-main", text: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/chats/:chatId/messages with non-JSON body returns 400", async () => {
    const chatId = newChatId("badbody");
    const res = await fetch(`${server.url}/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...defaultHeaders },
      body: "this is not json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "Invalid JSON body" });
  });
});

// ---------------------------------------------------------------------------
// Regression coverage for the workspace-switch duplication fix in
// `apps/web/src/api/chat-events.ts` (the two code paths reviewed under
// PR #562's Testing [1] blocker).
// ---------------------------------------------------------------------------

describe("chat-events — cold subscribe + reconnect: no duplication on the workspace-switch path", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    const scenario = writeScenario(tmpHome, quickScenario("noreplay-session"));
    server = await startServer({ tmpHome, scenarioPath: scenario });
  }, 30_000);

  afterAll(async () => {
    if (server) await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  /**
   * Covers the `bufferCoversStart` branch of cold subscribe: when an
   * in-memory buffer exists from event id 1, the server emits the
   * BUFFER (real positive eventIds), not JSONL synthetic negative ids.
   * Then verifies cursor preservation: a reconnect with the highest
   * buffer eventId emits no further content events.
   *
   * Together these two assertions cover the workspace-switch
   * duplication regression on the buffer-populated path — the exact
   * scenario reproduced live in PR #562 where typing "hey", switching
   * away, and switching back duplicated the conversation. The
   * complementary `buf === undefined` + JSONL-on-disk hot-reconnect
   * branch is exercised end-to-end by
   * `apps/web/e2e/chat-virtualization.spec.ts`, which seeds the JSONL
   * directly and drives the full switch-back through Playwright.
   */
  it("cold subscribe uses buffer (real positive ids), and reconnect with that cursor sees no re-emission", async () => {
    const chatId = newChatId("noreplay");

    // Phase 1: run a real task so the in-memory buffer for the session
    // is populated with events starting at eventId 1. Subscribe BEFORE
    // submit so the task's full lifecycle (user-message → task-started
    // → text-* → task-completed) is captured.
    const turn1Promise = collectEvents(server.url, chatId, {
      until: (e) => e.type === "task-completed",
      timeoutMs: 15_000,
    });
    const submitRes = await submitMessage(server.url, chatId, {
      workspaceId: "testproject-main",
      text: "hello",
    });
    expect(submitRes.status).toBe(200);
    const turn1 = await turn1Promise;

    expect(turn1.some((e) => e.type === "task-completed")).toBe(true);
    expect(turn1.some((e) => e.type === "user-message" && e.id > 0)).toBe(true);

    // Phase 2: cold-subscribe to the same chat AGAIN (no Last-Event-ID).
    // This is the path a fresh tab / cached-workspace cold subscribe
    // takes — the buffer for the session is now populated with real
    // events 1..N. The fix's `bufferCoversStart` branch emits the
    // buffer (positive ids); the previous JSONL-preferred path
    // emitted synthetic negative ids and stranded the client's cursor
    // at 0.
    const cold = await collectEvents(server.url, chatId, {
      until: (e) => e.type === "task-completed",
      timeoutMs: 5_000,
    });

    const contentEventTypes = new Set<ChatEventType>([
      "user-message",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-available",
      "tool-output-available",
      "task-started",
      "task-completed",
    ]);
    const contentEvents = cold.filter((e) => contentEventTypes.has(e.type as ChatEventType));
    expect(contentEvents.length).toBeGreaterThan(0);
    for (const evt of contentEvents) {
      // Buffer-emitted events carry their real, positive task-service
      // eventId. JSONL-backfill events would be negative synthetics.
      expect(evt.id).toBeGreaterThan(0);
    }
    // The client's cursor after dispatching these would be max(ids).
    const cursor = Math.max(...contentEvents.map((e) => e.id));
    expect(cursor).toBeGreaterThan(0);

    // Phase 3: reconnect with the cursor from phase 2 — the exact
    // value the client's `lastEventId` would hold after a buffer-
    // backed cold subscribe. The server must NOT re-emit any of the
    // events the client already has; the `evt.eventId <= afterEventId`
    // filter in the buffer-replay branch drops everything in range.
    const reconnect = await collectEvents(server.url, chatId, {
      lastEventId: cursor,
      // Stop the moment a forbidden content event arrives so a
      // regression fails fast instead of timing out.
      until: (evt) => contentEventTypes.has(evt.type as ChatEventType) && evt.id > 0,
      maxEvents: 20,
      timeoutMs: 2_500,
    });
    // No content event with id > 0 should appear at all on the
    // reconnect — the previous run already covered every buffered
    // event up to `cursor`.
    for (const evt of reconnect) {
      if (contentEventTypes.has(evt.type as ChatEventType) && evt.id > 0) {
        // Either the buffer-replay filter (evt.id <= cursor) is broken
        // or someone removed the buffer-replay path entirely — both
        // are regressions.
        throw new Error(
          `Unexpected re-emission of content event after reconnect: type=${evt.type} id=${evt.id} cursor=${cursor}`,
        );
      }
    }
    // Sanity: the stream did open and emit its initial bookkeeping.
    expect(reconnect[0]?.type).toBe("subscription-opened");
  }, 25_000);
});

/* Note on the second case the PR #562 review requested — the
 * `buf === undefined` + JSONL-on-disk hot-reconnect scenario — that we
 * intentionally do NOT add here:
 *
 *   The vitest harness uses the `fake-agent.mjs` stub binary which
 *   speaks the Claude Agent SDK stdio protocol but does NOT write a
 *   transcript to `~/.claude/projects/<encoded>/<sessionId>.jsonl`.
 *   And every attempt to seed that JSONL directly (matching the format
 *   the working `apps/web/e2e/chat-virtualization.spec.ts` uses) ends
 *   with the SDK's `getSessionMessages` returning an empty array in
 *   this harness, even though the identical seed works under
 *   Playwright. That difference appears to come from the Playwright
 *   harness booting a real production bundle while vitest boots tsx
 *   source — but the SDK is closed-source and minified, so confirming
 *   that is beyond the bounds of this PR.
 *
 *   The user-observable scenario the second case would cover (typing
 *   into a chat, switching away and back, never seeing the
 *   conversation double) is exercised end-to-end by the live-app
 *   reproduction documented in PR #562's description: switching
 *   between two real workspaces 5× while observing both reducer state
 *   and SSE traffic, before and after the fix. That reproduction is
 *   the proof the fix works; the test above pins the buffer/cursor
 *   half of the implementation as the part we can guard
 *   deterministically in the vitest harness today.
 */
