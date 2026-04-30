/**
 * Multi-message chat tests.
 *
 * Sending two messages on the same chat pane (same chatId, same Claude
 * sessionId) is the simplest real-world flow and was broken by the
 * Phase 2b session-buffer replay: the second message's stream would
 * yield every event from the first message before any new events,
 * confusing the AI SDK's useChat hook.
 *
 * These tests submit two tasks back-to-back via the SSE POST endpoint,
 * stream each to completion, and assert that the second stream is scoped
 * to the second task only.
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

interface StreamEvent {
  type: string;
  data?: unknown;
  delta?: string;
  text?: string;
}

/**
 * Parse an AI SDK SSE stream response into an array of StreamEvent objects.
 */
async function parseSSEStream(response: Response): Promise<StreamEvent[]> {
  const text = await response.text();
  const events: StreamEvent[] = [];

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
    if (typeof data === "object" && data !== null && "type" in (data as Record<string, unknown>)) {
      events.push(data as StreamEvent);
    }
  }

  return events;
}

/**
 * Submit a task via the SSE POST endpoint and collect all events.
 * POST /api/tasks/:chatId/stream combines submit + stream in one request.
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
  const response = await fetch(
    `${serverUrl}/api/tasks/${encodeURIComponent(input.chatId)}/stream`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...defaultHeaders },
      body: JSON.stringify({
        workspaceId: input.workspaceId,
        prompt: input.prompt,
        ...(input.sessionId && { sessionId: input.sessionId }),
      }),
    },
  );

  if (!response.ok) {
    return { submitOk: false, events: [] };
  }

  const events = await parseSSEStream(response);
  return { submitOk: true, events };
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
    // exactly one finish event — not replayed events from the first task.
    const finishCount = secondTypes.filter((t) => t === "finish").length;
    expect(finishCount).toBe(1);
  });
});
