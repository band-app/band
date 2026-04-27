/**
 * Multi-message chat tests.
 *
 * Sending two messages on the same chat pane (same chatId, same Claude
 * sessionId) is the simplest real-world flow and was broken by the
 * Phase 2b session-buffer replay: the second message's stream would
 * yield every event from the first message before any new events,
 * confusing the AI SDK's useChat hook.
 *
 * These tests submit two tasks back-to-back via tasks.submit, stream
 * each through tasks.stream over WebSocket (matching how the production
 * client connects), and assert that the second stream is scoped to the
 * second task only.
 */

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
const DEFAULT_TOKEN = "multimessage-test-token";

// ---------------------------------------------------------------------------
// Test infra (mirrors chat.test.ts / queue-drain.test.ts)
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = mkdtempSync(join(tmpdir(), "band-multimsg-test-"));
  mkdirSync(join(tmp, ".band"), { recursive: true });
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

async function startServer(opts: { tmpHome: string; scenarioPath: string }): Promise<ServerHandle> {
  const { tmpHome: home, scenarioPath } = opts;
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn("node", ["dist/start-server.mjs"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: home,
        PORT: String(port),
        NODE_ENV: "production",
        FAKE_AGENT_SCENARIO: scenarioPath,
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
        reject(new Error(`Server exited with code ${code} before listening.\n${stderr}`));
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Server did not start within 15s.\n${stderr}`));
      }
    }, 15_000);
  });
}

const defaultHeaders = { Cookie: `band_token=${DEFAULT_TOKEN}` };

async function trpcMutate(url: string, procedure: string, input: unknown) {
  return fetch(`${url}/trpc/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...defaultHeaders },
    body: JSON.stringify(input),
  });
}

interface StreamEvent {
  type: string;
  eventId?: number;
  data?: unknown;
  delta?: string;
  text?: string;
}

/**
 * Open a tasks.stream WebSocket subscription and collect events until the
 * subscription completes (or the timeout fires).
 */
function wsStream(
  serverUrl: string,
  input: unknown,
  opts?: { timeoutMs?: number },
): Promise<StreamEvent[]> {
  const wsUrl = `${serverUrl.replace(/^http/, "ws")}/trpc`;
  const timeoutMs = opts?.timeoutMs ?? 10_000;

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers: defaultHeaders });
    const events: StreamEvent[] = [];
    let timer: ReturnType<typeof setTimeout>;

    function finish() {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolve(events);
    }

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "subscription",
          params: { path: "tasks.stream", input },
        }),
      );
    });

    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as {
        result?: { type: string; data?: unknown };
      };
      if (msg.result?.type === "data" && msg.result.data && typeof msg.result.data === "object") {
        events.push(msg.result.data as StreamEvent);
      }
      if (msg.result?.type === "stopped") finish();
    });

    ws.on("error", finish);
    ws.on("close", finish);
    timer = setTimeout(finish, timeoutMs);
  });
}

/**
 * Submit a task and concurrently open a stream subscription so we don't miss
 * early events. Returns the events collected from the stream.
 */
async function submitAndStream(
  serverUrl: string,
  input: {
    workspaceId: string;
    chatId: string;
    prompt: string;
    sessionId?: string;
  },
): Promise<{ submitOk: boolean; events: StreamEvent[] }> {
  const streamPromise = wsStream(serverUrl, {
    workspaceId: input.workspaceId,
    chatId: input.chatId,
    ...(input.sessionId && { sessionId: input.sessionId }),
  });

  // Tiny delay so the WS subscription is registered before we submit.
  // This matches the production client (which awaits submit before
  // opening the stream); the tighter race is exactly what Phase 2b
  // catch-up was meant to fix.
  await new Promise((r) => setTimeout(r, 50));

  const submitRes = await trpcMutate(serverUrl, "tasks.submit", input);
  const events = await streamPromise;
  return { submitOk: submitRes.ok, events };
}

// ---------------------------------------------------------------------------
// Scenario — emits one assistant text + result success per fake-agent run.
// fake-agent.mjs spawns a fresh process for each task, so submitting two
// tasks back-to-back replays this scenario twice.
// ---------------------------------------------------------------------------

function quickSuccessScenario() {
  return [
    { type: "system", subtype: "init", session_id: "session-multi-1" },
    {
      type: "assistant",
      message: { content: [{ type: "text", text: "Response from agent." }] },
    },
    {
      type: "result",
      subtype: "success",
      session_id: "session-multi-1",
      duration_ms: 100,
      num_turns: 1,
      total_cost_usd: 0.01,
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("chat — sending two messages in a single chat pane", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, createDefaultState(tmpHome));
    seedSettings(tmpHome, defaultSettings());
    const scenarioPath = writeScenario(tmpHome, quickSuccessScenario());
    server = await startServer({ tmpHome, scenarioPath });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("second message produces its own stream — not a replay of the first", async () => {
    const workspaceId = "testproject-main";
    const chatId = "chat-multimessage-1";

    // --- Message 1 -------------------------------------------------------
    const first = await submitAndStream(server.url, {
      workspaceId,
      chatId,
      prompt: "first message",
    });
    expect(first.submitOk).toBe(true);
    const firstTypes = first.events.map((e) => e.type);
    expect(firstTypes).toContain("data-session");
    expect(firstTypes).toContain("text-delta");
    expect(firstTypes).toContain("finish");

    const firstSessionId = (
      first.events.find((e) => e.type === "data-session")?.data as
        | { sessionId?: string }
        | undefined
    )?.sessionId;
    expect(firstSessionId).toBeTruthy();

    const firstFinishIds = first.events
      .filter((e) => e.type === "finish")
      .map((e) => e.eventId)
      .filter((id): id is number => typeof id === "number");
    const lastEventIdOfFirst = Math.max(...firstFinishIds, 0);

    // --- Message 2 -------------------------------------------------------
    const second = await submitAndStream(server.url, {
      workspaceId,
      chatId,
      prompt: "second message",
      sessionId: firstSessionId,
    });
    expect(second.submitOk).toBe(true);

    const secondTypes = second.events.map((e) => e.type);
    expect(secondTypes).toContain("data-session");
    expect(secondTypes).toContain("text-delta");
    expect(secondTypes).toContain("finish");

    // The bug: Phase 2b replay yields every prior session event before
    // any task-2 event. With the fix, the second stream must contain
    // exactly one finish event and its events must all be newer than the
    // last event of the first task.
    const finishCount = secondTypes.filter((t) => t === "finish").length;
    expect(finishCount).toBe(1);

    const secondEventIds = second.events
      .map((e) => e.eventId)
      .filter((id): id is number => typeof id === "number");
    expect(secondEventIds.length).toBeGreaterThan(0);
    const minSecondEventId = Math.min(...secondEventIds);
    expect(minSecondEventId).toBeGreaterThan(lastEventIdOfFirst);
  });
});
