import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { seedSettings, seedState } from "./helpers/seed-state";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const FAKE_AGENT_PATH = join(import.meta.dirname, "fake-agent.mjs");
const DEFAULT_TOKEN = "gapfill-test-token";

// ---------------------------------------------------------------------------
// Helpers (same patterns as chat.test.ts)
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = mkdtempSync(join(tmpdir(), "band-gapfill-test-"));
  const bandDir = join(tmp, ".band");
  mkdirSync(bandDir, { recursive: true });
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
    codingAgent: {
      type: "claude-code",
      command: FAKE_AGENT_PATH,
    },
  };
}

async function startServer(
  opts: { tmpHome?: string; scenarioPath?: string; env?: Record<string, string> } = {},
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
        ...opts.env,
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
        reject(new Error(`Server did not start within 15 s.\nstderr: ${stderr}`));
      }
    }, 15_000);
  });
}

// ---------------------------------------------------------------------------
// tRPC HTTP helpers
// ---------------------------------------------------------------------------

const defaultHeaders = { Cookie: `band_token=${DEFAULT_TOKEN}` };

async function trpcQuery(
  serverUrl: string,
  procedure: string,
  input?: unknown,
  opts?: { headers?: Record<string, string> },
) {
  const url =
    input !== undefined
      ? `${serverUrl}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${serverUrl}/trpc/${procedure}`;
  return fetch(url, { headers: { ...defaultHeaders, ...opts?.headers } });
}

async function trpcMutate(
  serverUrl: string,
  procedure: string,
  input?: unknown,
  opts?: { headers?: Record<string, string> },
) {
  return fetch(`${serverUrl}/trpc/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...defaultHeaders, ...opts?.headers },
    body: input !== undefined ? JSON.stringify(input) : "{}",
  });
}

async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

interface SSEEvent {
  event: string | null;
  data: unknown;
}

async function parseTrpcSSEStream(response: Response): Promise<SSEEvent[]> {
  const text = await response.text();
  const events: SSEEvent[] = [];

  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }

    const envelope = data as Record<string, unknown>;
    const result = envelope?.result as Record<string, unknown> | undefined;
    if (result?.type === "data" && result.data !== undefined) {
      data = result.data;
    }

    const event =
      typeof data === "object" && data !== null
        ? ((data as Record<string, unknown>).type as string)
        : null;
    if (event) {
      events.push({ event, data });
    }
  }

  return events;
}

async function trpcSubscription(
  serverUrl: string,
  procedure: string,
  input: unknown,
  opts?: { headers?: Record<string, string> },
): Promise<Response> {
  const url = `${serverUrl}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;
  return fetch(url, {
    headers: { ...defaultHeaders, ...opts?.headers },
  });
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

interface WSMessage {
  id: number;
  jsonrpc: string;
  result?: { type: string; data?: unknown };
  error?: unknown;
}

function _wsSubscribe(
  serverUrl: string,
  procedure: string,
  input: unknown,
  opts?: { headers?: Record<string, string>; timeoutMs?: number },
): Promise<{ messages: WSMessage[]; events: SSEEvent[] }> {
  const wsUrl = `${serverUrl.replace(/^http/, "ws")}/trpc`;
  const timeout = opts?.timeoutMs ?? 10_000;

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: opts?.headers ?? defaultHeaders });
    const messages: WSMessage[] = [];
    const events: SSEEvent[] = [];
    let timer: ReturnType<typeof setTimeout>;

    function finish() {
      clearTimeout(timer);
      ws.close();
      resolve({ messages, events });
    }

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "subscription",
          params: { path: procedure, input },
        }),
      );
    });

    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as WSMessage;
      messages.push(msg);

      if (msg.result?.type === "data" && msg.result.data !== undefined) {
        const data = msg.result.data;
        const event =
          typeof data === "object" && data !== null
            ? ((data as Record<string, unknown>).type as string)
            : null;
        if (event) {
          events.push({ event, data });
        }
      }

      if (msg.result?.type === "stopped") {
        finish();
      }
    });

    ws.on("error", () => finish());
    ws.on("close", () => finish());
    timer = setTimeout(finish, timeout);
  });
}

// ---------------------------------------------------------------------------
// Standard scenario for testing
// ---------------------------------------------------------------------------

function standardScenario() {
  return [
    {
      type: "system",
      subtype: "init",
      session_id: "gapfill-session-1",
    },
    {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello from gapfill test!" }],
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Using a tool now." },
          {
            type: "tool_use",
            id: "tool-gf-1",
            name: "Read",
            input: { path: "/tmp/test.txt" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-gf-1",
            content: "file contents here",
            is_error: false,
          },
        ],
      },
    },
    {
      type: "result",
      subtype: "success",
      session_id: "gapfill-session-1",
      duration_ms: 500,
      num_turns: 1,
      total_cost_usd: 0.01,
    },
  ];
}

// ---------------------------------------------------------------------------
// Test: Stream events carry eventId
// ---------------------------------------------------------------------------

describe("Stream gap-fill — eventId on stream events", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    const scenarioPath = writeScenario(tmpHome, standardScenario());
    seedSettings(tmpHome, defaultSettings());
    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("every stream event carries a numeric eventId that is monotonically increasing", async () => {
    // Submit a task
    const submitRes = await trpcMutate(server.url, "tasks.submit", {
      workspaceId: "testproject-main",
      prompt: "hello gapfill",
    });
    expect(submitRes.status).toBe(200);

    // Stream via SSE
    const streamRes = await trpcSubscription(server.url, "tasks.stream", {
      workspaceId: "testproject-main",
    });
    const events = await parseTrpcSSEStream(streamRes);

    expect(events.length).toBeGreaterThan(0);

    // All events after session-start should have eventId (session-start
    // sets the sessionId, so the first few events before it may not have one).
    // But data-session is persisted once sessionId is set, so everything
    // from data-session onward should have eventId.
    const sessionIdx = events.findIndex((e) => e.event === "data-session");
    expect(sessionIdx).toBeGreaterThanOrEqual(0);

    const eventsAfterSession = events.slice(sessionIdx);
    const eventIds = eventsAfterSession
      .map((e) => (e.data as Record<string, unknown>).eventId)
      .filter((id) => typeof id === "number") as number[];

    // Should have eventIds on most events
    expect(eventIds.length).toBeGreaterThan(0);

    // eventIds should be monotonically increasing
    for (let i = 1; i < eventIds.length; i++) {
      expect(eventIds[i]).toBeGreaterThan(eventIds[i - 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// Test: sessions.messages returns UIMessages with pagination
// ---------------------------------------------------------------------------

describe("Stream gap-fill — sessions.messages", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    const scenarioPath = writeScenario(tmpHome, standardScenario());
    seedSettings(tmpHome, defaultSettings());
    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns UIMessages with pagination metadata after task completes", async () => {
    // Submit and stream to completion
    const submitRes = await trpcMutate(server.url, "tasks.submit", {
      workspaceId: "testproject-main",
      prompt: "test messages endpoint",
    });
    expect(submitRes.status).toBe(200);

    // Wait for the stream to complete
    const streamRes = await trpcSubscription(server.url, "tasks.stream", {
      workspaceId: "testproject-main",
    });
    const events = await parseTrpcSSEStream(streamRes);
    expect(events.some((e) => e.event === "finish")).toBe(true);

    // Now query the messages endpoint
    const messagesRes = await trpcQuery(server.url, "sessions.messages", {
      workspaceId: "testproject-main",
      sessionId: "gapfill-session-1",
    });
    expect(messagesRes.status).toBe(200);

    const data = await trpcData<{
      messages: unknown[];
      firstEventId: number | null;
      lastEventId: number | null;
      hasMore: boolean;
    }>(messagesRes);

    // Should have converted UIMessages
    expect(data.messages.length).toBeGreaterThan(0);

    // Should have pagination metadata
    expect(typeof data.firstEventId).toBe("number");
    expect(typeof data.lastEventId).toBe("number");
    expect(data.lastEventId!).toBeGreaterThanOrEqual(data.firstEventId!);
    expect(typeof data.hasMore).toBe("boolean");

    // Messages should have the right structure
    const firstMsg = data.messages[0] as { id: string; role: string; parts: unknown[] };
    expect(firstMsg).toHaveProperty("id");
    expect(firstMsg).toHaveProperty("role");
    expect(firstMsg).toHaveProperty("parts");
  });

  it("supports pagination with beforeEventId", async () => {
    // First query with a small limit
    const firstPageRes = await trpcQuery(server.url, "sessions.messages", {
      workspaceId: "testproject-main",
      sessionId: "gapfill-session-1",
      limit: 3,
    });
    expect(firstPageRes.status).toBe(200);

    const firstPage = await trpcData<{
      messages: unknown[];
      firstEventId: number | null;
      lastEventId: number | null;
      hasMore: boolean;
    }>(firstPageRes);

    // If there are enough events, hasMore should be true
    if (firstPage.hasMore && firstPage.firstEventId != null) {
      // Fetch the previous page
      const prevPageRes = await trpcQuery(server.url, "sessions.messages", {
        workspaceId: "testproject-main",
        sessionId: "gapfill-session-1",
        beforeEventId: firstPage.firstEventId,
        limit: 3,
      });
      expect(prevPageRes.status).toBe(200);

      const prevPage = await trpcData<{
        messages: unknown[];
        firstEventId: number | null;
        lastEventId: number | null;
        hasMore: boolean;
      }>(prevPageRes);

      // Previous page should have events earlier than first page
      if (prevPage.lastEventId != null && firstPage.firstEventId != null) {
        expect(prevPage.lastEventId).toBeLessThan(firstPage.firstEventId);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Test: Gap-fill replays missed events
// ---------------------------------------------------------------------------

describe("Stream gap-fill — replay missed events", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    const scenarioPath = writeScenario(tmpHome, standardScenario());
    seedSettings(tmpHome, defaultSettings());
    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("replays missed events when subscribing with afterEventId", async () => {
    // Submit a task and stream to completion, collecting eventIds
    const submitRes = await trpcMutate(server.url, "tasks.submit", {
      workspaceId: "testproject-main",
      prompt: "first task for gapfill",
    });
    expect(submitRes.status).toBe(200);

    const streamRes = await trpcSubscription(server.url, "tasks.stream", {
      workspaceId: "testproject-main",
    });
    const events = await parseTrpcSSEStream(streamRes);
    expect(events.some((e) => e.event === "finish")).toBe(true);

    // Collect all eventIds
    const allEventIds = events
      .map((e) => (e.data as Record<string, unknown>).eventId)
      .filter((id) => typeof id === "number") as number[];

    expect(allEventIds.length).toBeGreaterThan(2);

    // Pick an afterEventId from the middle
    const midIndex = Math.floor(allEventIds.length / 2);
    const afterEventId = allEventIds[midIndex];

    // Subscribe with afterEventId — should replay events after that point
    // Since the task already completed and no new task is running, the
    // subscription will replay DB events and then end (no live task).
    const replayRes = await trpcSubscription(server.url, "tasks.stream", {
      workspaceId: "testproject-main",
      sessionId: "gapfill-session-1",
      afterEventId,
    });
    const replayEvents = await parseTrpcSSEStream(replayRes);

    // Replayed events should all have eventId > afterEventId
    const replayedIds = replayEvents
      .map((e) => (e.data as Record<string, unknown>).eventId)
      .filter((id) => typeof id === "number") as number[];

    for (const id of replayedIds) {
      expect(id).toBeGreaterThan(afterEventId);
    }

    // Should have replayed the events that were after our midpoint
    const expectedIds = allEventIds.filter((id) => id > afterEventId);
    expect(replayedIds).toEqual(expectedIds);
  });
});
