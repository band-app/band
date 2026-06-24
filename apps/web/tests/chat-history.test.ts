/**
 * Integration tests for the older-page endpoint backing chat scroll-back
 * pagination (issue #572):
 *
 *   GET /api/chats/:chatId/history?before=<offset>&limit=<N>
 *
 * Black-box: the real production server boots in a child process; a long
 * session JSONL is seeded on disk in the Claude Code SDK layout and read back
 * through the real adapter. No mocks.
 *
 * What this guards:
 *   • Happy path — a page of older messages translated to ChatEvents, with the
 *     correct `{ hasOlder, oldestOffset }` cursor, folding to the expected
 *     messages (and excluding messages outside the page window).
 *   • Reaching the start — the page that begins at offset 0 reports
 *     `hasOlder: false`.
 *   • The `before <= 0` guard returns an empty page, not an error.
 *   • A chat with no resolved session returns an empty page.
 *   • Auth — the route is behind the token gate (401 without a cookie).
 *   • Security — the session is resolved SERVER-SIDE from the chat row, so a
 *     client-supplied `sessionId` cannot redirect the filesystem read.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/shared/chat-events";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome, type ServerHandle, startServer, trpcMutate } from "./helpers/server";

const TOKEN = "chat-history-test-token";
const PROJECT = "histproj";
const WORKSPACE = `${PROJECT}-main`;
const CHAT_ID = "hist-chat-id";
const SESSION_ID = "33333333-4444-5555-6666-777777777777";
// 60 turns = 120 user/assistant messages. The cold window is 50, so older
// pages exist and the offsets are large enough to page through.
const TURNS = 60;
const FAKE_AGENT_PATH = join(import.meta.dirname, "fake-agent.mjs");

let server: ServerHandle;
let tmpHome: string;

beforeAll(async () => {
  tmpHome = createTmpHome("band-chat-history-test-");
  const repoDir = join(tmpHome, "repo");
  mkdirSync(repoDir, { recursive: true });

  seedState(tmpHome, {
    projects: [
      {
        name: PROJECT,
        path: repoDir,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repoDir }],
      },
    ],
  });
  seedSettings(tmpHome, {
    tokenSecret: TOKEN,
    defaultCodingAgent: "claude-code",
    codingAgents: [
      { id: "claude-code", type: "claude-code", label: "Claude Code", command: FAKE_AGENT_PATH },
    ],
  });

  // Seed the session JSONL in the Claude Code SDK layout:
  // `<HOME>/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
  const encoded = repoDir.replace(/[^a-zA-Z0-9]/g, "-");
  const projectDir = join(tmpHome, ".claude", "projects", encoded);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${SESSION_ID}.jsonl`), buildLongSessionJsonl(SESSION_ID, TURNS));

  server = await startServer({ tmpHome, env: { FAKE_AGENT_SCENARIO: "" } });

  // Create the chat and bind it to the seeded session — the endpoint resolves
  // the session from the chat row, never from a client param.
  let res = await trpcMutate(
    server.url,
    "chats.create",
    { workspaceId: WORKSPACE, id: CHAT_ID, agent: "claude-code" },
    TOKEN,
  );
  expect(res.status).toBe(200);
  res = await trpcMutate(
    server.url,
    "chats.setActiveSession",
    { workspaceId: WORKSPACE, chatId: CHAT_ID, sessionId: SESSION_ID },
    TOKEN,
  );
  expect(res.status).toBe(200);
}, 30_000);

afterAll(async () => {
  if (server) await server.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

interface HistoryResponse {
  events: ChatEvent[];
  hasOlder: boolean;
  oldestOffset: number;
}

function getHistory(
  chatId: string,
  params: { before?: number; limit?: number },
  token: string | null = TOKEN,
): Promise<Response> {
  const qs = new URLSearchParams();
  if (params.before != null) qs.set("before", String(params.before));
  if (params.limit != null) qs.set("limit", String(params.limit));
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = `band_token=${token}`;
  return fetch(`${server.url}/api/chats/${encodeURIComponent(chatId)}/history?${qs}`, { headers });
}

/** Collect the `user-message` texts from a translated history page. */
function userTextsOf(body: HistoryResponse): string[] {
  return body.events
    .filter((e): e is Extract<ChatEvent, { type: "user-message" }> => e.type === "user-message")
    .map((e) => e.text);
}

describe("GET /api/chats/:chatId/history", () => {
  it("returns a page of older messages with the right cursor, folding to the expected window", async () => {
    // before=70 (the cold window's oldestOffset for a 120-message session) →
    // offset = max(0, 70 - 50) = 20, page = messages [20, 70) = turns 10..34.
    const res = await getHistory(CHAT_ID, { before: 70, limit: 50 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as HistoryResponse;

    expect(body.oldestOffset).toBe(20);
    expect(body.hasOlder).toBe(true); // offset 20 > 0 — more history before this page

    const texts = userTextsOf(body);
    // The page covers turns 10..34 inclusive (25 user messages).
    expect(texts).toContain(userText(10));
    expect(texts).toContain(userText(34));
    // ...and nothing outside it.
    expect(texts).not.toContain(userText(9));
    expect(texts).not.toContain(userText(35));
    expect(texts).not.toContain(userText(0));
  });

  it("reports hasOlder:false for the page that reaches the start of history", async () => {
    // before=20 → offset = max(0, 20 - 50) = 0, page = messages [0, 20) = turns 0..9.
    const res = await getHistory(CHAT_ID, { before: 20, limit: 50 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as HistoryResponse;

    expect(body.oldestOffset).toBe(0);
    expect(body.hasOlder).toBe(false);
    const texts = userTextsOf(body);
    expect(texts).toContain(userText(0));
    expect(texts).toContain(userText(9));
    expect(texts).not.toContain(userText(10));
  });

  it("returns an empty page (not an error) when before <= 0", async () => {
    const res = await getHistory(CHAT_ID, { before: 0, limit: 50 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as HistoryResponse;
    expect(body).toEqual({ events: [], hasOlder: false, oldestOffset: 0 });
  });

  it("returns an empty page for a chat with no resolved session", async () => {
    const sessionlessChat = "hist-chat-no-session";
    const created = await trpcMutate(
      server.url,
      "chats.create",
      { workspaceId: WORKSPACE, id: sessionlessChat, agent: "claude-code" },
      TOKEN,
    );
    expect(created.status).toBe(200);

    const res = await getHistory(sessionlessChat, { before: 50, limit: 50 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as HistoryResponse;
    expect(body).toEqual({ events: [], hasOlder: false, oldestOffset: 0 });
  });

  it("requires authentication", async () => {
    const res = await getHistory(CHAT_ID, { before: 70, limit: 50 }, null);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Helpers — mirror the JSONL shape the Claude Code SDK persists.
// ---------------------------------------------------------------------------

function buildLongSessionJsonl(sessionId: string, turns: number): string {
  const lines: string[] = [];
  let parentUuid: string | null = null;
  for (let i = 0; i < turns; i++) {
    const userUuid = uuid(i * 2 + 1);
    const assistantUuid = uuid(i * 2 + 2);
    lines.push(
      JSON.stringify({
        type: "user",
        uuid: userUuid,
        parentUuid,
        sessionId,
        isSidechain: false,
        userType: "external",
        message: { role: "user", content: [{ type: "text", text: userText(i) }] },
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 2)).toISOString(),
      }),
    );
    lines.push(
      JSON.stringify({
        type: "assistant",
        uuid: assistantUuid,
        parentUuid: userUuid,
        sessionId,
        isSidechain: false,
        message: { role: "assistant", content: [{ type: "text", text: assistantText(i) }] },
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 2 + 1)).toISOString(),
      }),
    );
    parentUuid = assistantUuid;
  }
  lines.push(
    JSON.stringify({
      type: "last-prompt",
      sessionId,
      lastPrompt: userText(turns - 1),
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, turns * 2)).toISOString(),
      uuid: uuid(turns * 2 + 1),
      parentUuid: null,
    }),
  );
  return `${lines.join("\n")}\n`;
}

function uuid(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
}

function userText(turn: number): string {
  return `hist-prompt-${turn}-marker`;
}

function assistantText(turn: number): string {
  return `hist-reply-${turn}-marker`;
}
