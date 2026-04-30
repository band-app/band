import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const FAKE_AGENT_PATH = join(import.meta.dirname, "fake-agent.mjs");
const DEFAULT_TOKEN = "queue-drain-test-token";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = mkdtempSync(join(tmpdir(), "band-qdrain-test-"));
  const bandDir = join(tmp, ".band");
  mkdirSync(bandDir, { recursive: true });
  return tmp;
}

function writeScenario(tmpHome: string, events: object[]): string {
  const scenarioPath = join(tmpHome, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(events));
  return scenarioPath;
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

interface SSEEvent {
  event: string | null;
  data: unknown;
}

// ---------------------------------------------------------------------------
// Polling helper
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
// A simple scenario that completes quickly
// ---------------------------------------------------------------------------

function quickSuccessScenario() {
  return [
    {
      type: "system",
      subtype: "init",
      session_id: "session-1",
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
      session_id: "session-1",
      duration_ms: 100,
      num_turns: 1,
      total_cost_usd: 0.01,
    },
  ];
}

function failureScenario() {
  return [
    {
      type: "system",
      subtype: "init",
      session_id: "fail-session",
    },
    {
      type: "result",
      subtype: "failure",
      session_id: "fail-session",
      duration_ms: 50,
      num_turns: 0,
      total_cost_usd: 0,
      errors: ["Something went wrong"],
    },
  ];
}

// ---------------------------------------------------------------------------
// Queue auto-drain — single queued message
// ---------------------------------------------------------------------------

describe("queue auto-drain — single queued message", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const scenarioPath = writeScenario(tmpHome, quickSuccessScenario());
    seedSettings(tmpHome, defaultSettings());

    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("auto-starts the queued message after the first task completes", async () => {
    const workspaceId = "testproject-main";

    // 1. Submit the first task
    const submitRes = await trpcMutate(server.url, "tasks.submit", {
      workspaceId,
      prompt: "first task",
    });
    expect(submitRes.status).toBe(200);

    // 2. While the task is running, push a message to the queue
    await trpcMutate(server.url, "queue.push", {
      workspaceId,
      text: "second task from queue",
    });

    // 3. Wait for the auto-started second task to complete
    await waitFor(async () => {
      const res = await trpcQuery(server.url, "tasks.get", { workspaceId });
      const data = await trpcData<{ task?: { status: string; prompt: string } }>(res);
      return data.task?.prompt === "second task from queue" && data.task?.status === "completed";
    });

    // 4. Verify the queue is now empty (message was consumed)
    const queueRes = await trpcQuery(server.url, "queue.get", { workspaceId });
    const queueData = await trpcData<{ messages: string[] }>(queueRes);
    expect(queueData.messages).toEqual([]);

    // 5. Verify the last task that ran was the queued one
    const taskRes = await trpcQuery(server.url, "tasks.get", { workspaceId });
    const taskData = await trpcData<{ task?: { prompt: string; status: string } }>(taskRes);
    expect(taskData.task?.prompt).toBe("second task from queue");
    expect(taskData.task?.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Queue auto-drain — multiple queued messages
// ---------------------------------------------------------------------------

describe("queue auto-drain — multiple queued messages", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const scenarioPath = writeScenario(tmpHome, quickSuccessScenario());
    seedSettings(tmpHome, defaultSettings());

    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("drains all queued messages sequentially", async () => {
    const workspaceId = "testproject-main";

    // 1. Submit the first task
    const submitRes = await trpcMutate(server.url, "tasks.submit", {
      workspaceId,
      prompt: "task 1",
    });
    expect(submitRes.status).toBe(200);

    // 2. Queue up two more messages while it's running
    await trpcMutate(server.url, "queue.push", { workspaceId, text: "task 2" });
    await trpcMutate(server.url, "queue.push", { workspaceId, text: "task 3" });

    // 3. Wait for all tasks to drain (the last prompt should be "task 3")
    await waitFor(
      async () => {
        const res = await trpcQuery(server.url, "tasks.get", { workspaceId });
        const data = await trpcData<{ task?: { status: string; prompt: string } }>(res);
        return data.task?.prompt === "task 3" && data.task?.status !== "running";
      },
      { timeout: 15_000 },
    );

    // 4. Verify queue is empty
    const queueRes = await trpcQuery(server.url, "queue.get", { workspaceId });
    const queueData = await trpcData<{ messages: string[] }>(queueRes);
    expect(queueData.messages).toEqual([]);

    // 5. Verify all three tasks were recorded
    const listRes = await trpcQuery(server.url, "tasks.list", { workspaceId });
    const listData = await trpcData<{ tasks: Array<{ prompt: string; status: string }> }>(listRes);
    const prompts = listData.tasks.map((t) => t.prompt);
    expect(prompts).toContain("task 1");
    expect(prompts).toContain("task 2");
    expect(prompts).toContain("task 3");

    // All should be completed
    for (const task of listData.tasks) {
      expect(task.status).toBe("completed");
    }
  });
});

// ---------------------------------------------------------------------------
// Queue auto-drain — failed task does NOT drain queue
// ---------------------------------------------------------------------------

describe("queue auto-drain — failed task does not drain queue", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const scenarioPath = writeScenario(tmpHome, failureScenario());
    seedSettings(tmpHome, defaultSettings());

    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("does not auto-start queued messages when a task fails", async () => {
    const workspaceId = "testproject-main";

    // 1. Submit a task that will fail
    const submitRes = await trpcMutate(server.url, "tasks.submit", {
      workspaceId,
      prompt: "this will fail",
    });
    expect(submitRes.status).toBe(200);

    // 2. Queue a message while it's running
    await trpcMutate(server.url, "queue.push", { workspaceId, text: "should stay queued" });

    // 3. Wait for the task to fail
    await waitFor(async () => {
      const res = await trpcQuery(server.url, "tasks.get", { workspaceId });
      const data = await trpcData<{ task?: { status: string } }>(res);
      return data.task?.status === "failed";
    });

    // 4. Give a short moment to ensure no auto-start happens
    await new Promise((r) => setTimeout(r, 500));

    // 5. Verify queue still has the message (it was NOT consumed)
    const queueRes = await trpcQuery(server.url, "queue.get", { workspaceId });
    const queueData = await trpcData<{ messages: string[] }>(queueRes);
    expect(queueData.messages).toEqual(["should stay queued"]);

    // Cleanup
    await trpcMutate(server.url, "queue.clear", { workspaceId });
  });
});

// ---------------------------------------------------------------------------
// SSE helpers (AI SDK UIMessageStream format)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Stream stays alive across auto-drained tasks (SSE)
// ---------------------------------------------------------------------------

describe("stream stays alive across auto-drained tasks (SSE)", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const scenarioPath = writeScenario(tmpHome, quickSuccessScenario());
    seedSettings(tmpHome, defaultSettings());

    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("auto-started task streams events including data-prompt to connected client", async () => {
    const workspaceId = "testproject-main";
    const chatId = `test-queue-drain-${Date.now()}`;

    // 1. Pre-load the queue BEFORE submitting the first task
    await trpcMutate(server.url, "queue.push", { workspaceId, chatId, text: "task B" });

    // 2. Submit via SSE POST — opens stream that stays alive through both tasks
    const response = await fetch(`${server.url}/api/tasks/${encodeURIComponent(chatId)}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...defaultHeaders },
      body: JSON.stringify({ workspaceId, prompt: "task A" }),
    });
    expect(response.status).toBe(200);
    const events = await parseSSEStream(response);

    // 3. Should have finish and result events
    const finishEvents = events.filter((e) => e.event === "finish");
    expect(finishEvents.length).toBeGreaterThanOrEqual(1);

    const resultEvents = events.filter((e) => e.event === "data-result");
    expect(resultEvents.length).toBeGreaterThanOrEqual(1);

    // 4. Should have a data-prompt event for the queued message so the
    //    client can render the user message bubble between responses
    const promptEvents = events.filter((e) => e.event === "data-prompt");
    expect(promptEvents.length).toBe(1);
    expect((promptEvents[0].data as { data: { text: string } }).data.text).toBe("task B");

    // 5. Queue should be empty
    const queueRes = await trpcQuery(server.url, "queue.get", { workspaceId });
    const queueData = await trpcData<{ messages: string[] }>(queueRes);
    expect(queueData.messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stream closes after last task when queue is empty
// ---------------------------------------------------------------------------

describe("stream closes after last task when queue is empty", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const scenarioPath = writeScenario(tmpHome, quickSuccessScenario());
    seedSettings(tmpHome, defaultSettings());

    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("closes the SSE stream after task finishes with empty queue", async () => {
    const workspaceId = "testproject-main";
    const chatId = `test-queue-close-${Date.now()}`;

    // Submit via SSE POST endpoint
    const startTime = Date.now();
    const response = await fetch(`${server.url}/api/tasks/${encodeURIComponent(chatId)}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...defaultHeaders },
      body: JSON.stringify({ workspaceId, prompt: "only task" }),
    });
    expect(response.status).toBe(200);
    const events = await parseSSEStream(response);
    const elapsed = Date.now() - startTime;

    // Should have completed (not timed out)
    expect(elapsed).toBeLessThan(9_000);

    // Should have exactly one finish event
    const finishEvents = events.filter((e) => e.event === "finish");
    expect(finishEvents.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// queue.shift — backend shift endpoint
// ---------------------------------------------------------------------------

describe("queue.shift — pops the first message", () => {
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

  it("returns null when queue is empty", async () => {
    const res = await trpcMutate(server.url, "queue.shift", { workspaceId: "testproject-main" });
    expect(res.status).toBe(200);
    const data = await trpcData<{ text: string | null }>(res);
    expect(data.text).toBeNull();
  });

  it("pops the first message and leaves the rest", async () => {
    const workspaceId = "testproject-main";

    // Seed the queue
    await trpcMutate(server.url, "queue.push", { workspaceId, text: "first" });
    await trpcMutate(server.url, "queue.push", { workspaceId, text: "second" });
    await trpcMutate(server.url, "queue.push", { workspaceId, text: "third" });

    // Shift the first
    const shiftRes = await trpcMutate(server.url, "queue.shift", { workspaceId });
    const shiftData = await trpcData<{ text: string | null }>(shiftRes);
    expect(shiftData.text).toBe("first");

    // Verify remaining
    const getRes = await trpcQuery(server.url, "queue.get", { workspaceId });
    const getData = await trpcData<{ messages: string[] }>(getRes);
    expect(getData.messages).toEqual(["second", "third"]);

    // Cleanup
    await trpcMutate(server.url, "queue.clear", { workspaceId });
  });
});

// ---------------------------------------------------------------------------
// Queue auto-drain — session continuity
// ---------------------------------------------------------------------------

describe("queue auto-drain — session continuity", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const scenarioPath = writeScenario(tmpHome, quickSuccessScenario());
    seedSettings(tmpHome, defaultSettings());

    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("auto-started task inherits the session ID from the completed task", async () => {
    const workspaceId = "testproject-main";

    // 1. Submit the first task
    await trpcMutate(server.url, "tasks.submit", { workspaceId, prompt: "initial task" });

    // 2. Queue a follow-up
    await trpcMutate(server.url, "queue.push", { workspaceId, text: "follow-up" });

    // 3. Wait for both tasks to drain
    await waitFor(
      async () => {
        const res = await trpcQuery(server.url, "tasks.get", { workspaceId });
        const data = await trpcData<{ task?: { status: string; prompt: string } }>(res);
        return data.task?.prompt === "follow-up" && data.task?.status !== "running";
      },
      { timeout: 15_000 },
    );

    // 4. Both tasks should have a session ID (the second inherits from the first)
    const listRes = await trpcQuery(server.url, "tasks.list", { workspaceId });
    const listData = await trpcData<{
      tasks: Array<{ prompt: string; sessionId: string | null }>;
    }>(listRes);

    const initialTask = listData.tasks.find((t) => t.prompt === "initial task");
    const followUpTask = listData.tasks.find((t) => t.prompt === "follow-up");

    expect(initialTask).toBeDefined();
    expect(followUpTask).toBeDefined();
    expect(initialTask!.sessionId).toBeDefined();
    // The follow-up should have the same session ID (session continuity)
    expect(followUpTask!.sessionId).toBe(initialTask!.sessionId);
  });
});

// ---------------------------------------------------------------------------
// Queue auto-drain — queue pushed after task starts but before it finishes
// ---------------------------------------------------------------------------

describe("queue auto-drain — late queue push", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));

    const scenarioPath = writeScenario(tmpHome, quickSuccessScenario());
    seedSettings(tmpHome, defaultSettings());

    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("drains a message pushed while the task is still running", async () => {
    const workspaceId = "testproject-main";

    // 1. Submit the first task
    await trpcMutate(server.url, "tasks.submit", { workspaceId, prompt: "main task" });

    // 2. Immediately push to queue (task is still running or just finishing)
    await trpcMutate(server.url, "queue.push", { workspaceId, text: "queued while running" });

    // 3. Wait for the queued task to complete
    await waitFor(
      async () => {
        const res = await trpcQuery(server.url, "tasks.get", { workspaceId });
        const data = await trpcData<{ task?: { prompt: string; status: string } }>(res);
        return data.task?.prompt === "queued while running" && data.task?.status !== "running";
      },
      { timeout: 15_000 },
    );

    // 4. Queue is drained
    const queueRes = await trpcQuery(server.url, "queue.get", { workspaceId });
    const queueData = await trpcData<{ messages: string[] }>(queueRes);
    expect(queueData.messages).toEqual([]);
  });
});
