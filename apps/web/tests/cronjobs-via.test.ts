// Integration tests for cronjobs dispatching via terminal (issue #581).
//
// A cronjob can dispatch its prompt to the agent's *headless* CLI in a fresh
// PTY pane (`via: "terminal"`) instead of the chat pane (`via: "chat"`,
// default), reusing the same `via` model as `workspaces.create` (#551). Unlike
// workspace-create (which opens the interactive REPL), a cron uses the headless
// one-shot invocation (`claude -p …`) so the pane runs to completion and exits
// — see the `-p` regression assertion below. These tests drive the *manual*
// `cronjobs.trigger` route because it shares the exact dispatch path with the
// scheduled fire (`executeCronjob` → `spawnCronTerminal`) but is deterministic
// to invoke from a test.
//
// Real production server (`dist/start-server.mjs`), real PTY (node-pty), real
// git repo, real SQLite. No tRPC mocking, no MSW. Each describe block boots its
// own server with a tmp `$HOME` so an SDK-adapter wedge in one scenario can't
// cascade into the next.
//
// The cron terminal pane is *self-closing* (its command ends with `exit`), so
// its scrollback dies with the PTY the instant the command finishes. The
// happy-path assertion therefore has the stub vendor CLI append its argv to a
// **log file** rather than reading it back through `terminal.output` (which
// would race the self-close). The overlap test instead uses a *sleeping* stub
// so the pane stays alive long enough to observe the skip.

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
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { listTasksForWorkspace } from "./helpers/tasks";
import { waitFor } from "./helpers/wait-for";

const FAKE_AGENT_PATH = join(import.meta.dirname, "fake-agent.mjs");

// ---------------------------------------------------------------------------
// Git + stub helpers
// ---------------------------------------------------------------------------

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
  writeFileSync(join(repoPath, "README.md"), "# cron via test\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "init"]);
  return repoPath;
}

function writeVendorCliScript(tmpHome: string, name: string, body: string): string {
  const binPath = join(tmpHome, name);
  writeFileSync(binPath, `#!/bin/sh\n${body}`, "utf-8");
  chmodSync(binPath, 0o755);
  return binPath;
}

/**
 * Stub vendor CLI for the self-closing happy path: append `ARGV:<arg0>|<arg1>|…`
 * to `logPath` (baked into the script) and exit immediately. The log file
 * outlives the PTY, so the test can prove the prompt reached argv even after
 * the pane self-closes. The `logPath` is single-quoted so a space in the tmp
 * home can't split the redirect target.
 *
 * The same binary is the configured `claude-code` command, so the Claude Code
 * SDK also spawns it (boot model-refresh / adapter construction) with its own
 * `-p --output-format stream-json …` arg set into this same log. Two
 * defenses make the argv assertion robust against that:
 *   1. The whole argv is composed into one string and written with a SINGLE
 *      `printf '%s\n'` — one `O_APPEND` write, atomic under PIPE_BUF (our lines
 *      are <200 bytes) — so concurrent spawns produce distinct, non-interleaved
 *      lines rather than one byte-mangled line.
 *   2. The test matches the line bearing the cron prompt and asserts it EXACTLY,
 *      so an unrelated spawn's line is simply ignored.
 */
function writeLoggingVendorCli(tmpHome: string, name: string, logPath: string): string {
  return writeVendorCliScript(
    tmpHome,
    name,
    `out="ARGV:"\nfor arg in "$@"; do out="$out$arg|"; done\nprintf '%s\\n' "$out" >> '${logPath}'\n`,
  );
}

/**
 * Stub vendor CLI that sleeps so the PTY stays alive long enough for the
 * overlap / delete tests to observe the running pane and act before the command
 * finishes. Gated on `BAND_DISPATCH=terminal` so the SDK's boot-time
 * model-refresh spawn (`BAND_DISPATCH=chat`) exits immediately instead of
 * spawning a stray multi-second sleeper.
 */
function writeSleepingVendorCli(tmpHome: string, name: string, seconds: number): string {
  return writeVendorCliScript(
    tmpHome,
    name,
    `[ "$BAND_DISPATCH" = terminal ] || exit 0\nsleep ${seconds}\n`,
  );
}

/**
 * Minimal fake-agent scenario for the chat-path dispatch: emit `system.init`
 * then a terminal `result` so `taskService.submitTask` records a completed task
 * and tears the agent down cleanly. A bare shell stub would hang the SDK
 * subprocess on Linux CI.
 */
function writeChatScenario(tmpHome: string, name: string): string {
  const scenarioPath = join(tmpHome, name);
  writeFileSync(
    scenarioPath,
    JSON.stringify([
      { type: "system", subtype: "init", session_id: "cron-via-chat-session" },
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

interface TriggerResponse {
  via: "chat" | "terminal";
  workspaceId: string;
  terminalId?: string;
  taskId?: string;
  chatId?: string;
}

// ---------------------------------------------------------------------------
// via=terminal — happy path + self-close
// ---------------------------------------------------------------------------

describe("cronjobs.trigger via=terminal happy path", () => {
  const TOKEN = "cron-via-terminal-happy-token";
  let server: ServerHandle;
  let tmpHome: string;
  let logPath: string;
  let jobId: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-cron-via-happy-");
    const repoPath = createGitRepo(tmpHome, "viacron");
    logPath = join(tmpHome, "cron-invocation.log");
    const stubBin = writeLoggingVendorCli(tmpHome, "stub-claude.sh", logPath);
    seedState(tmpHome, {
      projects: [
        {
          name: "viacron",
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

    const res = await trpcMutate(
      server.url,
      "cronjobs.create",
      {
        key: "viacron",
        name: "Terminal cron",
        prompt: "run the terminal check",
        cronExpression: "0 0 * * *",
        scope: "project",
        via: "terminal",
      },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ job: { id: string; via: string } }>(res);
    expect(data.job.via).toBe("terminal");
    jobId = data.job.id;
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("spawns a self-closing terminal running the prompt, then prunes it", async () => {
    const res = await trpcMutate(
      server.url,
      "cronjobs.trigger",
      { key: "viacron", id: jobId },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<TriggerResponse>(res);

    // The response reports the actual dispatch: a terminal id, no chat task.
    expect(data.via).toBe("terminal");
    expect(typeof data.terminalId).toBe("string");
    expect(data.terminalId!.length).toBeGreaterThan(0);
    expect(data.workspaceId).toBe("viacron-main");
    expect(data.taskId).toBeUndefined();

    // The stub vendor CLI logged its argv (one atomic line per spawn) to a file
    // so the assertion survives the pane self-closing. Grab the line bearing the
    // cron prompt — the SDK's own spawns of this same binary write other lines
    // we ignore.
    const argvLine = await waitFor(
      async () => {
        if (!existsSync(logPath)) return undefined;
        return readFileSync(logPath, "utf-8")
          .split("\n")
          .find((l) => l.includes("run the terminal check|"));
      },
      { label: "stub vendor CLI logged the prompt argv" },
    );
    // Regression guard for issue #581's follow-up: the cron path must use the
    // agent's HEADLESS invocation (`claude -p "<prompt>"`), not the interactive
    // `cliInvocation` (`claude "<prompt>"`). The interactive REPL never exits,
    // so the pane would stay parked and every later tick would 409. The stub is
    // a claude-code agent, so headless dispatch logs exactly `-p` then the prompt
    // (`ARGV:-p|<prompt>|`); interactive dispatch would log only the prompt token
    // (`ARGV:<prompt>|`). Asserting the whole line rules out both a regression to
    // the interactive form and any accidental match against an SDK spawn's line.
    expect(argvLine).toBe("ARGV:-p|run the terminal check|");

    // Self-close: the command ended with `exit`, so the pane closes when the
    // (fast) stub finishes, and the `cleanupOnExit` hook prunes it from the
    // pool. No terminal should remain for the workspace.
    const workspaceId = toWorkspaceId("viacron", "main");
    const remaining = await waitFor(
      async () => {
        const list = await listTerminals(server.url, workspaceId, TOKEN);
        return list.length === 0 ? list : undefined;
      },
      { label: "self-closing cron terminal pruned" },
    );
    expect(remaining).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// via=terminal — skip an overlapping run (previous pane still active → 409)
// ---------------------------------------------------------------------------

describe("cronjobs.trigger via=terminal skips overlapping runs", () => {
  const TOKEN = "cron-via-terminal-overlap-token";
  // The stub sleeps this long so the first trigger's pane is still alive when
  // the second trigger fires. Generous margin over the poll + second-trigger
  // round-trip below.
  const STUB_SLEEP_SECONDS = 6;
  let server: ServerHandle;
  let tmpHome: string;
  let jobId: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-cron-via-overlap-");
    const repoPath = createGitRepo(tmpHome, "overlapcron");
    const stubBin = writeSleepingVendorCli(tmpHome, "stub-claude.sh", STUB_SLEEP_SECONDS);
    seedState(tmpHome, {
      projects: [
        {
          name: "overlapcron",
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

    const res = await trpcMutate(
      server.url,
      "cronjobs.create",
      {
        key: "overlapcron",
        name: "Overlapping terminal cron",
        prompt: "long running work",
        cronExpression: "0 0 * * *",
        scope: "project",
        via: "terminal",
      },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ job: { id: string } }>(res);
    jobId = data.job.id;
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns 409 when the previous terminal run is still active", async () => {
    // First trigger spawns the (sleeping) pane.
    const first = await trpcMutate(
      server.url,
      "cronjobs.trigger",
      { key: "overlapcron", id: jobId },
      TOKEN,
    );
    expect(first.status).toBe(200);
    const firstData = await trpcData<TriggerResponse>(first);
    expect(firstData.via).toBe("terminal");

    // Wait until the PTY is registered so the overlap check has something to
    // observe, then fire the second trigger while the stub is still sleeping.
    const workspaceId = toWorkspaceId("overlapcron", "main");
    await waitFor(
      async () => {
        const list = await listTerminals(server.url, workspaceId, TOKEN);
        return list.some((t) => t.terminalId === firstData.terminalId) ? list : undefined;
      },
      { label: "first cron terminal registered" },
    );

    // Assert the exact status: a [200,409] union would silently pass if the
    // overlap guard ever stopped firing.
    const second = await trpcMutate(
      server.url,
      "cronjobs.trigger",
      { key: "overlapcron", id: jobId },
      TOKEN,
    );
    expect(second.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// via=chat (default) — no terminal spawned, a chat task is submitted
//
// Uses `fake-agent.mjs` (the SDK-protocol stub) because chat dispatch runs
// `taskService.submitTask`, which spawns the real SDK and reads JSONL events.
// ---------------------------------------------------------------------------

describe("cronjobs.trigger default dispatches to chat", () => {
  const TOKEN = "cron-via-chat-token";
  let server: ServerHandle;
  let tmpHome: string;
  let jobId: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-cron-via-chat-");
    const repoPath = createGitRepo(tmpHome, "chatcron");
    const scenarioPath = writeChatScenario(tmpHome, "chat-scenario.json");
    seedState(tmpHome, {
      projects: [
        {
          name: "chatcron",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoPath }],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: TOKEN,
      codingAgents: [
        { id: "claude-code", type: "claude-code", label: "Claude Code", command: FAKE_AGENT_PATH },
      ],
    });
    server = await startServer({ tmpHome, env: { FAKE_AGENT_SCENARIO: scenarioPath } });

    // No `via` field — the server defaults to chat (backward-compatible).
    const res = await trpcMutate(
      server.url,
      "cronjobs.create",
      {
        key: "chatcron",
        name: "Chat cron",
        prompt: "chat dispatch work",
        cronExpression: "0 0 * * *",
        scope: "project",
      },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ job: { id: string; via: string } }>(res);
    // The persisted job records the default.
    expect(data.job.via).toBe("chat");
    jobId = data.job.id;
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns via=chat with a taskId and spawns no terminal", async () => {
    const res = await trpcMutate(
      server.url,
      "cronjobs.trigger",
      { key: "chatcron", id: jobId },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<TriggerResponse>(res);

    expect(data.via).toBe("chat");
    expect(typeof data.taskId).toBe("string");
    expect(data.terminalId).toBeUndefined();

    const workspaceId = toWorkspaceId("chatcron", "main");

    // Positive anchor: the chat task actually landed.
    const tasks = await waitFor(
      async () => {
        const list = await listTasksForWorkspace(server.url, workspaceId, TOKEN);
        return list.find((t) => t.prompt === "chat dispatch work") ? list : undefined;
      },
      { label: "chat task submitted for default via" },
    );
    expect(tasks.some((t) => t.prompt === "chat dispatch work")).toBe(true);

    // No PTY: chat dispatch never touches the terminal pool.
    const terminals = await listTerminals(server.url, workspaceId, TOKEN);
    expect(terminals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// via=terminal + unsupported adapter → silent fallback to chat
//
// cursor-cli's `cliInvocation` returns `unsupported: true`; the service warns
// and downgrades to chat. As in workspace-create-via, the real Cursor SDK isn't
// safe to run in the test process, so we assert the response shape only.
// ---------------------------------------------------------------------------

describe("cronjobs.trigger via=terminal falls back to chat when unsupported", () => {
  const TOKEN = "cron-via-fallback-token";
  let server: ServerHandle;
  let tmpHome: string;
  let jobId: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-cron-via-fallback-");
    const repoPath = createGitRepo(tmpHome, "fbcron");
    seedState(tmpHome, {
      projects: [
        {
          name: "fbcron",
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

    const res = await trpcMutate(
      server.url,
      "cronjobs.create",
      {
        key: "fbcron",
        name: "Fallback cron",
        prompt: "should fall back to chat",
        cronExpression: "0 0 * * *",
        scope: "project",
        via: "terminal",
      },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ job: { id: string } }>(res);
    jobId = data.job.id;
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("reports via=chat and does not return a terminalId", async () => {
    const res = await trpcMutate(
      server.url,
      "cronjobs.trigger",
      { key: "fbcron", id: jobId },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<TriggerResponse>(res);

    // The response reports the *actual* dispatch the server used, not the value
    // the caller asked for — so a CLI scripting on `terminalId` can branch on
    // its absence.
    expect(data.via).toBe("chat");
    expect(data.terminalId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// via=terminal — deleting the job tears down its live terminal
//
// `cronjobs.delete` best-effort kills the terminal a via="terminal" job last
// spawned (cronjob-service `delete()`), so removing a job doesn't leave a stray
// pane running the agent. Uses a sleeping stub so the pane is still alive when
// we delete.
// ---------------------------------------------------------------------------

describe("cronjobs.delete tears down a via=terminal job's terminal", () => {
  const TOKEN = "cron-via-delete-token";
  const STUB_SLEEP_SECONDS = 6;
  let server: ServerHandle;
  let tmpHome: string;
  let jobId: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-cron-via-delete-");
    const repoPath = createGitRepo(tmpHome, "delcron");
    const stubBin = writeSleepingVendorCli(tmpHome, "stub-claude.sh", STUB_SLEEP_SECONDS);
    seedState(tmpHome, {
      projects: [
        {
          name: "delcron",
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

    const res = await trpcMutate(
      server.url,
      "cronjobs.create",
      {
        key: "delcron",
        name: "Deletable terminal cron",
        prompt: "long running work",
        cronExpression: "0 0 * * *",
        scope: "project",
        via: "terminal",
      },
      TOKEN,
    );
    expect(res.status).toBe(200);
    const data = await trpcData<{ job: { id: string } }>(res);
    jobId = data.job.id;
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("kills the spawned terminal when the job is deleted", async () => {
    const trigger = await trpcMutate(
      server.url,
      "cronjobs.trigger",
      { key: "delcron", id: jobId },
      TOKEN,
    );
    expect(trigger.status).toBe(200);
    const triggerData = await trpcData<TriggerResponse>(trigger);
    expect(triggerData.via).toBe("terminal");

    const workspaceId = toWorkspaceId("delcron", "main");

    // Positive anchor: the PTY is live (the stub is still sleeping).
    await waitFor(
      async () => {
        const list = await listTerminals(server.url, workspaceId, TOKEN);
        return list.some((t) => t.terminalId === triggerData.terminalId) ? list : undefined;
      },
      { label: "cron terminal registered before delete" },
    );

    // Deleting the job must tear down its live pane.
    const del = await trpcMutate(
      server.url,
      "cronjobs.delete",
      { key: "delcron", id: jobId },
      TOKEN,
    );
    expect(del.status).toBe(200);

    const remaining = await waitFor(
      async () => {
        const list = await listTerminals(server.url, workspaceId, TOKEN);
        return list.every((t) => t.terminalId !== triggerData.terminalId) ? list : undefined;
      },
      { label: "cron terminal removed after delete" },
    );
    expect(remaining.some((t) => t.terminalId === triggerData.terminalId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auth — `cronjobs.trigger` is part of this PR's changed contract (now async,
// returns a chat|terminal union), so this file owns the 401 guard for that
// surface. Mirrors the auth block in `workspace-create-via.test.ts`.
// ---------------------------------------------------------------------------

describe("cronjobs.trigger — auth", () => {
  const TOKEN = "cron-via-auth-token";
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-cron-via-auth-");
    const repoPath = createGitRepo(tmpHome, "authcron");
    seedState(tmpHome, {
      projects: [
        {
          name: "authcron",
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

  it("rejects cronjobs.trigger without the band_token cookie (401)", async () => {
    // The shared `trpcMutate` always sends the cookie, so we call `fetch`
    // directly to omit it — same pattern as the other surface auth guards.
    const res = await fetch(`${server.url}/trpc/cronjobs.trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "authcron", id: "cj_whatever" }),
    });
    expect(res.status).toBe(401);
  });
});
