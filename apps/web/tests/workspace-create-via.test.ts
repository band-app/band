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
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { listTasksForWorkspace } from "./helpers/tasks";
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
 * Write an executable `/bin/sh` stub at `tmpHome/name` with the given
 * body and return its path. Shared scaffold for the per-purpose stub
 * vendor CLIs below — the only thing that varies between them is the
 * script body.
 */
function writeVendorCliScript(tmpHome: string, name: string, body: string): string {
  const binPath = join(tmpHome, name);
  writeFileSync(binPath, `#!/bin/sh\n${body}`, "utf-8");
  chmodSync(binPath, 0o755);
  return binPath;
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
  return writeVendorCliScript(
    tmpHome,
    name,
    `printf 'ARGV:'\nfor arg in "$@"; do printf '%s|' "$arg"; done\nprintf '\\n'\n`,
  );
}

/**
 * Stub vendor CLI that echoes the dispatch-relevant env vars it was
 * spawned with as `ENV_BAND_DISPATCH:<value>|` and
 * `ENV_BAND_SERVER_URL:<value>|`. Used to prove that a process spawned
 * inside a terminal PTY inherits `BAND_DISPATCH=terminal` (pinned by
 * `terminal-pool`) and `BAND_SERVER_URL` (advertised by start-server) —
 * the terminal-side mirror of the chat-side `FAKE_AGENT_ENV_LOG`
 * assertion. Terminates immediately; the pool drains stdout into its
 * scrollback.
 */
function writeEnvEchoVendorCli(tmpHome: string, name: string): string {
  return writeVendorCliScript(
    tmpHome,
    name,
    `printf 'ENV_BAND_DISPATCH:%s|\\n' "$BAND_DISPATCH"\nprintf 'ENV_BAND_SERVER_URL:%s|\\n' "$BAND_SERVER_URL"\n`,
  );
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

// ---------------------------------------------------------------------------
// Bug 1 — band-start run from the webchat must dispatch the new
// workspace's task to the CHAT, not a terminal.
//
// The mechanism: a chat-hosted coding agent is spawned with
// `BAND_DISPATCH=chat` in its environment, so a NESTED `band workspaces
// create --prompt …` it fires (the band-start skill) resolves to
// `via: chat` — matching where the agent itself runs — instead of the
// Rust CLI's built-in `terminal` default. `BAND_SERVER_URL` is injected
// too so the nested CLI reaches THIS server rather than the hardcoded
// `127.0.0.1:3456`.
//
// We can't drive the real Rust `band` binary through the Claude-Agent-SDK
// stub (the stub speaks the SDK's stdin/stdout protocol; it can't also be
// a shell that shells out to a CLI), so we assert the precondition the
// nested CLI reads: the environment the server handed the spawned agent.
// The CLI's `resolve_dispatch_target` (apps/cli/src/main.rs) consults
// exactly `BAND_DISPATCH` then `BAND_SERVER_URL`, so pinning what the
// agent received is what proves a nested create would resolve to chat.
//
// We exercise the claude-code adapter as the representative case rather
// than all four: every adapter merges the SAME `AGENT_DISPATCH_ENV`
// constant into its subprocess env (claude-code/codex/gemini-cli/opencode
// in packages/coding-agent/src/adapters/), so one integration test plus
// the shared constant covers the mechanism. The codex/gemini/opencode
// stubs would each need a different protocol shim for no added signal.
// ---------------------------------------------------------------------------

describe("chat-hosted agent dispatch env (band-start nested create)", () => {
  // One JSONL record per fake-agent spawn (see fake-agent.mjs
  // FAKE_AGENT_ENV_LOG). Scoped to this block — it's the only consumer.
  interface AgentEnvRecord {
    BAND_DISPATCH: string | null;
    BAND_SERVER_URL: string | null;
  }

  const TOKEN = "wc-dispatch-env-token";
  let server: ServerHandle;
  let tmpHome: string;
  let scenarioPath: string;
  let envLogPath: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-dispatch-env-");
    const repoPath = createGitRepo(tmpHome, "dispproj");
    scenarioPath = writeChatScenario(tmpHome, "dispatch-scenario.json");
    envLogPath = join(tmpHome, "agent-env.jsonl");
    seedState(tmpHome, {
      projects: [
        {
          name: "dispproj",
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
    server = await startServer({
      tmpHome,
      env: { FAKE_AGENT_SCENARIO: scenarioPath, FAKE_AGENT_ENV_LOG: envLogPath },
    });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("spawns the chat agent with BAND_DISPATCH=chat and BAND_SERVER_URL pointing at this server", async () => {
    const createRes = await trpcMutate(
      server.url,
      "workspaces.create",
      {
        project: "dispproj",
        branch: "feat/nested",
        prompt: "kick off nested work",
        via: "chat",
      },
      TOKEN,
    );
    const createBody = await createRes.text();
    expect(createRes.status, createBody).toBe(200);

    // Poll the env log until the TASK spawn's record appears (the one
    // carrying BAND_DISPATCH=chat). The boot-time model-refresh probe may
    // also spawn the stub and append a record with BAND_DISPATCH=null
    // (refreshModels runs with the SDK's default env) — we look past that
    // for the runSession spawn that dispatches the prompt.
    const record = await waitFor<AgentEnvRecord>(
      async () => {
        if (!existsSync(envLogPath)) return undefined;
        const records = readFileSync(envLogPath, "utf-8")
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l) as AgentEnvRecord);
        return records.find((r) => r.BAND_DISPATCH === "chat");
      },
      { label: "agent spawned with BAND_DISPATCH=chat" },
    );

    // The `waitFor` predicate above only resolves once a spawn recorded
    // BAND_DISPATCH === "chat", so reaching here already proves the chat
    // agent was spawned with the chat dispatch target. The remaining
    // assertion pins the other half: the server advertised its own bound
    // URL so a nested CLI call reaches it regardless of which port it
    // claimed.
    expect(record.BAND_SERVER_URL).toBe(server.url);
  });
});

// ---------------------------------------------------------------------------
// Bug 2 — terminal dispatch must execute long, UTF-8-containing prompts
// without truncation or corruption.
//
// Previously the server wrote the whole `'<agent-binary>' '<prompt>'`
// line straight into a freshly spawned PTY. That raced the shell startup:
// the trailing newline could be dropped (command typed but never run), a
// line longer than the tty canonical buffer (~4 KB) could be truncated,
// and a multi-byte UTF-8 sequence (em-dash U+2014) split across a buffer
// boundary could be mangled. The fix stages the command in a temp file
// and injects a short `source <file>` line after the shell is ready.
//
// This pins the end-to-end contract: a ~6 KB prompt peppered with
// em-dashes is echoed back by the stub vendor CLI as a single argv token,
// intact — proving it both EXECUTED and survived byte-for-byte.
// ---------------------------------------------------------------------------

describe("workspaces.create via=terminal — long UTF-8 prompt", () => {
  const TOKEN = "wc-via-longprompt-token";
  let server: ServerHandle;
  let tmpHome: string;
  let stubBin: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-via-longprompt-");
    const repoPath = createGitRepo(tmpHome, "longproj");
    stubBin = writeStubVendorCli(tmpHome, "stub-claude.sh");
    seedState(tmpHome, {
      projects: [
        {
          name: "longproj",
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
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("executes the full prompt with em-dashes intact (no truncation/corruption)", async () => {
    // ~6 KB — well past the tty canonical buffer (~4 KB) — with em-dashes
    // (U+2014) scattered throughout, the exact character that came back
    // mangled in the production report.
    const segment = "implement the feature — carefully — and thoroughly ";
    const longPrompt = `BEGIN—${segment.repeat(120)}—END`;
    expect(longPrompt.length).toBeGreaterThan(5000);

    const createRes = await trpcMutate(
      server.url,
      "workspaces.create",
      {
        project: "longproj",
        branch: "feat/long",
        prompt: longPrompt,
        via: "terminal",
      },
      TOKEN,
    );
    const createBody = await createRes.text();
    expect(createRes.status, createBody).toBe(200);
    const data = (JSON.parse(createBody) as { result: { data: CreateResponse } }).result.data;

    expect(data.via).toBe("terminal");
    expect(typeof data.terminalId).toBe("string");

    // The stub prints `ARGV:<arg0>|<arg1>|...`. Assert the FULL prompt
    // came back as a single argv token terminated by the `|` the stub
    // writes after each arg — proving nothing was clipped mid-line and
    // the em-dashes round-tripped byte-for-byte. If the cold-PTY race had
    // dropped the newline the command would never run and `ARGV:` would
    // never appear; if it had truncated, the `${longPrompt}|` needle
    // wouldn't match.
    const output = await waitFor(
      async () => {
        const out = await readTerminalOutput(server.url, data.terminalId!, TOKEN);
        return out?.includes(`${longPrompt}|`) ? out : undefined;
      },
      { label: "full long prompt echoed by stub", timeoutMs: 15_000 },
    );
    expect(output).toContain(`${longPrompt}|`);
    // Belt-and-suspenders: the em-dash survived as U+2014, not mojibake.
    expect(output).toContain("—");
  });

  it("rejects terminal.create with a path-traversal id", async () => {
    // The auto-run staging file is keyed on a server-side randomUUID, but
    // the `terminal.create` schema also constrains `id` to a UUID so a
    // hostile value can never reach the pool in the first place. Pin that
    // boundary: a `../`-laden id is rejected at the tRPC layer, so no PTY
    // is spawned and `command` never runs.
    const res = await trpcMutate(
      server.url,
      "terminal.create",
      {
        workspaceId: toWorkspaceId("longproj", "main"),
        id: "../../../../tmp/band-evil",
        command: "echo pwned",
      },
      TOKEN,
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toMatch(/uuid/i);
  });
});

// ---------------------------------------------------------------------------
// Bug 1 (terminal mirror) — a process spawned inside a terminal PTY must
// inherit `BAND_DISPATCH=terminal`, so a nested `band` CLI call typed into
// that pane keeps resolving to `terminal` (the symmetric counterpart to
// the chat agent inheriting `BAND_DISPATCH=chat`). `terminal-pool` pins
// the var on the PTY env; this proves the spawned vendor CLI actually sees
// it. The stub echoes `ENV_BAND_DISPATCH:<value>|` — the terminal-side
// equivalent of the chat path's `FAKE_AGENT_ENV_LOG`.
// ---------------------------------------------------------------------------

describe("terminal PTY env — BAND_DISPATCH=terminal", () => {
  const TOKEN = "wc-via-termenv-token";
  let server: ServerHandle;
  let tmpHome: string;
  let stubBin: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-via-termenv-");
    const repoPath = createGitRepo(tmpHome, "termenvproj");
    stubBin = writeEnvEchoVendorCli(tmpHome, "stub-env-echo.sh");
    seedState(tmpHome, {
      projects: [
        {
          name: "termenvproj",
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
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("spawns the PTY vendor CLI with BAND_DISPATCH=terminal", async () => {
    const createRes = await trpcMutate(
      server.url,
      "workspaces.create",
      {
        project: "termenvproj",
        branch: "feat/termenv",
        prompt: "run in terminal",
        via: "terminal",
      },
      TOKEN,
    );
    const createBody = await createRes.text();
    expect(createRes.status, createBody).toBe(200);
    const data = (JSON.parse(createBody) as { result: { data: CreateResponse } }).result.data;

    expect(data.via).toBe("terminal");
    expect(typeof data.terminalId).toBe("string");

    // The stub printed the env it inherited from the PTY. `terminal` (not
    // `chat`, not empty) proves the terminal pane pins the dispatch target
    // for any nested `band` CLI call typed into it.
    const output = await waitFor(
      async () => {
        const out = await readTerminalOutput(server.url, data.terminalId!, TOKEN);
        // Require BOTH echoed lines so a split PTY flush can't resolve the
        // poll before the second line is captured.
        return out?.includes("ENV_BAND_DISPATCH:terminal|") && out.includes("ENV_BAND_SERVER_URL:")
          ? out
          : undefined;
      },
      { label: "stub echoed dispatch env" },
    );
    expect(output).toContain("ENV_BAND_DISPATCH:terminal|");
    // Negative guard: it must not have leaked the chat value.
    expect(output).not.toContain("ENV_BAND_DISPATCH:chat|");
    // Symmetric with the chat-path assertion: the PTY child also reaches
    // THIS server, so a nested `band` CLI call resolves to the right port.
    expect(output).toContain(`ENV_BAND_SERVER_URL:${server.url}|`);
  });
});
