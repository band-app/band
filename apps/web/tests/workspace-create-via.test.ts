// Integration tests for `workspaces.create --via` (issue #551).
//
// Covers the three dispatch paths exposed by the new `via` field:
//
//   1. via=terminal      — server resolves the adapter's `cliInvocation`,
//                           spawns a PTY pane via terminalService, and
//                           returns a `terminalId` in the response.
//   2. via=chat (default) — existing chat-pane dispatch; no terminal pane
//                           is spawned, no `terminalId` is returned.
//   3. via=terminal + unsupported adapter — server falls back to chat and
//                           reports `via: "chat"` in the response, so a
//                           CLI caller can tell the fallback happened.
//
// We also pin the cleanup side: `workspaces.remove` must kill the PTY
// that `via=terminal` spawned (issue #551 acceptance criterion).
//
// Real production server (`dist/start-server.mjs`), real PTY (node-pty),
// real git repo, real SQLite. No tRPC mocking, no MSW. Each describe
// block boots its own server with a tmp `$HOME` so a regression that
// crashes the server (e.g. an SDK adapter that panics on a malformed
// stub) is contained to one scenario instead of cascading into the next
// test's `beforeAll`.
//
// Two stubs are used for the spawned-process surface:
//
//   - **stub-claude.sh** — a 2-line shell script that echoes its argv.
//     Used by the `via=terminal` happy path because the assertion is
//     "the prompt landed in argv[1]". The script exits immediately;
//     node-pty captures the stdout into the terminal scrollback.
//
//   - **fake-agent.mjs** — the project's shared Claude-Agent-SDK
//     protocol stub (`apps/web/tests/fake-agent.mjs`). Used by the
//     `via=chat` paths because the chat-path dispatch invokes
//     `taskService.submitTask`, which spawns the real SDK and reads
//     JSONL events back. A shell stub that doesn't speak the protocol
//     hangs / crashes the SDK subprocess on Linux CI — fake-agent
//     emits a success scenario and exits cleanly.

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

const FAKE_AGENT_PATH = join(import.meta.dirname, "fake-agent.mjs");

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
  writeFileSync(join(repoPath, "README.md"), "# via test\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "init"]);
  return repoPath;
}

/**
 * Stub vendor CLI for the `via=terminal` path. Prints
 * `ARGV:<arg0>|<arg1>|...` so the test can pin both the binary path the
 * adapter picked AND the prompt that was threaded through as positional
 * argument #1. The script terminates immediately — we don't need an
 * interactive REPL because we're testing the *invocation*, not the
 * conversation. The terminal pool drains stdout into its scrollback
 * buffer; the test reads it back via `terminal.output`.
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

/**
 * Minimal fake-agent scenario: emit `system.init`, then a terminal
 * `result` event so `taskService.submitTask` records a completed task
 * and tears down the agent cleanly. Used by every test whose dispatch
 * path lands on the chat (taskService.submitTask) side — without a
 * proper SDK-protocol stub, the Claude-Agent-SDK would hang or crash
 * its subprocess waiting for an `init` reply, which on Linux CI cascades
 * into the server process and breaks subsequent tests in the file.
 */
function writeChatScenario(tmpHome: string, name: string): string {
  const scenarioPath = join(tmpHome, name);
  writeFileSync(
    scenarioPath,
    JSON.stringify([
      { type: "system", subtype: "init", session_id: "chat-via-session" },
      { type: "result", subtype: "success", result: "Done" },
    ]),
    "utf-8",
  );
  return scenarioPath;
}

interface TerminalListEntry {
  terminalId: string;
  workspaceId: string;
  pid: number;
}

interface TaskListItem {
  id: string;
  workspaceId: string;
  prompt: string;
  status: string;
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

async function listTasksForWorkspace(
  serverUrl: string,
  workspaceId: string,
  token: string,
): Promise<TaskListItem[]> {
  const res = await trpcQuery(serverUrl, "tasks.list", { workspaceId }, token);
  const body = await res.text();
  expect(res.status, `tasks.list failed: ${body}`).toBe(200);
  return (JSON.parse(body) as { result: { data: { tasks: TaskListItem[] } } }).result.data.tasks;
}

interface CreateResponse {
  ok: true;
  path: string;
  via?: "chat" | "terminal";
  terminalId?: string;
}

// ---------------------------------------------------------------------------
// via=terminal — happy path + cleanup
//
// Uses `stub-claude.sh` (raw shell stub) because the assertion is the
// command line the terminal pool wrote to the PTY. Each scenario lives
// in its own describe block to keep agent failures from cascading into
// other tests (Linux CI exposes SDK-subprocess fragility that macOS
// hides). ---------------------------------------------------------------------------

describe("workspaces.create via=terminal happy path", () => {
  const TOKEN = "wc-via-terminal-happy-token";
  let server: ServerHandle;
  let tmpHome: string;
  let stubBin: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-via-terminal-happy-");
    const repoPath = createGitRepo(tmpHome, "viaproj");
    stubBin = writeStubVendorCli(tmpHome, "stub-claude.sh");
    seedState(tmpHome, {
      projects: [
        {
          name: "viaproj",
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
    // Note: the fire-and-forget boot refresh fires for this seeded
    // claude-code agent and the SDK can't complete a model query against
    // the 2-line `stub-claude.sh`. The 10 s timeout in
    // `ClaudeCodeAdapter.refreshModels()` catches the wedge; the
    // resulting "refresh failed" log line is expected and benign.
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("spawns a terminal with the prompt as argv and returns terminalId", async () => {
    const createRes = await trpcMutate(
      server.url,
      "workspaces.create",
      {
        project: "viaproj",
        branch: "feat/term",
        prompt: "implement feature X",
        via: "terminal",
      },
      TOKEN,
    );
    const createBody = await createRes.text();
    expect(createRes.status, createBody).toBe(200);
    const data = (JSON.parse(createBody) as { result: { data: CreateResponse } }).result.data;

    expect(data.via).toBe("terminal");
    expect(typeof data.terminalId).toBe("string");
    expect(data.terminalId!.length).toBeGreaterThan(0);
    expect(data.path.endsWith("/feat/term")).toBe(true);

    const workspaceId = toWorkspaceId("viaproj", "feat/term");

    const terminals = await waitFor(
      async () => {
        const list = await listTerminals(server.url, workspaceId, TOKEN);
        return list.find((t) => t.terminalId === data.terminalId) ? list : undefined;
      },
      { label: "terminal registered" },
    );
    expect(terminals.some((t) => t.terminalId === data.terminalId)).toBe(true);

    // The vendor CLI received the prompt as its first positional arg.
    const output = await waitFor(
      async () => {
        const out = await readTerminalOutput(server.url, data.terminalId!, TOKEN);
        return out?.includes("ARGV:") && out.includes("implement feature X|") ? out : undefined;
      },
      { label: "stub vendor CLI argv echoed" },
    );
    expect(output).toContain("implement feature X|");

    // Cleanup: `workspaces.remove` must kill the spawned PTY. Without
    // this, a stale vendor CLI process would leak past workspace
    // teardown — the explicit `terminalService.killWorkspace` call in
    // `WorkspaceService.remove` is what makes this safe.
    const removeRes = await trpcMutate(
      server.url,
      "workspaces.remove",
      { project: "viaproj", branch: "feat/term" },
      TOKEN,
    );
    const removeBody = await removeRes.text();
    expect(removeRes.status, removeBody).toBe(200);

    const afterRemove = await waitFor(
      async () => {
        const list = await listTerminals(server.url, workspaceId, TOKEN);
        return list.length === 0 ? list : undefined;
      },
      { label: "terminal removed on workspace delete" },
    );
    expect(afterRemove).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 401 negative auth — the new `via` field is part of the
// `workspaces.create` mutation contract, so this file owns the baseline
// auth check for that surface.
// ---------------------------------------------------------------------------

describe("workspaces.create via=terminal — auth", () => {
  const TOKEN = "wc-via-auth-token";
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-via-auth-");
    const repoPath = createGitRepo(tmpHome, "authproj");
    seedState(tmpHome, {
      projects: [
        {
          name: "authproj",
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

  it("rejects workspaces.create without the band_token cookie (401)", async () => {
    // The shared `trpcMutate` always sends the cookie, so we call
    // `fetch` directly to omit it. Mirrors the 401 guard pattern in
    // `chat-lifecycle.test.ts` / `browsers.test.ts`.
    const res = await fetch(`${server.url}/trpc/workspaces.create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "authproj",
        branch: "feat/unauth",
        prompt: "should be rejected",
        via: "terminal",
      }),
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// via=chat — explicit and default. Both invoke `taskService.submitTask`
// so the agent's `command` points at `fake-agent.mjs` (the project's
// shared Claude-Agent-SDK protocol stub) with a small scenario that
// completes the session cleanly. A bare shell stub would hang the SDK
// subprocess on Linux CI and crash subsequent tests.
// ---------------------------------------------------------------------------

describe("workspaces.create via=chat path", () => {
  const TOKEN = "wc-via-chat-token";
  let server: ServerHandle;
  let tmpHome: string;
  let scenarioPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-via-chat-");
    const repoPath = createGitRepo(tmpHome, "chatproj");
    scenarioPath = writeChatScenario(tmpHome, "chat-scenario.json");
    seedState(tmpHome, {
      projects: [
        {
          name: "chatproj",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoPath }],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: TOKEN,
      codingAgents: [
        {
          id: "claude-code",
          type: "claude-code",
          label: "Claude Code",
          command: FAKE_AGENT_PATH,
        },
      ],
    });
    // The boot refresh fires for this seeded claude-code agent and
    // `fake-agent.mjs` responds to its `control_request` with an empty
    // payload — `supportedModels()` either rejects cleanly or times out
    // (10 s) inside `ClaudeCodeAdapter.refreshModels()`, where it's
    // caught and logged.
    server = await startServer({
      tmpHome,
      env: { FAKE_AGENT_SCENARIO: scenarioPath },
    });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("via=chat (explicit) does NOT spawn a terminal and dispatches a chat task", async () => {
    const createRes = await trpcMutate(
      server.url,
      "workspaces.create",
      {
        project: "chatproj",
        branch: "feat/chatpath",
        prompt: "implement feature Y",
        via: "chat",
      },
      TOKEN,
    );
    const createBody = await createRes.text();
    expect(createRes.status, createBody).toBe(200);
    const data = (JSON.parse(createBody) as { result: { data: CreateResponse } }).result.data;

    expect(data.via).toBe("chat");
    expect(data.terminalId).toBeUndefined();

    const workspaceId = toWorkspaceId("chatproj", "feat/chatpath");

    // Positive anchor: prove the chat path actually dispatched.
    // `taskService.submitTask` persists a task row before the agent
    // begins running, so polling `tasks.list` gives us a deterministic
    // signal without a wall-clock sleep.
    const tasks = await waitFor(
      async () => {
        const list = await listTasksForWorkspace(server.url, workspaceId, TOKEN);
        return list.find((t) => t.prompt === "implement feature Y") ? list : undefined;
      },
      { label: "chat task submitted for via=chat" },
    );
    expect(tasks.some((t) => t.prompt === "implement feature Y")).toBe(true);

    // No PTY should be associated with this workspace — chat-path
    // dispatch goes through `taskService.submitTask`, which never
    // touches the terminal pool.
    const terminals = await listTerminals(server.url, workspaceId, TOKEN);
    expect(terminals).toEqual([]);
  });

  it("omitting via defaults to chat (web-UI default) and dispatches a chat task", async () => {
    const createRes = await trpcMutate(
      server.url,
      "workspaces.create",
      {
        project: "chatproj",
        branch: "feat/default",
        prompt: "implement feature Z",
        // intentionally no `via` field
      },
      TOKEN,
    );
    const createBody = await createRes.text();
    expect(createRes.status, createBody).toBe(200);
    const data = (JSON.parse(createBody) as { result: { data: CreateResponse } }).result.data;

    expect(data.via).toBe("chat");
    expect(data.terminalId).toBeUndefined();

    // Same positive anchor as above — the schema makes `via` optional
    // and the server defaults to chat so the web UI continues working
    // without sending the field.
    const workspaceId = toWorkspaceId("chatproj", "feat/default");
    const tasks = await waitFor(
      async () => {
        const list = await listTasksForWorkspace(server.url, workspaceId, TOKEN);
        return list.find((t) => t.prompt === "implement feature Z") ? list : undefined;
      },
      { label: "chat task submitted for default via" },
    );
    expect(tasks.some((t) => t.prompt === "implement feature Z")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unsupported adapter fallback — cursor-cli's `cliInvocation` returns
// `unsupported: true`. The server logs a warning and silently downgrades
// the dispatch to chat. Because the real cursor SDK isn't safe to run in
// the test process (no credentials, network-dependent), we only assert
// the response shape — the chat-path dispatch itself is exercised by
// the `via=chat` describe above.
// ---------------------------------------------------------------------------

describe("workspaces.create via=terminal — adapter fallback", () => {
  const TOKEN = "wc-via-fallback-token";
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-via-fallback-");
    const repoPath = createGitRepo(tmpHome, "fbproj");
    seedState(tmpHome, {
      projects: [
        {
          name: "fbproj",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoPath }],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: TOKEN,
      codingAgents: [{ id: "cursor-cli", type: "cursor-cli", label: "Cursor CLI" }],
      defaultCodingAgent: "cursor-cli",
    });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("falls back to chat when the agent's cliInvocation is unsupported", async () => {
    const createRes = await trpcMutate(
      server.url,
      "workspaces.create",
      {
        project: "fbproj",
        branch: "feat/fallback",
        prompt: "implement feature W",
        via: "terminal",
      },
      TOKEN,
    );
    const createBody = await createRes.text();
    expect(createRes.status, createBody).toBe(200);
    const data = (JSON.parse(createBody) as { result: { data: CreateResponse } }).result.data;

    // The response reports the *actual* dispatch the server used, not
    // the value the caller asked for — so a CLI scripting around
    // `terminalId` can branch on the absence of the field.
    //
    // We do NOT poll `terminal.list` here: the cursor-cli adapter's
    // `runSession` instantiates the real CursorAgent SDK, which on
    // Linux CI without credentials destabilises the server long enough
    // that any post-response tRPC fetch ECONNRESETs and the afterAll
    // hook times out. The response-shape assertions are sufficient
    // for the fallback contract; the via=terminal happy-path test in
    // the first describe block already pins the spawn-side
    // bookkeeping for the cases where a PTY *should* exist.
    expect(data.via).toBe("chat");
    expect(data.terminalId).toBeUndefined();
  });
});
