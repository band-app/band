// Integration test for the OpenCode `session-id-resolved` → chat-row
// persistence path.
//
// OpenCode emits a placeholder UUID in its `session-start` event, then
// resolves its real `ses_…` id after the run and emits `session-id-resolved`.
// Band's `task-service` must persist that resolved id onto the chat row —
// otherwise `chat.activeSessionId` keeps the placeholder UUID, and anything
// that reads it (resume, the chat tab's "Continue in terminal") builds an
// `opencode --session <uuid>` command that OpenCode rejects with
// "Invalid session ID: Expected a string starting with 'ses'".
//
// This was a latent bug (in-app resume silently retried without `--session`,
// creating a fresh session) surfaced by the "Continue in terminal" feature.
//
// Real production server (`dist/start-server.mjs`), real SQLite, real task
// pipeline. The only stub is the `opencode` binary itself: a tiny Node
// script that speaks the two subcommands the adapter drives — `run`
// (NDJSON output) and `session list` (returns the real `ses_…` id). No
// tRPC mocking.

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toWorkspaceId } from "@/dashboard";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const RESOLVED_SESSION_ID = "ses_stubresolved0123456789";

/**
 * Stub `opencode` binary. Handles the subcommands the adapter drives:
 *   - `run --format json …` → one NDJSON text event, then exit 0.
 *   - `session list --format json` → a one-element array carrying the real
 *     `ses_…` id the adapter resolves to.
 *   - anything else (`models --verbose`, `export …`) → no-op success, so the
 *     boot model-refresh and the lazy summary lookup degrade gracefully.
 */
function writeOpencodeStub(tmpHome: string): string {
  const binPath = join(tmpHome, "opencode-stub.mjs");
  writeFileSync(
    binPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run") {
  process.stdout.write(JSON.stringify({ type: "text", part: { text: "ok from opencode stub" } }) + "\\n");
  process.exit(0);
}
if (args[0] === "session" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ id: ${JSON.stringify(RESOLVED_SESSION_ID)}, updated: Date.now(), title: "stub session" }]));
  process.exit(0);
}
process.exit(0);
`,
    "utf-8",
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

async function createChat(serverUrl: string, workspaceId: string, token: string): Promise<string> {
  const res = await trpcMutate(
    serverUrl,
    "chats.create",
    { workspaceId, agent: "opencode" },
    token,
  );
  const body = await res.text();
  expect(res.status, `chats.create failed: ${body}`).toBe(200);
  return (JSON.parse(body) as { result: { data: { chat: { id: string } } } }).result.data.chat.id;
}

async function getChat(
  serverUrl: string,
  chatId: string,
  token: string,
): Promise<{ activeSessionId?: string } | null> {
  const res = await trpcQuery(serverUrl, "chats.get", { chatId }, token);
  const body = await res.text();
  expect(res.status, `chats.get failed: ${body}`).toBe(200);
  return (JSON.parse(body) as { result: { data: { chat: { activeSessionId?: string } | null } } })
    .result.data.chat;
}

describe("OpenCode session-id-resolved persists the real ses_ id on the chat row", () => {
  const TOKEN = "opencode-session-resolved-token";
  const PROJECT = "ocproj";
  const WORKSPACE_ID = toWorkspaceId(PROJECT, "main");
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-opencode-session-resolved-");
    // The worktree dir must exist on disk — the adapter spawns the stub
    // with it as cwd.
    const worktreePath = join(tmpHome, PROJECT);
    mkdirSync(worktreePath, { recursive: true });
    const stubBin = writeOpencodeStub(tmpHome);
    seedState(tmpHome, {
      projects: [
        {
          name: PROJECT,
          path: worktreePath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: worktreePath }],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: TOKEN,
      codingAgents: [{ id: "opencode", type: "opencode", label: "OpenCode", command: stubBin }],
      defaultCodingAgent: "opencode",
    });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("chat.activeSessionId becomes the resolved ses_ id, not the placeholder UUID", async () => {
    const chatId = await createChat(server.url, WORKSPACE_ID, TOKEN);

    // Kick off a new session (no sessionId) — the adapter emits a
    // placeholder UUID up front, then resolves the real ses_ id.
    const sendRes = await trpcMutate(
      server.url,
      "chats.send",
      { workspaceId: WORKSPACE_ID, chatId, message: "hello opencode" },
      TOKEN,
    );
    const sendBody = await sendRes.text();
    expect(sendRes.status, sendBody).toBe(200);

    // Poll the persisted chat row until the resolved id lands. Before the
    // fix this stayed the placeholder UUID forever and the poll would time
    // out (the regression guard).
    const activeSessionId = await waitFor(
      async () => {
        const chat = await getChat(server.url, chatId, TOKEN);
        return chat?.activeSessionId === RESOLVED_SESSION_ID ? chat.activeSessionId : undefined;
      },
      { label: "chat row carries the resolved ses_ id" },
    );
    expect(activeSessionId).toBe(RESOLVED_SESSION_ID);
    // And it is NOT a bare UUID placeholder.
    expect(activeSessionId.startsWith("ses_")).toBe(true);
  });

  it("rejects chats.send without the band_token cookie (401)", async () => {
    // The shared `trpcMutate` always sends the cookie, so call `fetch`
    // directly to omit it — this file drives `chats.send`, so it owns the
    // baseline auth guard for that surface. Mirrors the auth checks in
    // `chat-continue-in-terminal.test.ts` / `workspace-create-via`.
    const res = await fetch(`${server.url}/trpc/chats.send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: WORKSPACE_ID, chatId: "chat_whatever", message: "x" }),
    });
    expect(res.status).toBe(401);
  });
});
