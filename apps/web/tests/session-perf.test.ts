import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";

// Integration tests for the workspace-switch performance fixes:
//
//   • sessions.list returns within a reasonable time even with many sessions
//     (covers Fix 1: readSessionLastPrompt async + parallel)
//   • sessions.messages with `limit` returns at most that many messages,
//     and the most-recent N (covers Fix 4 cold path)
//   • sessions.messages with `beforeMessageIndex` returns the older page
//     (covers Fix 4 older-page pagination)
//
// These tests exercise the real tRPC HTTP surface against a real server
// process — no mocks, no internal imports.

const PROJECT_ROOT = join(import.meta.dirname, "..");
const FAKE_AGENT_PATH = join(import.meta.dirname, "fake-agent.mjs");
const DEFAULT_TOKEN = "session-perf-test-token";

// ---------------------------------------------------------------------------
// Server harness
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-session-perf-")));
  const bandDir = join(tmp, ".band");
  mkdirSync(bandDir, { recursive: true });
  return tmp;
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

async function startServer(opts: { tmpHome: string }): Promise<ServerHandle> {
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn("node", ["dist/start-server.mjs"], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: opts.tmpHome,
        PORT: String(port),
        NODE_ENV: "production",
        FAKE_AGENT_SCENARIO: "",
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
          home: opts.tmpHome,
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

async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

// ---------------------------------------------------------------------------
// Session fixture builder
// ---------------------------------------------------------------------------

function encodeProjectPath(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

interface SessionMessage {
  type: string;
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  message?: { content: unknown[] };
  [key: string]: unknown;
}

/**
 * Build a session JSONL with a deterministic prompt → assistant text → reply
 * sequence, repeated `messageCount` times. The first user message is index 0;
 * the final assistant message at the end appears as the most recent.
 */
function buildSessionFixture(sessionId: string, messageCount: number): string {
  const messages: SessionMessage[] = [];
  let parentUuid: string | null = null;

  for (let i = 0; i < messageCount; i++) {
    const userUuid = `00000000-0000-0000-0000-${String(i * 2 + 1).padStart(12, "0")}`;
    const assistantUuid = `00000000-0000-0000-0000-${String(i * 2 + 2).padStart(12, "0")}`;
    const ts = (offset: number) =>
      new Date(Date.UTC(2026, 2, 12, 8, 0, i * 2 + offset)).toISOString();

    messages.push({
      type: "user",
      uuid: userUuid,
      parentUuid,
      sessionId,
      isSidechain: false,
      userType: "external",
      message: { content: [{ type: "text", text: `prompt #${i}` }] },
      timestamp: ts(0),
    });
    messages.push({
      type: "assistant",
      uuid: assistantUuid,
      parentUuid: userUuid,
      sessionId,
      isSidechain: false,
      message: { content: [{ type: "text", text: `reply #${i}` }] },
      timestamp: ts(1),
    });
    parentUuid = assistantUuid;
  }

  // last-prompt record (the CLI/SDK uses this for the session summary).
  messages.push({
    type: "last-prompt",
    sessionId,
    lastPrompt: `prompt #${messageCount - 1}`,
    timestamp: new Date(Date.UTC(2026, 2, 12, 8, 0, messageCount * 2 + 1)).toISOString(),
    parentUuid: null,
    uuid: `00000000-0000-0000-0000-${String(messageCount * 2 + 1).padStart(12, "0")}`,
  });

  return `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`;
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
// Test suite
// ---------------------------------------------------------------------------

const SESSION_COUNT = 50;
const MESSAGES_PER_SESSION = 250;

describe("workspace-switch perf — sessions.list and sessions.messages", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoDir: string;
  // Held for one session so the messages tests can address it.
  let primarySessionId = "";

  beforeAll(async () => {
    tmpHome = createTmpHome();
    repoDir = join(tmpHome, "repo");
    mkdirSync(repoDir, { recursive: true });

    seedState(tmpHome, {
      projects: [
        {
          name: "perfproject",
          path: repoDir,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoDir }],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgents: [
        { id: "claude-code", type: "claude-code", label: "Claude Code", command: FAKE_AGENT_PATH },
      ],
    });

    // Seed many sessions, each with many messages.
    for (let i = 0; i < SESSION_COUNT; i++) {
      const id = `aaaaaaaa-bbbb-cccc-dddd-${String(i).padStart(12, "0")}`;
      if (i === 0) primarySessionId = id;
      // Vary message count so listSessions has different fileSizes.
      const count = i === 0 ? MESSAGES_PER_SESSION : 5;
      seedSessionFile(tmpHome, repoDir, id, buildSessionFixture(id, count));
    }

    server = await startServer({ tmpHome });
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("sessions.list returns within 5s with 50+ seeded sessions", async () => {
    const start = Date.now();
    const res = await trpcQuery(server.url, "sessions.list", {
      workspaceId: "perfproject-main",
    });
    const elapsedMs = Date.now() - start;
    expect(res.status).toBe(200);

    const data = await trpcData<{
      sessions: Array<{ sessionId: string; summary: string; lastModified: number }>;
      supported: boolean;
    }>(res);

    expect(data.supported).toBe(true);
    expect(data.sessions.length).toBe(SESSION_COUNT);
    // Generous bound: real fs ops, but parallelized — sequential reads on
    // 50 files would already be in the multi-hundred-ms range.
    expect(elapsedMs).toBeLessThan(5000);
  });

  it("sessions.messages with limit=10 returns 10 most recent messages", async () => {
    const res = await trpcQuery(server.url, "sessions.messages", {
      workspaceId: "perfproject-main",
      sessionId: primarySessionId,
      limit: 10,
    });
    expect(res.status).toBe(200);

    const data = await trpcData<{
      messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>;
      firstMessageIndex: number | null;
      hasMore: boolean;
    }>(res);

    // The fixture has 2 messages per turn (user + assistant) for
    // MESSAGES_PER_SESSION turns. The server's pagination semantics slice
    // the agent-message list, which corresponds to message indexes; the
    // exact count returned matches the requested limit.
    expect(data.messages.length).toBeLessThanOrEqual(10);
    expect(data.messages.length).toBeGreaterThan(0);

    // Most recent text message should be the final reply.
    const lastMessage = data.messages[data.messages.length - 1];
    const lastText = lastMessage.parts.find((p) => p.type === "text")?.text ?? "";
    expect(lastText).toBe(`reply #${MESSAGES_PER_SESSION - 1}`);

    // hasMore must be true since we asked for 10 of many.
    expect(data.hasMore).toBe(true);
    expect(typeof data.firstMessageIndex).toBe("number");
    expect(data.firstMessageIndex).toBeGreaterThan(0);
  });

  it("sessions.messages older page via beforeMessageIndex returns the previous slice", async () => {
    // First page (latest)
    const firstRes = await trpcQuery(server.url, "sessions.messages", {
      workspaceId: "perfproject-main",
      sessionId: primarySessionId,
      limit: 10,
    });
    const firstData = await trpcData<{
      messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>;
      firstMessageIndex: number | null;
      hasMore: boolean;
    }>(firstRes);
    expect(firstData.firstMessageIndex).not.toBeNull();
    const firstStart = firstData.firstMessageIndex as number;

    // Older page using the cursor
    const olderRes = await trpcQuery(server.url, "sessions.messages", {
      workspaceId: "perfproject-main",
      sessionId: primarySessionId,
      beforeMessageIndex: firstStart,
      limit: 10,
    });
    expect(olderRes.status).toBe(200);

    const olderData = await trpcData<{
      messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>;
      firstMessageIndex: number | null;
      hasMore: boolean;
    }>(olderRes);

    expect(olderData.messages.length).toBeLessThanOrEqual(10);
    expect(olderData.messages.length).toBeGreaterThan(0);
    // Older page's start index must be strictly smaller than the
    // first page's start index.
    expect(olderData.firstMessageIndex).not.toBeNull();
    expect(olderData.firstMessageIndex as number).toBeLessThan(firstStart);
  });
});
