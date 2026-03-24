import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const FAKE_AGENT_PATH = join(import.meta.dirname, "fake-agent.mjs");
const DEFAULT_TOKEN = "todo-write-test-token";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-todo-test-")));
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

async function trpcQuery(serverUrl: string, procedure: string, input?: unknown) {
  const url =
    input !== undefined
      ? `${serverUrl}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${serverUrl}/trpc/${procedure}`;
  return fetch(url, { headers: defaultHeaders });
}

async function trpcMutate(serverUrl: string, procedure: string, input?: unknown) {
  return fetch(`${serverUrl}/trpc/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...defaultHeaders },
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
): Promise<Response> {
  const url = `${serverUrl}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;
  return fetch(url, { headers: defaultHeaders });
}

async function submitAndStream(
  serverUrl: string,
  workspaceId: string,
  prompt: string,
): Promise<{ submitRes: Response; streamRes: Response; events: SSEEvent[] }> {
  const submitRes = await trpcMutate(serverUrl, "tasks.submit", {
    workspaceId,
    prompt,
  });

  if (!submitRes.ok) {
    return { submitRes, streamRes: submitRes, events: [] };
  }

  await new Promise((r) => setTimeout(r, 100));

  const streamRes = await trpcSubscription(serverUrl, "tasks.stream", {
    workspaceId,
  });
  const events = await parseTrpcSSEStream(streamRes);

  return { submitRes, streamRes, events };
}

// ---------------------------------------------------------------------------
// Session history helpers
// ---------------------------------------------------------------------------

function encodeProjectPath(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

function seedSessionFile(
  tmpHome: string,
  workspacePath: string,
  sessionId: string,
  content: string,
): void {
  const encoded = encodeProjectPath(workspacePath);
  const projectDir = join(tmpHome, ".claude", "projects", encoded);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), content);
}

// ---------------------------------------------------------------------------
// TodoWrite streaming — basic tool call
// ---------------------------------------------------------------------------

describe("TodoWrite streaming — basic tool call", () => {
  let server: ServerHandle;
  let tmpHome: string;

  const todoInput = {
    todos: [
      {
        content: "Set up project structure",
        status: "completed",
        activeForm: "Setting up project structure",
      },
      {
        content: "Write integration tests",
        status: "in_progress",
        activeForm: "Writing integration tests",
      },
      {
        content: "Run tests and fix failures",
        status: "pending",
        activeForm: "Running tests and fixing failures",
      },
    ],
  };

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const scenarioPath = writeScenario(tmpHome, [
      {
        type: "system",
        subtype: "init",
        session_id: "todo-session-1",
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me track the progress of this task." },
            {
              type: "tool_use",
              id: "tool-todo-1",
              name: "TodoWrite",
              input: todoInput,
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
              tool_use_id: "tool-todo-1",
              content: "Todos have been modified successfully.",
              is_error: false,
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "I've set up the todo list. Moving on to writing tests." },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "todo-session-1",
        duration_ms: 2000,
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

  it("streams TodoWrite tool call with correct tool name and input", async () => {
    const { submitRes, events } = await submitAndStream(
      server.url,
      "testproject-main",
      "create todos",
    );
    expect(submitRes.status).toBe(200);

    const toolInputEvents = events.filter((e) => e.event === "tool-input-available");
    expect(toolInputEvents.length).toBeGreaterThan(0);

    const todoEvent = toolInputEvents.find(
      (e) => (e.data as Record<string, unknown>).toolName === "TodoWrite",
    );
    expect(todoEvent).toBeDefined();

    const data = todoEvent!.data as Record<string, unknown>;
    expect(data.toolCallId).toBe("tool-todo-1");
    expect(data.toolName).toBe("TodoWrite");

    const input = data.input as { todos: unknown[] };
    expect(input.todos).toHaveLength(3);
    expect(input.todos[0]).toEqual(
      expect.objectContaining({ content: "Set up project structure", status: "completed" }),
    );
    expect(input.todos[1]).toEqual(
      expect.objectContaining({ content: "Write integration tests", status: "in_progress" }),
    );
    expect(input.todos[2]).toEqual(
      expect.objectContaining({ content: "Run tests and fix failures", status: "pending" }),
    );
  });

  it("streams tool-output-available after TodoWrite completes", async () => {
    // The task already completed above; reconnect to get buffered events
    const streamRes = await trpcSubscription(server.url, "tasks.stream", {
      workspaceId: "testproject-main",
    });
    const events = await parseTrpcSSEStream(streamRes);

    const toolOutputEvents = events.filter((e) => e.event === "tool-output-available");
    expect(toolOutputEvents.length).toBeGreaterThan(0);

    const todoOutput = toolOutputEvents.find(
      (e) => (e.data as Record<string, unknown>).toolCallId === "tool-todo-1",
    );
    expect(todoOutput).toBeDefined();

    const output = (todoOutput!.data as Record<string, unknown>).output as string;
    expect(output).toContain("Todos have been modified successfully");
  });

  it("includes data-result and finish events alongside TodoWrite", async () => {
    const streamRes = await trpcSubscription(server.url, "tasks.stream", {
      workspaceId: "testproject-main",
    });
    const events = await parseTrpcSSEStream(streamRes);
    const eventTypes = events.map((e) => e.event);

    expect(eventTypes).toContain("tool-input-available");
    expect(eventTypes).toContain("tool-output-available");
    expect(eventTypes).toContain("data-result");
    expect(eventTypes).toContain("finish");
  });
});

// ---------------------------------------------------------------------------
// TodoWrite streaming — multiple sequential calls replace the list
// ---------------------------------------------------------------------------

describe("TodoWrite streaming — multiple sequential calls", () => {
  let server: ServerHandle;
  let tmpHome: string;

  const firstTodoInput = {
    todos: [
      { content: "Explore codebase", status: "in_progress", activeForm: "Exploring codebase" },
      { content: "Write implementation", status: "pending", activeForm: "Writing implementation" },
    ],
  };

  const secondTodoInput = {
    todos: [
      { content: "Explore codebase", status: "completed", activeForm: "Exploring codebase" },
      {
        content: "Write implementation",
        status: "in_progress",
        activeForm: "Writing implementation",
      },
      { content: "Run tests", status: "pending", activeForm: "Running tests" },
    ],
  };

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const scenarioPath = writeScenario(tmpHome, [
      {
        type: "system",
        subtype: "init",
        session_id: "todo-multi-session",
      },
      // First TodoWrite call
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-todo-first",
              name: "TodoWrite",
              input: firstTodoInput,
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
              tool_use_id: "tool-todo-first",
              content: "Todos have been modified successfully.",
              is_error: false,
            },
          ],
        },
      },
      // Second TodoWrite call (updates progress)
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Done exploring. Now implementing." },
            {
              type: "tool_use",
              id: "tool-todo-second",
              name: "TodoWrite",
              input: secondTodoInput,
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
              tool_use_id: "tool-todo-second",
              content: "Todos have been modified successfully.",
              is_error: false,
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "todo-multi-session",
        duration_ms: 5000,
        num_turns: 3,
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

  it("streams both TodoWrite tool calls with distinct IDs", async () => {
    const { submitRes, events } = await submitAndStream(
      server.url,
      "testproject-main",
      "implement feature",
    );
    expect(submitRes.status).toBe(200);

    const todoInputEvents = events.filter(
      (e) =>
        e.event === "tool-input-available" &&
        (e.data as Record<string, unknown>).toolName === "TodoWrite",
    );

    expect(todoInputEvents).toHaveLength(2);

    const firstEvent = todoInputEvents[0].data as Record<string, unknown>;
    expect(firstEvent.toolCallId).toBe("tool-todo-first");
    const firstInput = firstEvent.input as { todos: unknown[] };
    expect(firstInput.todos).toHaveLength(2);

    const secondEvent = todoInputEvents[1].data as Record<string, unknown>;
    expect(secondEvent.toolCallId).toBe("tool-todo-second");
    const secondInput = secondEvent.input as { todos: unknown[] };
    expect(secondInput.todos).toHaveLength(3);
  });

  it("streams tool-output-available for each TodoWrite call", async () => {
    const streamRes = await trpcSubscription(server.url, "tasks.stream", {
      workspaceId: "testproject-main",
    });
    const events = await parseTrpcSSEStream(streamRes);

    const todoOutputEvents = events.filter((e) => e.event === "tool-output-available");

    const firstOutput = todoOutputEvents.find(
      (e) => (e.data as Record<string, unknown>).toolCallId === "tool-todo-first",
    );
    const secondOutput = todoOutputEvents.find(
      (e) => (e.data as Record<string, unknown>).toolCallId === "tool-todo-second",
    );

    expect(firstOutput).toBeDefined();
    expect(secondOutput).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TodoWrite in session history — tool name resolution
// ---------------------------------------------------------------------------

describe("TodoWrite in session history — tool name resolution", () => {
  let server: ServerHandle;
  let tmpHome: string;
  const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeee00000001";

  beforeAll(async () => {
    tmpHome = createTmpHome();
    const repoDir = join(tmpHome, "repo");
    mkdirSync(repoDir, { recursive: true });

    seedState(tmpHome, {
      projects: [
        {
          name: "testproject",
          path: repoDir,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoDir }],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgent: { type: "claude-code", command: FAKE_AGENT_PATH },
    });

    // Build a session JSONL with a TodoWrite tool call
    const todoInput = {
      todos: [
        { content: "Fix login bug", status: "completed", activeForm: "Fixing login bug" },
        { content: "Add tests", status: "in_progress", activeForm: "Adding tests" },
      ],
    };

    const messages = [
      {
        type: "user",
        uuid: "00000000-0000-0000-0000-000000000001",
        parentUuid: null,
        sessionId: SESSION_ID,
        isSidechain: false,
        userType: "external",
        message: { content: [{ type: "text", text: "fix the login bug and add tests" }] },
        timestamp: "2026-03-12T08:00:00.000Z",
      },
      {
        type: "assistant",
        uuid: "10000000-0000-0000-0000-000000000001",
        parentUuid: "00000000-0000-0000-0000-000000000001",
        sessionId: SESSION_ID,
        isSidechain: false,
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_todo_hist_1",
              name: "TodoWrite",
              input: todoInput,
            },
          ],
        },
        timestamp: "2026-03-12T08:00:02.000Z",
      },
      {
        type: "user",
        uuid: "20000000-0000-0000-0000-000000000001",
        parentUuid: "10000000-0000-0000-0000-000000000001",
        sessionId: SESSION_ID,
        isSidechain: false,
        userType: "tool_result",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_todo_hist_1",
              content: "Todos have been modified successfully.",
              is_error: false,
            },
          ],
        },
        timestamp: "2026-03-12T08:00:03.000Z",
      },
      {
        type: "assistant",
        uuid: "30000000-0000-0000-0000-000000000001",
        parentUuid: "20000000-0000-0000-0000-000000000001",
        sessionId: SESSION_ID,
        isSidechain: false,
        message: { content: [{ type: "text", text: "Fixed the bug and added tests." }] },
        timestamp: "2026-03-12T08:01:00.000Z",
      },
    ];

    const jsonl = `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`;
    seedSessionFile(tmpHome, repoDir, SESSION_ID, jsonl);

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("resolves TodoWrite tool_use block with correct tool name", async () => {
    const res = await trpcQuery(server.url, "sessions.messages", {
      workspaceId: "testproject-main",
      sessionId: SESSION_ID,
    });
    expect(res.status).toBe(200);

    const data = await trpcData<{
      messages: Array<{
        role: string;
        content: Array<{
          type: string;
          toolName?: string;
          toolCallId?: string;
        }>;
      }>;
    }>(res);

    const toolUseBlocks = data.messages.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_use"),
    );

    expect(toolUseBlocks.length).toBe(1);
    expect(toolUseBlocks[0].toolName).toBe("TodoWrite");
  });

  it("pairs TodoWrite tool_use with its tool_result", async () => {
    const res = await trpcQuery(server.url, "sessions.messages", {
      workspaceId: "testproject-main",
      sessionId: SESSION_ID,
    });

    const data = await trpcData<{
      messages: Array<{
        role: string;
        content: Array<{
          type: string;
          toolCallId?: string;
        }>;
      }>;
    }>(res);

    const toolUseIds = new Set(
      data.messages
        .flatMap((m) => m.content)
        .filter((b) => b.type === "tool_use")
        .map((b) => b.toolCallId),
    );
    const toolResultIds = new Set(
      data.messages
        .flatMap((m) => m.content)
        .filter((b) => b.type === "tool_result")
        .map((b) => b.toolCallId),
    );

    for (const id of toolUseIds) {
      expect(toolResultIds.has(id)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// TodoWrite streaming — mixed with other tool calls
// ---------------------------------------------------------------------------

describe("TodoWrite streaming — mixed with other tool calls", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const scenarioPath = writeScenario(tmpHome, [
      {
        type: "system",
        subtype: "init",
        session_id: "todo-mixed-session",
      },
      // Agent uses TodoWrite to set up tasks
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-todo-mixed",
              name: "TodoWrite",
              input: {
                todos: [
                  { content: "Read file", status: "in_progress", activeForm: "Reading file" },
                  { content: "Edit file", status: "pending", activeForm: "Editing file" },
                ],
              },
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
              tool_use_id: "tool-todo-mixed",
              content: "Todos have been modified successfully.",
              is_error: false,
            },
          ],
        },
      },
      // Agent then uses a regular tool (Read)
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-read-1",
              name: "Read",
              input: { file_path: "/tmp/example.txt" },
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
              tool_use_id: "tool-read-1",
              content: "file contents here",
              is_error: false,
            },
          ],
        },
      },
      // Agent updates the todo list after completing the read
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-todo-mixed-2",
              name: "TodoWrite",
              input: {
                todos: [
                  { content: "Read file", status: "completed", activeForm: "Reading file" },
                  { content: "Edit file", status: "in_progress", activeForm: "Editing file" },
                ],
              },
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
              tool_use_id: "tool-todo-mixed-2",
              content: "Todos have been modified successfully.",
              is_error: false,
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "All done!" }],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "todo-mixed-session",
        duration_ms: 3000,
        num_turns: 4,
        total_cost_usd: 0.08,
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

  it("streams TodoWrite and Read tool calls with correct tool names", async () => {
    const { submitRes, events } = await submitAndStream(
      server.url,
      "testproject-main",
      "implement feature",
    );
    expect(submitRes.status).toBe(200);

    const toolInputEvents = events.filter((e) => e.event === "tool-input-available");

    // Should have 3 tool calls: TodoWrite, Read, TodoWrite
    expect(toolInputEvents.length).toBe(3);

    const toolNames = toolInputEvents.map((e) => (e.data as Record<string, unknown>).toolName);
    expect(toolNames).toEqual(["TodoWrite", "Read", "TodoWrite"]);
  });

  it("preserves correct tool call IDs for mixed tool calls", async () => {
    const streamRes = await trpcSubscription(server.url, "tasks.stream", {
      workspaceId: "testproject-main",
    });
    const events = await parseTrpcSSEStream(streamRes);

    const toolInputEvents = events.filter((e) => e.event === "tool-input-available");

    const ids = toolInputEvents.map((e) => (e.data as Record<string, unknown>).toolCallId);
    expect(ids).toContain("tool-todo-mixed");
    expect(ids).toContain("tool-read-1");
    expect(ids).toContain("tool-todo-mixed-2");
  });

  it("streams all tool outputs for mixed tool calls", async () => {
    const streamRes = await trpcSubscription(server.url, "tasks.stream", {
      workspaceId: "testproject-main",
    });
    const events = await parseTrpcSSEStream(streamRes);

    const toolOutputEvents = events.filter((e) => e.event === "tool-output-available");

    const outputIds = toolOutputEvents.map((e) => (e.data as Record<string, unknown>).toolCallId);
    expect(outputIds).toContain("tool-todo-mixed");
    expect(outputIds).toContain("tool-read-1");
    expect(outputIds).toContain("tool-todo-mixed-2");
  });
});

// ---------------------------------------------------------------------------
// TodoWrite streaming — empty todos array
// ---------------------------------------------------------------------------

describe("TodoWrite streaming — edge cases", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const scenarioPath = writeScenario(tmpHome, [
      {
        type: "system",
        subtype: "init",
        session_id: "todo-edge-session",
      },
      // TodoWrite with empty todos
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-todo-empty",
              name: "TodoWrite",
              input: { todos: [] },
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
              tool_use_id: "tool-todo-empty",
              content: "Todos have been modified successfully.",
              is_error: false,
            },
          ],
        },
      },
      // TodoWrite with a single todo
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-todo-single",
              name: "TodoWrite",
              input: {
                todos: [
                  { content: "Only task", status: "completed", activeForm: "Completing only task" },
                ],
              },
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
              tool_use_id: "tool-todo-single",
              content: "Todos have been modified successfully.",
              is_error: false,
            },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "todo-edge-session",
        duration_ms: 1000,
        num_turns: 2,
        total_cost_usd: 0.03,
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

  it("handles empty todos array gracefully", async () => {
    const { submitRes, events } = await submitAndStream(
      server.url,
      "testproject-main",
      "clear todos",
    );
    expect(submitRes.status).toBe(200);

    const todoEvents = events.filter(
      (e) =>
        e.event === "tool-input-available" &&
        (e.data as Record<string, unknown>).toolName === "TodoWrite",
    );

    expect(todoEvents.length).toBe(2);

    // First call has empty todos
    const emptyEvent = todoEvents.find(
      (e) => (e.data as Record<string, unknown>).toolCallId === "tool-todo-empty",
    );
    expect(emptyEvent).toBeDefined();
    const emptyInput = (emptyEvent!.data as Record<string, unknown>).input as { todos: unknown[] };
    expect(emptyInput.todos).toHaveLength(0);

    // Second call has one todo
    const singleEvent = todoEvents.find(
      (e) => (e.data as Record<string, unknown>).toolCallId === "tool-todo-single",
    );
    expect(singleEvent).toBeDefined();
    const singleInput = (singleEvent!.data as Record<string, unknown>).input as {
      todos: unknown[];
    };
    expect(singleInput.todos).toHaveLength(1);
    expect(singleInput.todos[0]).toEqual(
      expect.objectContaining({ content: "Only task", status: "completed" }),
    );
  });
});
