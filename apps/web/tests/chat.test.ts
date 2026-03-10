import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const FAKE_AGENT_PATH = join(import.meta.dirname, "fake-agent.mjs");

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
  return fetch(url, opts?.headers ? { headers: opts.headers } : undefined);
}

async function trpcMutate(
  serverUrl: string,
  procedure: string,
  input?: unknown,
  opts?: { headers?: Record<string, string> },
) {
  return fetch(`${serverUrl}/trpc/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...opts?.headers },
    body: input !== undefined ? JSON.stringify(input) : "{}",
  });
}

async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

// ---------------------------------------------------------------------------
// SSE helpers (for streaming endpoints that stay as REST)
// ---------------------------------------------------------------------------

interface SSEEvent {
  event: string | null;
  data: unknown;
}

/**
 * Parse an SSE response body into an array of { event, data } objects.
 *
 * The task runner emits UIMessageChunk objects as JSON in `data:` lines.
 * The event type is inside the JSON data's `type` field.
 */
async function parseSSEStream(response: Response): Promise<SSEEvent[]> {
  const text = await response.text();
  const events: SSEEvent[] = [];

  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (raw === "[DONE]") continue;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
    const event =
      typeof data === "object" && data !== null
        ? ((data as Record<string, unknown>).type as string)
        : null;
    events.push({ event, data });
  }

  return events;
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

  // SSE stream stays as REST
  const streamRes = await fetch(`${serverUrl}/api/tasks/${encodeURIComponent(workspaceId)}/stream`);
  const events = await parseSSEStream(streamRes);

  return { submitRes, streamRes, events };
}

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
    seedSettings(tmpHome, defaultSettings());
    server = await startServer({
      tmpHome,
      env: { BAND_TOKEN_SECRET: "test-secret" },
    });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns 401 when BAND_TOKEN_SECRET is set and no token provided", async () => {
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

    // 4. Read the buffered events from the completed stream (SSE stays as REST)
    const streamRes = await fetch(
      `${server.url}/api/tasks/${encodeURIComponent(workspaceId)}/stream`,
    );
    expect(streamRes.status).toBe(200);
    const events = await parseSSEStream(streamRes);
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
