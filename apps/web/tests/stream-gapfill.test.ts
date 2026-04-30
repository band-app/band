import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    codingAgents: [
      { id: "claude-code", type: "claude-code", label: "Claude Code", command: FAKE_AGENT_PATH },
    ],
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

async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

// ---------------------------------------------------------------------------
// SSE helpers (AI SDK UIMessageStream format)
// ---------------------------------------------------------------------------

interface SSEEvent {
  event: string | null;
  data: unknown;
}

/**
 * Parse an AI SDK SSE stream response into an array of { event, data } objects.
 */
async function parseSSEStream(response: Response): Promise<SSEEvent[]> {
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

/**
 * Submit a task via the SSE POST endpoint and wait for the stream to complete.
 */
async function submitAndStream(
  serverUrl: string,
  workspaceId: string,
  prompt: string,
): Promise<{ response: Response; events: SSEEvent[] }> {
  const chatId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await fetch(`${serverUrl}/api/tasks/${encodeURIComponent(chatId)}/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...defaultHeaders },
    body: JSON.stringify({ workspaceId, prompt }),
  });
  if (!response.ok) return { response, events: [] };
  const events = await parseSSEStream(response);
  return { response, events };
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
// Test: SSE stream contains expected event types
// ---------------------------------------------------------------------------

describe("Stream gap-fill — SSE stream events", () => {
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

  it("streams events including data-session, text-delta, and finish", async () => {
    const { response, events } = await submitAndStream(
      server.url,
      "testproject-main",
      "hello gapfill",
    );
    expect(response.status).toBe(200);
    expect(events.length).toBeGreaterThan(0);

    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("data-session");
    expect(eventTypes).toContain("text-delta");
    expect(eventTypes).toContain("finish");
  });

  it("persists events with monotonically increasing eventIds in session store", async () => {
    // Submit and stream to completion
    const { response } = await submitAndStream(server.url, "testproject-main", "eventid test");
    expect(response.status).toBe(200);

    // Verify via sessions.messages that eventIds are sequential
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

    expect(typeof data.firstEventId).toBe("number");
    expect(typeof data.lastEventId).toBe("number");
    expect(data.lastEventId!).toBeGreaterThan(data.firstEventId!);
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
    // Submit and stream to completion via SSE
    const { response, events } = await submitAndStream(
      server.url,
      "testproject-main",
      "test messages endpoint",
    );
    expect(response.status).toBe(200);
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
// Test: Gap-fill — sessions.messages supports pagination for replay
// ---------------------------------------------------------------------------

describe("Stream gap-fill — pagination for history replay", () => {
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

  it("returns paginated subsets of events via beforeEventId", async () => {
    // Submit and stream to completion
    const { response } = await submitAndStream(
      server.url,
      "testproject-main",
      "first task for gapfill",
    );
    expect(response.status).toBe(200);

    // Get all messages
    const allRes = await trpcQuery(server.url, "sessions.messages", {
      workspaceId: "testproject-main",
      sessionId: "gapfill-session-1",
    });
    const allData = await trpcData<{
      messages: unknown[];
      firstEventId: number | null;
      lastEventId: number | null;
      hasMore: boolean;
    }>(allRes);

    expect(allData.messages.length).toBeGreaterThan(0);
    expect(typeof allData.firstEventId).toBe("number");
    expect(typeof allData.lastEventId).toBe("number");

    // Fetch a page before the last event
    const midEventId = Math.floor((allData.firstEventId! + allData.lastEventId!) / 2);
    const pageRes = await trpcQuery(server.url, "sessions.messages", {
      workspaceId: "testproject-main",
      sessionId: "gapfill-session-1",
      beforeEventId: midEventId + 1,
      limit: 100,
    });
    const pageData = await trpcData<{
      messages: unknown[];
      firstEventId: number | null;
      lastEventId: number | null;
      hasMore: boolean;
    }>(pageRes);

    // Page should only contain events up to midEventId
    if (pageData.lastEventId != null) {
      expect(pageData.lastEventId).toBeLessThanOrEqual(midEventId);
    }
  });

  it("GET SSE endpoint returns 204 when no task is running", async () => {
    // After the task from the previous test completed, reconnecting
    // should return 204 since no task is active.
    const chatId = `test-completed-${Date.now()}`;
    const res = await fetch(`${server.url}/api/tasks/${encodeURIComponent(chatId)}/stream`, {
      method: "GET",
      headers: defaultHeaders,
    });
    expect(res.status).toBe(204);
  });
});
