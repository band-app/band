/**
 * Integration tests for the SSE stream reconnect path that backs the
 * `ChatView` thinking indicator after a workspace switch.
 *
 * The bug being guarded against (issue #348): `GET /api/tasks/:chatId/stream`
 * returns 204 when no in-memory task is registered. The Vercel AI SDK
 * silently treats that as "nothing to resume" and `useChat.status` stays at
 * `"ready"`, leaving the user with no thinking indicator even though the
 * agent is still running. The fix has two pieces:
 *
 *   1. A new `tasks.isRunning` server query so the client can distinguish
 *      "give up cleanly" from "keep retrying".
 *   2. A retry loop in `ChatView` that drives `resumeStream()` until the
 *      stream attaches, the server says nothing's running, or the budget
 *      is exhausted.
 *
 * These tests exercise the server contract the client retry depends on:
 * tRPC `tasks.isRunning` reports the right state across the task lifecycle,
 * the GET endpoint returns 204 vs 200 in the right places, and a client
 * that polls `tasks.isRunning + GET /stream` mid-flight will eventually
 * receive a streamable response (the recovery path the retry loop relies
 * on).
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const FAKE_AGENT_PATH = join(import.meta.dirname, "fake-agent.mjs");
const DEFAULT_TOKEN = "stream-reconnect-test-token";

// ---------------------------------------------------------------------------
// Test scaffolding (mirrors stream-gapfill.test.ts conventions)
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = mkdtempSync(join(tmpdir(), "band-reconnect-test-"));
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
  opts: { tmpHome?: string; scenarioPath?: string } = {},
): Promise<ServerHandle> {
  const home = opts.tmpHome || createTmpHome();
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn("node", ["dist/start-server.mjs"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: home,
        PORT: String(port),
        NODE_ENV: "production",
        FAKE_AGENT_SCENARIO: opts.scenarioPath || "",
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

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const defaultHeaders = { Cookie: `band_token=${DEFAULT_TOKEN}` };

async function trpcQuery(serverUrl: string, procedure: string, input?: unknown) {
  const url =
    input !== undefined
      ? `${serverUrl}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${serverUrl}/trpc/${procedure}`;
  return fetch(url, { headers: defaultHeaders });
}

async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

function newChatId(prefix = "reconnect"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function getStream(
  serverUrl: string,
  chatId: string,
  opts?: { signal?: AbortSignal },
): Promise<Response> {
  return fetch(`${serverUrl}/api/tasks/${encodeURIComponent(chatId)}/stream`, {
    method: "GET",
    headers: defaultHeaders,
    signal: opts?.signal,
  });
}

async function postStream(
  serverUrl: string,
  chatId: string,
  workspaceId: string,
  prompt: string,
  opts?: { signal?: AbortSignal },
): Promise<Response> {
  return fetch(`${serverUrl}/api/tasks/${encodeURIComponent(chatId)}/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...defaultHeaders },
    body: JSON.stringify({ workspaceId, prompt }),
    signal: opts?.signal,
  });
}

async function isRunning(serverUrl: string, chatId: string): Promise<boolean> {
  const res = await trpcQuery(serverUrl, "tasks.isRunning", {
    workspaceId: "testproject-main",
    chatId,
  });
  if (res.status !== 200) return false;
  const data = await trpcData<{ running: boolean }>(res);
  return data.running;
}

/**
 * Drain an SSE response body. Returns the parsed event types so callers can
 * assert on them. Used to drive a stream to completion so we can observe
 * the task transitioning out of "running".
 */
async function drainEvents(response: Response): Promise<string[]> {
  if (!response.body) return [];
  const events: string[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      while (true) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        try {
          const data = JSON.parse(raw) as { type?: string };
          if (data.type) events.push(data.type);
        } catch {
          // not JSON
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return events;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/**
 * A scenario that pauses for ~1.5s in the middle so the task stays in the
 * "running" state long enough for a separate GET reconnect to land while
 * it's still active.
 */
function longRunningScenario(sessionId = "reconnect-session-long") {
  return [
    { type: "system", subtype: "init", session_id: sessionId },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "starting work" }] },
    },
    { _sleep_ms: 1500 },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "finishing up" }] },
    },
    {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      duration_ms: 1500,
      num_turns: 1,
      total_cost_usd: 0.01,
    },
  ];
}

/** A short scenario that completes near-instantly. */
function quickScenario(sessionId = "reconnect-session-quick") {
  return [
    { type: "system", subtype: "init", session_id: sessionId },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "all done" }] },
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

// ---------------------------------------------------------------------------
// tasks.isRunning lifecycle
// ---------------------------------------------------------------------------

describe("tasks.isRunning — lifecycle", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    const scenarioPath = writeScenario(tmpHome, longRunningScenario());
    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns running=false when no task has ever run for the chat", async () => {
    const chatId = newChatId("never");
    expect(await isRunning(server.url, chatId)).toBe(false);
  });

  it("returns running=true mid-task and running=false after completion", async () => {
    const chatId = newChatId("lifecycle");

    // Kick off a long-running task in the background.
    const streamPromise = postStream(server.url, chatId, "testproject-main", "lifecycle test");

    // Poll briefly until the task registers in the in-memory task map.
    // We can't predict the exact moment, but the registration window is
    // usually <300ms in practice — generous timeout for CI variance.
    const deadline = Date.now() + 5000;
    let observedRunning = false;
    while (Date.now() < deadline) {
      if (await isRunning(server.url, chatId)) {
        observedRunning = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(observedRunning).toBe(true);

    // Drain the stream to completion so the task transitions out of running.
    const response = await streamPromise;
    expect(response.status).toBe(200);
    await drainEvents(response);

    // Once the task finishes, isRunning should flip to false.
    // Allow a brief window for the post-finish bookkeeping.
    let observedDone = false;
    const doneDeadline = Date.now() + 3000;
    while (Date.now() < doneDeadline) {
      if (!(await isRunning(server.url, chatId))) {
        observedDone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(observedDone).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET reconnect contract — 200 mid-task, 204 after completion
// ---------------------------------------------------------------------------

describe("GET /api/tasks/:chatId/stream — reconnect contract", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    const scenarioPath = writeScenario(tmpHome, longRunningScenario("reconnect-session-mid"));
    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns 204 immediately when no task has ever run for the chat", async () => {
    const chatId = newChatId("never-run");
    const res = await getStream(server.url, chatId);
    expect(res.status).toBe(204);
    // Drain the (empty) body so the connection cleans up.
    await res.text();
  });

  it("simulates the client's first-attempt-204 → registered → 200 race", async () => {
    // The bug: a fast workspace switch can hit the GET endpoint before the
    // POST (or background submit) has had time to register the task in the
    // in-memory task map. The endpoint returns 204 for that brief window
    // and the AI SDK then silently gives up. The fix is the client-side
    // retry loop. From the server's perspective we just need to verify
    // that:
    //   - a GET that arrives BEFORE registration sees 204
    //   - the same chatId becomes streamable once registration completes
    //
    // We can't easily force the registration delay without timing tricks,
    // so instead we use a chatId that's guaranteed not to have a task yet,
    // assert 204, then start one and assert that a subsequent GET returns
    // a streaming 200 (the path the retry loop drives).

    const chatId = newChatId("race");

    // Step 1: GET before any task → 204 (the silent-failure path).
    const earlyRes = await getStream(server.url, chatId);
    expect(earlyRes.status).toBe(204);
    await earlyRes.text();

    // Step 2: kick off a long-running task.
    const postPromise = postStream(server.url, chatId, "testproject-main", "race test");

    // Step 3: wait until the task registers, then re-attempt the GET.
    // This mirrors the second iteration of the retry loop.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await isRunning(server.url, chatId)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await isRunning(server.url, chatId)).toBe(true);

    // Step 4: GET should now succeed and stream events. This is the
    // recovery the retry loop relies on.
    const reconnect = await getStream(server.url, chatId);
    expect(reconnect.status).toBe(200);
    expect(reconnect.headers.get("content-type")?.toLowerCase()).toContain("text/event-stream");

    // Drain both responses so the test cleans up.
    const reconnectEvents = await drainEvents(reconnect);
    expect(reconnectEvents.length).toBeGreaterThan(0);
    const original = await postPromise;
    expect(original.status).toBe(200);
    await drainEvents(original);
  });

  it("returns 204 again once the task has fully completed", async () => {
    // Run a short scenario all the way through, then GET should be 204.
    const chatId = newChatId("post-complete");
    const post = await postStream(
      server.url,
      chatId,
      "testproject-main",
      "complete then reconnect",
    );
    expect(post.status).toBe(200);
    await drainEvents(post);

    // Wait for the task to be deregistered from the running set.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (!(await isRunning(server.url, chatId))) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await isRunning(server.url, chatId)).toBe(false);

    const reconnect = await getStream(server.url, chatId);
    expect(reconnect.status).toBe(204);
    await reconnect.text();
  });
});

// ---------------------------------------------------------------------------
// "Retry then give up" — repeated polling against a non-running chat
// ---------------------------------------------------------------------------

describe("client-style retry — bounded give-up", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    const scenarioPath = writeScenario(tmpHome, quickScenario());
    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("a client polling tasks.isRunning + GET /stream gives up cleanly when nothing runs", async () => {
    const chatId = newChatId("never-runs");

    // Mimic the production retry loop: up to N iterations, each does
    // GET → check 204, then ask isRunning, and bail when running=false.
    const maxIters = 5;
    let getCalls = 0;
    let isRunningCalls = 0;
    let gaveUp = false;

    for (let i = 0; i < maxIters; i++) {
      const res = await getStream(server.url, chatId);
      getCalls++;
      expect(res.status).toBe(204);
      await res.text();

      isRunningCalls++;
      if (!(await isRunning(server.url, chatId))) {
        gaveUp = true;
        break;
      }

      // Tiny pause to mimic the client's backoff so we don't hammer.
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(gaveUp).toBe(true);
    // Should have given up on the very first iteration: one GET, one
    // isRunning round-trip. This is the contract the retry loop relies on
    // — when the server says "nothing's running" we don't keep retrying.
    expect(getCalls).toBe(1);
    expect(isRunningCalls).toBe(1);
  });
});
