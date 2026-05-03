import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";

// Integration tests for issue #344 — persisted activeSessionSummary on the
// chat record + lazy-loading of sessions.list.
//
// These tests assert the full server contract through the tRPC HTTP surface:
//
//   • chats.get with a persisted summary returns the cached value without
//     touching ~/.claude/projects/ (the JSONL file gets renamed mid-test
//     and the persisted summary still wins).
//
//   • chats.get's background refresh closes the gap when the JSONL has
//     drifted (e.g. simulating /rename) — the next read returns the fresh
//     summary.
//
//   • The fallback path (no persisted activeSessionId) selects the latest
//     session via mtime + a single getSessionInfo, then persists it on the
//     chat row so subsequent reads stay on the SQLite-only hot path.
//
//   • chats.setActiveSession resolves the summary inline so the next
//     chats.get carries the fresh title without waiting for a background
//     cycle.
//
//   • sessions.list is NOT called as part of chats.get on the hot path —
//     consumers (the chat pane) only invoke it when the user opens the
//     history dropdown.

const PROJECT_ROOT = join(import.meta.dirname, "..");
const FAKE_AGENT_PATH = join(import.meta.dirname, "fake-agent.mjs");
const DEFAULT_TOKEN = "persisted-summary-test-token";

// ---------------------------------------------------------------------------
// Server harness
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-persisted-summary-")));
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

const defaultHeaders = {
  Cookie: `band_token=${DEFAULT_TOKEN}`,
  "Content-Type": "application/json",
};

async function trpcQuery(serverUrl: string, procedure: string, input?: unknown) {
  const url =
    input !== undefined
      ? `${serverUrl}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${serverUrl}/trpc/${procedure}`;
  return fetch(url, { headers: defaultHeaders });
}

async function trpcMutation(serverUrl: string, procedure: string, input: unknown) {
  return fetch(`${serverUrl}/trpc/${procedure}`, {
    method: "POST",
    headers: defaultHeaders,
    body: JSON.stringify(input),
  });
}

async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

// ---------------------------------------------------------------------------
// Session JSONL fixture
// ---------------------------------------------------------------------------

function encodeProjectPath(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, "-");
}

function projectsDir(tmpHome: string, workspacePath: string): string {
  return join(tmpHome, ".claude", "projects", encodeProjectPath(workspacePath));
}

interface SessionFixtureOptions {
  sessionId: string;
  /** First (and only) user prompt in the session. Doubles as the firstPrompt. */
  firstPrompt: string;
  /** Final last-prompt record — surfaced as the session summary. */
  lastPrompt: string;
  cwd: string;
  /** Optional ISO timestamp prefix; otherwise a deterministic 2026 date is used. */
  timestamp?: string;
  /** Optional override mtime (ms epoch) for the JSONL file. */
  mtimeMs?: number;
  /** Optional /rename customTitle value. */
  customTitle?: string;
}

function buildSessionJsonl(opts: SessionFixtureOptions): string {
  const ts = opts.timestamp ?? "2026-04-01T08:00:00.000Z";
  const userUuid = `00000000-0000-0000-0000-${opts.sessionId.slice(-12)}`;
  const records: Array<Record<string, unknown>> = [
    {
      type: "summary",
      summary: "Session summary",
      leafUuid: userUuid,
    },
    {
      type: "user",
      uuid: userUuid,
      parentUuid: null,
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      isSidechain: false,
      userType: "external",
      message: { role: "user", content: [{ type: "text", text: opts.firstPrompt }] },
      timestamp: ts,
    },
    {
      type: "last-prompt",
      sessionId: opts.sessionId,
      lastPrompt: opts.lastPrompt,
      timestamp: ts,
      uuid: `99999999-9999-9999-9999-${opts.sessionId.slice(-12)}`,
      parentUuid: null,
    },
  ];
  if (opts.customTitle) {
    records.unshift({ type: "customTitle", customTitle: opts.customTitle });
  }
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

function seedSessionFile(
  tmpHome: string,
  workspacePath: string,
  opts: SessionFixtureOptions,
): void {
  const dir = projectsDir(tmpHome, workspacePath);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${opts.sessionId}.jsonl`);
  writeFileSync(file, buildSessionJsonl(opts));
  if (opts.mtimeMs !== undefined) {
    const time = opts.mtimeMs / 1000;
    utimesSync(file, time, time);
  }
}

function rewriteSessionLastPrompt(
  tmpHome: string,
  workspacePath: string,
  opts: SessionFixtureOptions,
): void {
  const file = join(projectsDir(tmpHome, workspacePath), `${opts.sessionId}.jsonl`);
  writeFileSync(file, buildSessionJsonl(opts));
}

// ---------------------------------------------------------------------------
// Helpers around the chats.* tRPC surface
// ---------------------------------------------------------------------------

interface ChatRecord {
  id: string;
  workspaceId: string;
  agent: string;
  activeSessionId?: string | null;
  activeSessionSummary?: string | null;
  activeSessionLastModified?: number | null;
}

async function getChat(serverUrl: string, chatId: string): Promise<ChatRecord | null> {
  const res = await trpcQuery(serverUrl, "chats.get", { chatId });
  expect(res.status).toBe(200);
  const data = await trpcData<{ chat: ChatRecord | null }>(res);
  return data.chat;
}

async function setActiveSession(
  serverUrl: string,
  workspaceId: string,
  chatId: string,
  sessionId: string | undefined,
): Promise<void> {
  const res = await trpcMutation(serverUrl, "chats.setActiveSession", {
    workspaceId,
    chatId,
    sessionId,
  });
  expect(res.status).toBe(200);
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms; last value: ${JSON.stringify(last)}`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const SESSION_A = "aaaaaaaa-bbbb-cccc-dddd-000000000001";
const SESSION_B = "aaaaaaaa-bbbb-cccc-dddd-000000000002";
const SESSION_C = "aaaaaaaa-bbbb-cccc-dddd-000000000003";

describe("chats.get — persisted activeSessionSummary", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let repoDir: string;
  const workspaceId = "summaryproject-main";

  beforeAll(async () => {
    tmpHome = createTmpHome();
    repoDir = join(tmpHome, "repo");
    mkdirSync(repoDir, { recursive: true });

    seedState(tmpHome, {
      projects: [
        {
          name: "summaryproject",
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

    // Three sessions with strictly-ordered mtimes so getLatestSession is
    // deterministic.
    seedSessionFile(tmpHome, repoDir, {
      sessionId: SESSION_A,
      firstPrompt: "first session: explore",
      lastPrompt: "explore the codebase",
      cwd: repoDir,
      mtimeMs: Date.UTC(2026, 3, 1, 8, 0, 0),
    });
    seedSessionFile(tmpHome, repoDir, {
      sessionId: SESSION_B,
      firstPrompt: "second session: refactor",
      lastPrompt: "refactor the API client",
      cwd: repoDir,
      mtimeMs: Date.UTC(2026, 3, 2, 8, 0, 0),
    });
    seedSessionFile(tmpHome, repoDir, {
      sessionId: SESSION_C,
      firstPrompt: "third session: latest work",
      lastPrompt: "latest work in progress",
      cwd: repoDir,
      mtimeMs: Date.UTC(2026, 3, 3, 8, 0, 0),
    });

    server = await startServer({ tmpHome });
  }, 30_000);

  afterAll(async () => {
    await server?.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("setActiveSession resolves and persists the summary inline", async () => {
    const chatId = `chat_${Date.now()}_set`;

    await setActiveSession(server.url, workspaceId, chatId, SESSION_A);

    const chat = await getChat(server.url, chatId);
    expect(chat).not.toBeNull();
    expect(chat?.activeSessionId).toBe(SESSION_A);
    // The summary chain prefers the last-prompt record once present —
    // matches the listSessions output for behaviour parity.
    expect(chat?.activeSessionSummary).toBe("explore the codebase");
    expect(typeof chat?.activeSessionLastModified).toBe("number");
  });

  it("chats.get with a persisted summary returns the cached value even when the JSONL is gone", async () => {
    const chatId = `chat_${Date.now()}_cached`;
    await setActiveSession(server.url, workspaceId, chatId, SESSION_A);

    // Confirm cached.
    const before = await getChat(server.url, chatId);
    expect(before?.activeSessionSummary).toBe("explore the codebase");

    // Move the JSONL out of the way — the next chats.get should still
    // return the cached summary because it's a SQLite read. (The
    // background refresh sees `undefined` from getSessionInfo and leaves
    // the cached values intact.)
    const file = join(projectsDir(tmpHome, repoDir), `${SESSION_A}.jsonl`);
    const moved = `${file}.bak`;
    const fs = await import("node:fs/promises");
    await fs.rename(file, moved);
    try {
      const after = await getChat(server.url, chatId);
      expect(after?.activeSessionSummary).toBe("explore the codebase");
      expect(after?.activeSessionId).toBe(SESSION_A);
    } finally {
      await fs.rename(moved, file);
    }
  });

  it("background refresh picks up a renamed session on the next chats.get", async () => {
    const chatId = `chat_${Date.now()}_rename`;
    await setActiveSession(server.url, workspaceId, chatId, SESSION_B);
    const before = await getChat(server.url, chatId);
    expect(before?.activeSessionSummary).toBe("refactor the API client");

    // Simulate a /rename by writing a customTitle into the JSONL —
    // mapSessionInfo's priority chain picks customTitle first.
    rewriteSessionLastPrompt(tmpHome, repoDir, {
      sessionId: SESSION_B,
      firstPrompt: "second session: refactor",
      lastPrompt: "refactor the API client",
      customTitle: "Renamed: API refactor",
      cwd: repoDir,
    });

    // The first chats.get after the rewrite still serves the cached
    // value, and kicks off a background refresh. Poll subsequent reads
    // until the refreshed value appears (the background task is
    // fire-and-forget so we don't know exactly when it lands).
    const refreshed = await pollUntil(
      () => getChat(server.url, chatId),
      (chat) => chat?.activeSessionSummary === "Renamed: API refactor",
      { timeoutMs: 4000 },
    );
    expect(refreshed?.activeSessionSummary).toBe("Renamed: API refactor");
    expect(refreshed?.activeSessionId).toBe(SESSION_B);
  });

  /**
   * Touch SESSION_C's JSONL so its mtime is the newest among the seeded
   * sessions. Earlier tests rewrite SESSION_B's file (no mtime override),
   * which would otherwise win the mtime race. Tests that exercise the
   * fallback path call this to make the expected outcome deterministic.
   */
  function makeSessionCNewest(): void {
    const future = (Date.now() + 60_000) / 1000;
    const file = join(projectsDir(tmpHome, repoDir), `${SESSION_C}.jsonl`);
    utimesSync(file, future, future);
  }

  it("fallback (no persisted activeSessionId) selects the mtime-newest session and persists it", async () => {
    makeSessionCNewest();

    // Create a chat row WITHOUT calling setActiveSession first. Use
    // chats.create so the row exists with no activeSessionId.
    const chatId = `chat_${Date.now()}_fallback`;
    const created = await trpcMutation(server.url, "chats.create", {
      workspaceId,
      id: chatId,
    });
    expect(created.status).toBe(200);

    // First chats.get should resolve the fallback (newest = SESSION_C)
    // and return the persisted row.
    const first = await getChat(server.url, chatId);
    expect(first?.activeSessionId).toBe(SESSION_C);
    expect(first?.activeSessionSummary).toBe("latest work in progress");
    expect(typeof first?.activeSessionLastModified).toBe("number");

    // Subsequent reads should be pure SQLite — same values, no drift.
    const second = await getChat(server.url, chatId);
    expect(second?.activeSessionId).toBe(SESSION_C);
    expect(second?.activeSessionSummary).toBe("latest work in progress");
  });

  it("setActiveSession with sessionId=undefined clears both id and summary", async () => {
    makeSessionCNewest();

    const chatId = `chat_${Date.now()}_clear`;
    await setActiveSession(server.url, workspaceId, chatId, SESSION_A);
    const before = await getChat(server.url, chatId);
    expect(before?.activeSessionId).toBe(SESSION_A);
    expect(before?.activeSessionSummary).toBe("explore the codebase");

    await setActiveSession(server.url, workspaceId, chatId, undefined);
    // The next chats.get sees no activeSessionId — the fallback resolver
    // kicks in and picks the latest session. Verify it's not the
    // session we just cleared.
    const after = await getChat(server.url, chatId);
    expect(after?.activeSessionId).toBe(SESSION_C);
    expect(after?.activeSessionSummary).toBe("latest work in progress");
  });
});
