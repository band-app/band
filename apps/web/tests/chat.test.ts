import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const FAKE_AGENT_PATH = join(import.meta.dirname, "fake-agent.mjs");
const DEFAULT_TOKEN = "chat-test-token";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = mkdtempSync(join(tmpdir(), "band-test-"));
  const bandDir = join(tmp, ".band");
  mkdirSync(bandDir, { recursive: true });
  mkdirSync(join(bandDir, "status"), { recursive: true });
  return tmp;
}

function seedState(tmpHome: string, state: object): void {
  writeFileSync(join(tmpHome, ".band", "state.json"), JSON.stringify(state));
}

function seedSettings(tmpHome: string, settings: object): void {
  writeFileSync(join(tmpHome, ".band", "settings.json"), JSON.stringify(settings));
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

/**
 * Start the real production server as a subprocess with HOME pointing
 * to a temp directory for state isolation.
 */
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
// SSE helpers (tRPC subscription SSE format)
// ---------------------------------------------------------------------------

interface SSEEvent {
  event: string | null;
  data: unknown;
}

/**
 * Parse a tRPC SSE subscription response into an array of { event, data } objects.
 *
 * tRPC wraps subscription data in: data: {"id":null,"result":{"type":"data","data":<actual>}}
 * We unwrap the actual data and extract the `type` field as the event name.
 */
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

    // tRPC SSE sends yielded objects directly in data: lines.
    // Also handle tRPC envelope format: { result: { type: "data", data: <actual> } }
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

/**
 * Open a tRPC subscription for the tasks.stream procedure via raw HTTP.
 */
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

/**
 * Submit a task via tRPC and wait for the SSE stream to complete.
 * Returns the tRPC submit response, SSE stream response, and events.
 */
async function submitAndStream(
  serverUrl: string,
  workspaceId: string,
  prompt: string,
): Promise<{ submitRes: Response; streamRes: Response; events: SSEEvent[] }> {
  const submitRes = await trpcMutate(serverUrl, "tasks.submit", { workspaceId, prompt });

  if (!submitRes.ok) {
    return { submitRes, streamRes: submitRes, events: [] };
  }

  // Give the task a moment to start producing events
  await new Promise((r) => setTimeout(r, 100));

  const streamRes = await trpcSubscription(serverUrl, "tasks.stream", { workspaceId });
  const events = await parseTrpcSSEStream(streamRes);

  return { submitRes, streamRes, events };
}

// ---------------------------------------------------------------------------
// WebSocket helpers (tRPC JSON-RPC over WebSocket)
// ---------------------------------------------------------------------------

interface WSMessage {
  id: number;
  jsonrpc: string;
  result?: { type: string; data?: unknown };
  error?: unknown;
}

/**
 * Subscribe to a tRPC procedure over WebSocket and collect data messages.
 * Returns collected data events once the subscription completes or times out.
 */
function wsSubscribe(
  serverUrl: string,
  procedure: string,
  input: unknown,
  opts?: { headers?: Record<string, string>; timeoutMs?: number },
): Promise<{ messages: WSMessage[]; events: SSEEvent[] }> {
  const wsUrl = `${serverUrl.replace(/^http/, "ws")}/trpc`;
  const timeout = opts?.timeoutMs ?? 5000;

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

      // "stopped" means the subscription completed server-side
      if (msg.result?.type === "stopped") {
        finish();
      }
    });

    ws.on("error", () => finish());
    ws.on("close", () => finish());
    timer = setTimeout(finish, timeout);
  });
}

/**
 * Submit a task and stream results over WebSocket.
 */
async function wsSubmitAndStream(
  serverUrl: string,
  workspaceId: string,
  prompt: string,
): Promise<{ submitRes: Response; events: SSEEvent[] }> {
  const submitRes = await trpcMutate(serverUrl, "tasks.submit", { workspaceId, prompt });

  if (!submitRes.ok) {
    return { submitRes, events: [] };
  }

  await new Promise((r) => setTimeout(r, 100));

  const { events } = await wsSubscribe(serverUrl, "tasks.stream", { workspaceId });
  return { submitRes, events };
}

// ---------------------------------------------------------------------------
// tasks.stream — No active task
// ---------------------------------------------------------------------------

describe("tasks.stream — no active task", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("completes immediately with no data events when no task exists", async () => {
    const streamRes = await trpcSubscription(server.url, "tasks.stream", {
      workspaceId: "testproject-main",
    });
    expect(streamRes.status).toBe(200);
    const events = await parseTrpcSSEStream(streamRes);
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// tasks.submit — Validation
// ---------------------------------------------------------------------------

describe("tasks.submit — validation", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns 400 when workspaceId is missing", async () => {
    const res = await trpcMutate(server.url, "tasks.submit", { prompt: "hello" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when prompt is missing", async () => {
    const res = await trpcMutate(server.url, "tasks.submit", {
      workspaceId: "testproject-main",
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Task submit + stream — Streaming
// ---------------------------------------------------------------------------

describe("Task submit + stream — streaming", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const scenarioPath = writeScenario(tmpHome, [
      {
        type: "system",
        subtype: "init",
        session_id: "test-session-123",
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello from the agent!" }],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Hello from the agent!" },
            {
              type: "tool_use",
              id: "tool-1",
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
              tool_use_id: "tool-1",
              content: "file contents here",
              is_error: false,
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "test-session-123",
        duration_ms: 1234,
        num_turns: 2,
        total_cost_usd: 0.05,
      },
    ]);

    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgent: { type: "claude-code", command: FAKE_AGENT_PATH },
    });

    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns 200 on submit and streams UIMessageChunk events", async () => {
    const { submitRes, streamRes, events } = await submitAndStream(
      server.url,
      "testproject-main",
      "hello",
    );
    expect(submitRes.status).toBe(200);
    expect(streamRes.status).toBe(200);

    const contentType = streamRes.headers.get("content-type")!;
    expect(contentType).toContain("text/event-stream");

    const eventTypes = events.map((e) => e.event).filter(Boolean) as string[];

    expect(eventTypes).toContain("data-session");
    expect(eventTypes).toContain("text-delta");
    expect(eventTypes).toContain("tool-input-available");
    expect(eventTypes).toContain("tool-output-available");
    expect(eventTypes).toContain("data-result");
    expect(eventTypes).toContain("finish");
  });
});

// ---------------------------------------------------------------------------
// Task submit + stream — Agent failure
// ---------------------------------------------------------------------------

describe("Task submit + stream — agent failure", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const scenarioPath = writeScenario(tmpHome, [
      {
        type: "system",
        subtype: "init",
        session_id: "fail-session",
      },
      {
        type: "result",
        subtype: "failure",
        session_id: "fail-session",
        duration_ms: 100,
        num_turns: 0,
        total_cost_usd: 0,
        errors: ["Something went wrong"],
      },
    ]);

    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgent: { type: "claude-code", command: FAKE_AGENT_PATH },
    });

    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("stream contains error event when agent returns failure result", async () => {
    const { submitRes, events } = await submitAndStream(server.url, "testproject-main", "hello");
    expect(submitRes.status).toBe(200);

    const errorEvents = events.filter((e) => e.event === "error");
    expect(errorEvents.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Task submit + stream — Agent crash
// ---------------------------------------------------------------------------

describe("Task submit + stream — agent crash", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const scenarioPath = writeScenario(tmpHome, []);

    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgent: { type: "claude-code", command: FAKE_AGENT_PATH },
    });

    server = await startServer({
      tmpHome,
      scenarioPath,
      env: { FAKE_AGENT_EXIT_CODE: "1" },
    });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("stream contains error event when agent binary crashes", async () => {
    const { submitRes, events } = await submitAndStream(server.url, "testproject-main", "hello");
    expect(submitRes.status).toBe(200);

    const eventTypes = events.map((e) => e.event).filter(Boolean) as string[];
    const hasError = eventTypes.includes("error");
    const hasNoResult = !eventTypes.includes("data-result");
    expect(hasError || hasNoResult).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tasks.submit — Auth
// ---------------------------------------------------------------------------

describe("tasks.submit — auth", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, { ...defaultSettings(), tokenSecret: "test-token" });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns 401 when tokenSecret is set and no token provided", async () => {
    const res = await trpcMutate(server.url, "tasks.submit", {
      workspaceId: "testproject-main",
      prompt: "hello",
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// sessions.list — Validation
// ---------------------------------------------------------------------------

describe("sessions.list — validation", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns 404 when workspace does not exist", async () => {
    const res = await trpcQuery(server.url, "sessions.list", {
      workspaceId: "nonexistent-main",
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// sessions.messages — Validation
// ---------------------------------------------------------------------------

describe("sessions.messages — validation", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns 404 when workspace does not exist", async () => {
    const res = await trpcQuery(server.url, "sessions.messages", {
      workspaceId: "nonexistent-main",
      sessionId: "some-session",
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Helpers — polling
// ---------------------------------------------------------------------------

async function waitFor(
  fn: () => Promise<boolean>,
  { timeout = 10_000, interval = 100 } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await fn()) return;
    } catch {
      // ignore and retry
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timed out after ${timeout}ms`);
}

// ---------------------------------------------------------------------------
// chat.answer — Validation
// ---------------------------------------------------------------------------

describe("chat.answer — validation", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns 400 when approvalId is missing", async () => {
    const res = await trpcMutate(server.url, "chat.answer", { answers: { q: "a" } });
    expect(res.status).toBe(400);
  });

  it("returns 400 when answers are missing", async () => {
    const res = await trpcMutate(server.url, "chat.answer", { approvalId: "some-id" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when answering a non-existent approvalId", async () => {
    const res = await trpcMutate(server.url, "chat.answer", {
      approvalId: "non-existent-id",
      answers: { question: "answer" },
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Task submit + stream — AskUserQuestion
// ---------------------------------------------------------------------------

describe("Task submit + stream — AskUserQuestion", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const askInput = {
      questions: [
        {
          question: "Which approach do you prefer?",
          header: "Approach",
          options: [
            { label: "Option A", description: "First approach" },
            { label: "Option B", description: "Second approach" },
          ],
          multiSelect: false,
        },
      ],
    };

    const scenarioPath = writeScenario(tmpHome, [
      {
        type: "system",
        subtype: "init",
        session_id: "ask-session-123",
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-ask-1",
              name: "AskUserQuestion",
              input: askInput,
            },
          ],
        },
      },
      // The binary sends a control_request to the SDK asking for permission
      // to execute AskUserQuestion. The SDK calls canUseTool which blocks
      // until the user answers via chat.answer.
      {
        type: "control_request",
        request_id: "req-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          input: askInput,
          tool_use_id: "tool-ask-1",
        },
      },
      // Pause until the SDK writes the control_response back to stdin.
      { _wait_for_stdin: true },
      // After the SDK responds (deny), the binary outputs the tool result
      // and the model's follow-up response.
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-ask-1",
              content: "The user selected:\nWhich approach do you prefer?: Option A",
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Great, proceeding with your choice." }],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "ask-session-123",
        duration_ms: 5000,
        num_turns: 2,
        total_cost_usd: 0.1,
      },
    ]);

    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgent: { type: "claude-code", command: FAKE_AGENT_PATH },
    });

    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("streams AskUserQuestion tool call and resumes after chat.answer", async () => {
    const workspaceId = "testproject-main";
    const toolCallId = "tool-ask-1";

    // 1. Submit the task via tRPC
    const submitRes = await trpcMutate(server.url, "tasks.submit", {
      workspaceId,
      prompt: "test ask",
    });
    expect(submitRes.status).toBe(200);

    // 2. Poll until the pending input is created, then answer via tRPC
    await waitFor(async () => {
      const res = await trpcMutate(server.url, "chat.answer", {
        approvalId: toolCallId,
        answers: { "Which approach do you prefer?": "Option A" },
      });
      return res.ok;
    });

    // 3. Wait for the task to complete via tRPC
    await waitFor(async () => {
      const res = await trpcQuery(server.url, "tasks.get", { workspaceId });
      const data = await trpcData<{ task?: { status: string } }>(res);
      return data.task?.status !== "running";
    });

    // 4. Read the buffered events from the completed stream via tRPC subscription
    const streamRes = await trpcSubscription(server.url, "tasks.stream", { workspaceId });
    expect(streamRes.status).toBe(200);
    const events = await parseTrpcSSEStream(streamRes);
    const eventTypes = events.map((e) => e.event).filter(Boolean) as string[];

    // AskUserQuestion tool call was emitted
    expect(eventTypes).toContain("tool-input-available");
    const toolInputEvent = events.find((e) => e.event === "tool-input-available");
    expect(toolInputEvent).toBeDefined();
    expect((toolInputEvent!.data as Record<string, unknown>).toolName).toBe("AskUserQuestion");
    expect((toolInputEvent!.data as Record<string, unknown>).toolCallId).toBe(toolCallId);

    // The stream completed successfully
    expect(eventTypes).toContain("data-result");
    expect(eventTypes).toContain("finish");
  });
});

// ---------------------------------------------------------------------------
// Helpers — task seeding
// ---------------------------------------------------------------------------

const MIGRATIONS_FOLDER = join(import.meta.dirname, "..", "src", "lib", "db", "migrations");

function openTasksDb(tmpHome: string): InstanceType<typeof Database> {
  const dbPath = join(tmpHome, ".band", "band.db");
  mkdirSync(join(tmpHome, ".band"), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
  return sqlite;
}

function seedTask(tmpHome: string, task: object & { id: string }): void {
  const sqlite = openTasksDb(tmpHome);
  const t = task as Record<string, unknown>;
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO tasks (id, workspace_id, project, branch, prompt, status, session_id, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      t.id,
      t.workspaceId,
      t.project,
      t.branch,
      t.prompt,
      t.status,
      t.sessionId ?? null,
      t.startedAt,
      t.completedAt ?? null,
    );
  sqlite.close();
}

function readTask(tmpHome: string, taskId: string): Record<string, unknown> {
  const sqlite = openTasksDb(tmpHome);
  const row = sqlite.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Record<
    string,
    unknown
  >;
  sqlite.close();
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    project: row.project,
    branch: row.branch,
    prompt: row.prompt,
    status: row.status,
    sessionId: row.session_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

// ---------------------------------------------------------------------------
// Stale task cleanup on server start
// ---------------------------------------------------------------------------

describe("stale task cleanup on server start", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());

    // Seed a "running" task before the server starts
    seedTask(tmpHome, {
      id: "tsk_stale_1",
      workspaceId: "testproject-main",
      project: "testproject",
      branch: "main",
      prompt: "stale task",
      status: "running",
      startedAt: Date.now() - 60_000,
    });

    // Seed a completed task that should NOT be changed
    seedTask(tmpHome, {
      id: "tsk_completed_1",
      workspaceId: "testproject-main",
      project: "testproject",
      branch: "main",
      prompt: "completed task",
      status: "completed",
      startedAt: Date.now() - 120_000,
      completedAt: Date.now() - 60_000,
    });

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("marks stale running tasks as failed on boot", async () => {
    // The server should have cleaned up stale tasks during startup
    const staleTask = readTask(tmpHome, "tsk_stale_1");
    expect(staleTask.status).toBe("failed");
    expect(staleTask.completedAt).toBeDefined();
  });

  it("does not modify non-running tasks", async () => {
    const completedTask = readTask(tmpHome, "tsk_completed_1");
    expect(completedTask.status).toBe("completed");
  });

  it("stale tasks appear as failed via tasks.list", async () => {
    const res = await trpcQuery(server.url, "tasks.list", {});
    const data = await trpcData<{ tasks: Array<{ id: string; status: string }> }>(res);
    const staleTask = data.tasks.find((t) => t.id === "tsk_stale_1");
    expect(staleTask).toBeDefined();
    expect(staleTask!.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// tasks.cancel — running task
// ---------------------------------------------------------------------------

describe("tasks.cancel — running task", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    // Use a scenario that blocks (waits for stdin) so the task stays running
    const scenarioPath = writeScenario(tmpHome, [
      {
        type: "system",
        subtype: "init",
        session_id: "cancel-session",
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Working on it..." }],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-block-1",
              name: "AskUserQuestion",
              input: {
                questions: [
                  {
                    question: "Continue?",
                    header: "Confirm",
                    options: [
                      { label: "Yes", description: "Continue" },
                      { label: "No", description: "Stop" },
                    ],
                    multiSelect: false,
                  },
                ],
              },
            },
          ],
        },
      },
      {
        type: "control_request",
        request_id: "req-cancel-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          input: {},
          tool_use_id: "tool-block-1",
        },
      },
      // Block forever — the task will stay running until cancelled
      { _wait_for_stdin: true },
      {
        type: "result",
        subtype: "success",
        session_id: "cancel-session",
        duration_ms: 1000,
        num_turns: 1,
        total_cost_usd: 0.01,
      },
    ]);

    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgent: { type: "claude-code", command: FAKE_AGENT_PATH },
    });

    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("cancels a running task by task ID", async () => {
    const workspaceId = "testproject-main";

    // Submit a task that will block
    const submitRes = await trpcMutate(server.url, "tasks.submit", {
      workspaceId,
      prompt: "cancel me",
    });
    expect(submitRes.status).toBe(200);

    // Wait for the task to be running
    await waitFor(async () => {
      const res = await trpcQuery(server.url, "tasks.get", { workspaceId });
      const data = await trpcData<{ task?: { status: string } }>(res);
      return data.task?.status === "running";
    });

    // Get the task ID from tasks.list
    const listRes = await trpcQuery(server.url, "tasks.list", {
      workspaceId,
      status: "running",
    });
    const listData = await trpcData<{ tasks: Array<{ id: string }> }>(listRes);
    expect(listData.tasks.length).toBeGreaterThan(0);
    const taskId = listData.tasks[0].id;

    // Cancel the task
    const cancelRes = await trpcMutate(server.url, "tasks.cancel", { taskId });
    expect(cancelRes.status).toBe(200);

    // Verify the task is now failed
    await waitFor(async () => {
      const res = await trpcQuery(server.url, "tasks.get", { workspaceId });
      const data = await trpcData<{ task?: { status: string } }>(res);
      return data.task?.status === "failed";
    });
  });
});

// ---------------------------------------------------------------------------
// tasks.cancel — orphaned task
// ---------------------------------------------------------------------------

describe("tasks.cancel — orphaned task", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());

    // Seed an orphaned "running" task (no in-memory agent for it).
    // This task was created while the stale cleanup was being run (before listen),
    // but we seed it AFTER the tasks dir has the stale cleaned up.
    // Actually, we need the server to start first, then we seed the orphaned task.
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("cancels an orphaned running task by updating the persisted file", async () => {
    // Seed an orphaned task AFTER the server is already running
    // (so cleanup already ran and won't touch this one)
    seedTask(tmpHome, {
      id: "tsk_orphaned_1",
      workspaceId: "testproject-main",
      project: "testproject",
      branch: "main",
      prompt: "orphaned task",
      status: "running",
      startedAt: Date.now() - 30_000,
    });

    // Cancel the orphaned task
    const cancelRes = await trpcMutate(server.url, "tasks.cancel", {
      taskId: "tsk_orphaned_1",
    });
    expect(cancelRes.status).toBe(200);

    // Verify the persisted file is now "failed"
    const task = readTask(tmpHome, "tsk_orphaned_1");
    expect(task.status).toBe("failed");
    expect(task.completedAt).toBeDefined();
  });

  it("returns 404 when cancelling a non-existent task", async () => {
    const res = await trpcMutate(server.url, "tasks.cancel", {
      taskId: "tsk_nonexistent",
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when cancelling an already completed task", async () => {
    seedTask(tmpHome, {
      id: "tsk_already_done",
      workspaceId: "testproject-main",
      project: "testproject",
      branch: "main",
      prompt: "already done",
      status: "completed",
      startedAt: Date.now() - 60_000,
      completedAt: Date.now() - 30_000,
    });

    const res = await trpcMutate(server.url, "tasks.cancel", {
      taskId: "tsk_already_done",
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// tasks.rerun
// ---------------------------------------------------------------------------

describe("tasks.rerun", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const scenarioPath = writeScenario(tmpHome, [
      {
        type: "system",
        subtype: "init",
        session_id: "rerun-session",
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Done!" }],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "rerun-session",
        duration_ms: 500,
        num_turns: 1,
        total_cost_usd: 0.01,
      },
    ]);

    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgent: { type: "claude-code", command: FAKE_AGENT_PATH },
    });

    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("re-runs a completed task with the same prompt and workspace", async () => {
    const workspaceId = "testproject-main";

    // Submit and wait for the original task to complete
    const submitRes = await trpcMutate(server.url, "tasks.submit", {
      workspaceId,
      prompt: "rerun me",
    });
    expect(submitRes.status).toBe(200);

    await waitFor(async () => {
      const res = await trpcQuery(server.url, "tasks.get", { workspaceId });
      const data = await trpcData<{ task?: { status: string } }>(res);
      return data.task?.status !== "running";
    });

    // Get the completed task's ID
    const listRes = await trpcQuery(server.url, "tasks.list", { workspaceId });
    const listData = await trpcData<{ tasks: Array<{ id: string; prompt: string }> }>(listRes);
    const originalTask = listData.tasks.find((t) => t.prompt === "rerun me");
    expect(originalTask).toBeDefined();

    // Re-run the task
    const rerunRes = await trpcMutate(server.url, "tasks.rerun", {
      taskId: originalTask!.id,
    });
    expect(rerunRes.status).toBe(200);
    const rerunData = await trpcData<{ workspaceId: string }>(rerunRes);
    expect(rerunData.workspaceId).toBe(workspaceId);

    // Wait for the re-run task to complete
    await waitFor(async () => {
      const res = await trpcQuery(server.url, "tasks.get", { workspaceId });
      const data = await trpcData<{ task?: { status: string } }>(res);
      return data.task?.status !== "running";
    });

    // Verify there are now 2 tasks for this workspace
    const finalList = await trpcQuery(server.url, "tasks.list", { workspaceId });
    const finalData = await trpcData<{ tasks: Array<{ id: string; prompt: string }> }>(finalList);
    const matchingTasks = finalData.tasks.filter((t) => t.prompt === "rerun me");
    expect(matchingTasks.length).toBe(2);
  });

  it("returns 404 when re-running a non-existent task", async () => {
    const res = await trpcMutate(server.url, "tasks.rerun", {
      taskId: "tsk_nonexistent",
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Task submit + stream — Tool name resolution with empty text block
// ---------------------------------------------------------------------------

describe("Task submit + stream — tool name with empty text before tool_use", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    // Simulate the streaming race condition: the assistant message contains
    // an empty text block (not yet streamed) before a tool_use block.
    // The empty text causes the processing loop to break early, so the
    // tool_use block is never yielded as a tool-use event. The tool_result
    // then arrives as an orphan. The fix ensures the tool name is still
    // resolved from a pre-scan of the content array.
    const scenarioPath = writeScenario(tmpHome, [
      {
        type: "system",
        subtype: "init",
        session_id: "empty-text-session",
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "" },
            {
              type: "tool_use",
              id: "tool-empty-1",
              name: "Bash",
              input: { command: "ls -la" },
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
              tool_use_id: "tool-empty-1",
              content: "file1.txt\nfile2.txt",
              is_error: false,
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Here are the files." }],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "empty-text-session",
        duration_ms: 800,
        num_turns: 1,
        total_cost_usd: 0.02,
      },
    ]);

    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgent: { type: "claude-code", command: FAKE_AGENT_PATH },
    });

    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("resolves tool name even when empty text block precedes tool_use", async () => {
    const { submitRes, events } = await submitAndStream(
      server.url,
      "testproject-main",
      "list files",
    );
    expect(submitRes.status).toBe(200);

    const toolInputEvents = events.filter((e) => e.event === "tool-input-available");
    expect(toolInputEvents.length).toBeGreaterThan(0);

    // The tool name must be "Bash", not the fallback "tool"
    const toolEvent = toolInputEvents[0].data as Record<string, unknown>;
    expect(toolEvent.toolName).toBe("Bash");
    expect(toolEvent.toolCallId).toBe("tool-empty-1");
  });
});

// ---------------------------------------------------------------------------
// tasks.stream — Reconnect replays data-prompt for deduplication
// ---------------------------------------------------------------------------

describe("tasks.stream — reconnect replays data-prompt for deduplication", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const scenarioPath = writeScenario(tmpHome, [
      {
        type: "system",
        subtype: "init",
        session_id: "reconnect-session",
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Working on the fix..." }],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "reconnect-session",
        duration_ms: 500,
        num_turns: 1,
        total_cost_usd: 0.01,
      },
    ]);

    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgent: { type: "claude-code", command: FAKE_AGENT_PATH },
    });

    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("replays data-prompt with the exact prompt text when reconnecting after task completes", async () => {
    const workspaceId = "testproject-main";
    const prompt = "fix the auth bug";

    // Submit the task
    const submitRes = await trpcMutate(server.url, "tasks.submit", { workspaceId, prompt });
    expect(submitRes.status).toBe(200);

    // Wait for the task to complete
    await waitFor(async () => {
      const res = await trpcQuery(server.url, "tasks.get", { workspaceId });
      const data = await trpcData<{ task?: { status: string } }>(res);
      return data.task?.status !== "running";
    });

    // Reconnect to the stream (simulates navigating back to the chat)
    const streamRes = await trpcSubscription(server.url, "tasks.stream", { workspaceId });
    expect(streamRes.status).toBe(200);
    const events = await parseTrpcSSEStream(streamRes);

    // The data-prompt chunk must be the first event and contain the exact prompt
    // text. The client uses this to deduplicate with session history.
    const dataPromptEvents = events.filter((e) => e.event === "data-prompt");
    expect(dataPromptEvents.length).toBe(1);

    const promptChunk = dataPromptEvents[0].data as Record<string, unknown>;
    const promptData = promptChunk.data as Record<string, unknown>;
    expect(promptData.text).toBe(prompt);

    // The stream should also contain the assistant's response and finish
    const eventTypes = events.map((e) => e.event).filter(Boolean) as string[];
    expect(eventTypes).toContain("text-delta");
    expect(eventTypes).toContain("finish");
  });

  it("does not duplicate data-prompt across buffer replay and live events", async () => {
    // The task already completed above; reconnecting again should still
    // yield exactly one data-prompt chunk (no accumulation).
    const streamRes = await trpcSubscription(server.url, "tasks.stream", {
      workspaceId: "testproject-main",
    });
    const events = await parseTrpcSSEStream(streamRes);
    const dataPromptEvents = events.filter((e) => e.event === "data-prompt");
    expect(dataPromptEvents.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// WebSocket transport — tasks.stream
// ---------------------------------------------------------------------------

describe("tasks.stream via WebSocket — no active task", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("completes immediately with no data events when no task exists", async () => {
    const { events } = await wsSubscribe(server.url, "tasks.stream", {
      workspaceId: "testproject-main",
    });
    expect(events).toEqual([]);
  });
});

describe("tasks.stream via WebSocket — streaming", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const scenarioPath = writeScenario(tmpHome, [
      {
        type: "system",
        subtype: "init",
        session_id: "ws-test-session",
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello via WebSocket!" }],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "ws-test-session",
        duration_ms: 100,
        num_turns: 1,
        total_cost_usd: 0.01,
      },
    ]);

    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgent: { type: "claude-code", command: FAKE_AGENT_PATH },
    });

    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("streams UIMessageChunk events over WebSocket", async () => {
    const { submitRes, events } = await wsSubmitAndStream(server.url, "testproject-main", "hello");
    expect(submitRes.status).toBe(200);

    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("text-delta");
    expect(eventTypes).toContain("finish");
  });
});
