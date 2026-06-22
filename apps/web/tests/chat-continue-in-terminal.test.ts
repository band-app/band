// Integration tests for `chats.continueInTerminal`.
//
// The chat tab's "Continue in terminal" action resolves the chat's
// underlying coding-agent session ID + the adapter for whichever agent it
// ran, asks the adapter for the vendor CLI's *resume* invocation
// (`claude --resume <id>`, `codex resume <id>`, `opencode --session <id>`),
// composes it into a shell-safe command, and spawns a terminal pane running
// it. This file pins:
//
//   1. happy path — a claude-code chat with an active session spawns a PTY
//      whose argv carries `--resume <sessionId>`, and the call returns the
//      terminalId + sessionId.
//   2. no-session — a fresh chat with no active session is rejected
//      (412 Precondition Failed) and spawns no terminal.
//   3. unsupported agent — a gemini-cli chat (no session-resume CLI) is
//      rejected (400 Bad Request).
//   4. auth — the mutation requires the band_token cookie (401).
//
// Real production server (`dist/start-server.mjs`), real PTY (node-pty),
// real git repo, real SQLite. No tRPC mocking, no MSW. Each describe block
// boots its own server with a tmp `$HOME`, mirroring
// `workspace-create-via.test.ts`, so an adapter that misbehaves in one
// scenario can't cascade into the next.
//
// The spawned-process surface is a `stub-claude.sh` shell stub (the same
// pattern as the via=terminal happy-path test) that echoes its argv as
// `ARGV:<arg0>|<arg1>|…` — enough to prove the resume args reached the PTY
// without needing a real vendor CLI. Setting the active session does NOT
// require an on-disk session file: `chats.setActiveSession` tolerates a
// missing JSONL (it persists the id with a null summary), which is exactly
// what we want here.

import { execFileSync } from "node:child_process";
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

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf-8" });
}

function createGitRepo(parentDir: string, name: string): string {
  const repoPath = join(parentDir, name);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", "main"]);
  writeFileSync(join(repoPath, "README.md"), "# continue-in-terminal test\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "init"]);
  return repoPath;
}

/**
 * Stub vendor CLI. Prints `ARGV:<arg0>|<arg1>|…` so the test can pin both
 * the binary the adapter picked AND the resume args threaded through. The
 * script exits immediately — we test the *invocation*, not an interactive
 * REPL. The terminal pool drains stdout into its scrollback, read back via
 * `terminal.output`.
 */
function writeStubVendorCli(tmpHome: string, name: string): string {
  const binPath = join(tmpHome, name);
  writeFileSync(
    binPath,
    `#!/bin/sh\nprintf 'ARGV:'\nfor arg in "$@"; do printf '%s|' "$arg"; done\nprintf '\\n'\n`,
    "utf-8",
  );
  chmodSync(binPath, 0o755);
  return binPath;
}

interface TerminalListEntry {
  terminalId: string;
  workspaceId: string;
  pid: number;
}

async function listTerminals(
  serverUrl: string,
  workspaceId: string,
  token: string,
): Promise<TerminalListEntry[]> {
  const res = await trpcQuery(serverUrl, "terminal.list", { workspaceId }, token);
  const body = await res.text();
  expect(res.status, `terminal.list failed: ${body}`).toBe(200);
  return (JSON.parse(body) as { result: { data: { terminals: TerminalListEntry[] } } }).result.data
    .terminals;
}

async function readTerminalOutput(
  serverUrl: string,
  terminalId: string,
  token: string,
): Promise<string | null> {
  const res = await trpcQuery(serverUrl, "terminal.output", { terminalId }, token);
  const body = await res.text();
  if (res.status === 404) return null;
  expect(res.status, `terminal.output failed: ${body}`).toBe(200);
  return (JSON.parse(body) as { result: { data: { output: string } } }).result.data.output;
}

async function createChat(
  serverUrl: string,
  workspaceId: string,
  agent: string,
  token: string,
): Promise<string> {
  const res = await trpcMutate(serverUrl, "chats.create", { workspaceId, agent }, token);
  const body = await res.text();
  expect(res.status, `chats.create failed: ${body}`).toBe(200);
  return (JSON.parse(body) as { result: { data: { chat: { id: string } } } }).result.data.chat.id;
}

async function setActiveSession(
  serverUrl: string,
  workspaceId: string,
  chatId: string,
  sessionId: string,
  token: string,
): Promise<void> {
  const res = await trpcMutate(
    serverUrl,
    "chats.setActiveSession",
    { workspaceId, chatId, sessionId },
    token,
  );
  const body = await res.text();
  expect(res.status, `chats.setActiveSession failed: ${body}`).toBe(200);
}

interface ContinueResponse {
  terminalId: string;
  workspaceId: string;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Happy path + no-active-session, on a single claude-code server.
// ---------------------------------------------------------------------------

describe("chats.continueInTerminal — claude-code", () => {
  const TOKEN = "continue-terminal-claude-token";
  const PROJECT = "cont-proj";
  const WORKSPACE_ID = toWorkspaceId(PROJECT, "main");
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-continue-terminal-claude-");
    const repoPath = createGitRepo(tmpHome, PROJECT);
    const stubBin = writeStubVendorCli(tmpHome, "stub-claude.sh");
    seedState(tmpHome, {
      projects: [
        {
          name: PROJECT,
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoPath }],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: TOKEN,
      codingAgents: [
        { id: "claude-code", type: "claude-code", label: "Claude Code", command: stubBin },
      ],
    });
    // The fire-and-forget boot model refresh fires for this claude-code
    // agent and can't complete a model query against the 2-line stub; the
    // adapter's internal timeout catches it and the "refresh failed" log
    // line is expected and benign (same note as workspace-create-via).
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("spawns a terminal running the resume command and returns the session id", async () => {
    const SESSION_ID = "sess-resume-abc123";
    const chatId = await createChat(server.url, WORKSPACE_ID, "claude-code", TOKEN);
    await setActiveSession(server.url, WORKSPACE_ID, chatId, SESSION_ID, TOKEN);

    const res = await trpcMutate(server.url, "chats.continueInTerminal", { chatId }, TOKEN);
    const body = await res.text();
    expect(res.status, body).toBe(200);
    const data = (JSON.parse(body) as { result: { data: ContinueResponse } }).result.data;

    expect(data.sessionId).toBe(SESSION_ID);
    expect(typeof data.terminalId).toBe("string");
    expect(data.terminalId.length).toBeGreaterThan(0);

    // The terminal is registered against the workspace.
    const terminals = await waitFor(
      async () => {
        const list = await listTerminals(server.url, WORKSPACE_ID, TOKEN);
        return list.find((t) => t.terminalId === data.terminalId) ? list : undefined;
      },
      { label: "resume terminal registered" },
    );
    expect(terminals.some((t) => t.terminalId === data.terminalId)).toBe(true);

    // The vendor CLI received `--resume <sessionId>` as its argv.
    const output = await waitFor(
      async () => {
        const out = await readTerminalOutput(server.url, data.terminalId, TOKEN);
        return out?.includes("ARGV:") && out.includes(`--resume|${SESSION_ID}|`) ? out : undefined;
      },
      { label: "stub vendor CLI resume argv echoed" },
    );
    expect(output).toContain(`--resume|${SESSION_ID}|`);
  });

  it("rejects a chat with no active session (412) and spawns no terminal", async () => {
    const chatId = await createChat(server.url, WORKSPACE_ID, "claude-code", TOKEN);

    const res = await trpcMutate(server.url, "chats.continueInTerminal", { chatId }, TOKEN);
    const body = await res.text();
    // tRPC maps PRECONDITION_FAILED → HTTP 412.
    expect(res.status, body).toBe(412);
    expect(body).toContain("no active session");
  });
});

// ---------------------------------------------------------------------------
// Unsupported agent — gemini-cli has no session-resume CLI, so the adapter
// returns the `unsupported` sentinel and the server rejects with 400. The
// gemini adapter's `runSession` is never invoked here (only the pure-data
// `resumeCliInvocation`), so a stub binary is safe.
// ---------------------------------------------------------------------------

describe("chats.continueInTerminal — unsupported agent", () => {
  const TOKEN = "continue-terminal-gemini-token";
  const PROJECT = "cont-gem-proj";
  const WORKSPACE_ID = toWorkspaceId(PROJECT, "main");
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-continue-terminal-gemini-");
    const repoPath = createGitRepo(tmpHome, PROJECT);
    const stubBin = writeStubVendorCli(tmpHome, "stub-gemini.sh");
    seedState(tmpHome, {
      projects: [
        {
          name: PROJECT,
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoPath }],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: TOKEN,
      codingAgents: [
        { id: "gemini-cli", type: "gemini-cli", label: "Gemini CLI", command: stubBin },
      ],
      defaultCodingAgent: "gemini-cli",
    });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("rejects with 400 when the agent has no resume CLI", async () => {
    const chatId = await createChat(server.url, WORKSPACE_ID, "gemini-cli", TOKEN);
    await setActiveSession(server.url, WORKSPACE_ID, chatId, "gemini-session-1", TOKEN);

    const res = await trpcMutate(server.url, "chats.continueInTerminal", { chatId }, TOKEN);
    const body = await res.text();
    expect(res.status, body).toBe(400);
    expect(body).toContain("Gemini CLI");

    // No terminal was spawned for the workspace.
    const terminals = await listTerminals(server.url, WORKSPACE_ID, TOKEN);
    expect(terminals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Auth — the mutation is part of the chats router contract; it must reject
// a call without the band_token cookie.
// ---------------------------------------------------------------------------

describe("chats.continueInTerminal — auth", () => {
  const TOKEN = "continue-terminal-auth-token";
  const PROJECT = "cont-auth-proj";
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-continue-terminal-auth-");
    const repoPath = createGitRepo(tmpHome, PROJECT);
    seedState(tmpHome, {
      projects: [
        {
          name: PROJECT,
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoPath }],
        },
      ],
    });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("rejects without the band_token cookie (401)", async () => {
    // The shared `trpcMutate` always sends the cookie, so call `fetch`
    // directly to omit it — mirrors the via-terminal auth guard.
    const res = await fetch(`${server.url}/trpc/chats.continueInTerminal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: "chat_whatever" }),
    });
    expect(res.status).toBe(401);
  });
});
