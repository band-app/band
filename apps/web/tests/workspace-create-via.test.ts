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
// Doctrine: real production server (`dist/start-server.mjs`), real PTY
// (node-pty), real git repo, real SQLite. No tRPC mocking, no MSW. The
// only "fake" is the **vendor CLI** itself — a 2-line shell script that
// echoes its argv to stdout — because spawning the real `claude` / `codex`
// binary would (a) require the user's actual CLI install and (b) print
// a model response to the test runner. See `apps/web/tests/fake-agent.mjs`
// for the SDK-protocol analogue used by the chat-path tests.
//
// Doctrine source: see `docs/integration-testing.md` and
// `.claude/skills/write-integration-test/SKILL.md` for the project's
// integration-test rules these tests follow.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";

const DEFAULT_TOKEN = "workspace-create-via-token";

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
 * Stub vendor CLI: prints `ARGV:<arg0>|<arg1>|...` so the test can
 * pin both the binary path the adapter picked AND the prompt that was
 * threaded through as positional argument #1. The script terminates
 * immediately — we don't need an interactive REPL because we're testing
 * the *invocation*, not the conversation. The terminal pool drains
 * stdout into its scrollback buffer; the test reads it back via
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

interface TaskListItem {
  id: string;
  workspaceId: string;
  prompt: string;
  status: string;
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

/**
 * Polling helper. Spawning a PTY is async and the workspace-create
 * mutation returns before the terminal-pool's `spawn()` promise
 * resolves (the spawn is deliberately fire-and-forget inside
 * `onSetupComplete` — see `WorkspaceService.create` for the rationale).
 * The test awaits readiness by polling rather than racing on a fixed
 * sleep so a slower CI doesn't flake.
 */
async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  {
    timeoutMs = 5000,
    intervalMs = 50,
    label = "condition",
  }: {
    timeoutMs?: number;
    intervalMs?: number;
    label?: string;
  } = {},
): Promise<T> {
  const start = Date.now();
  let value = await fn();
  while (!value) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    value = await fn();
  }
  return value as T;
}

interface CreateResponse {
  ok: true;
  path: string;
  via?: "chat" | "terminal";
  terminalId?: string;
}

describe("workspaces.create --via terminal (issue #551)", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let stubBin: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-via-terminal-");
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
      tokenSecret: DEFAULT_TOKEN,
      codingAgents: [
        {
          id: "claude-code",
          type: "claude-code",
          label: "Claude Code",
          command: stubBin,
        },
      ],
    });

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("rejects workspaces.create without the band_token cookie (401)", async () => {
    // Negative-auth check — the new `via` field is part of the
    // `workspaces.create` mutation contract, so the auth surface for
    // this entry point gets a baseline test here. The shared
    // `trpcMutate` always sends the cookie, so we call `fetch`
    // directly to omit it. Mirrors the 401 guard pattern used in
    // `chat-lifecycle.test.ts` / `browsers.test.ts`.
    const res = await fetch(`${server.url}/trpc/workspaces.create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project: "viaproj",
        branch: "feat/unauth",
        prompt: "should be rejected",
        via: "terminal",
      }),
    });
    expect(res.status).toBe(401);
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
      DEFAULT_TOKEN,
    );
    const createBody = await createRes.text();
    expect(createRes.status, createBody).toBe(200);
    const data = (JSON.parse(createBody) as { result: { data: CreateResponse } }).result.data;

    // Response shape — the CLI's JSON output is built off of this.
    expect(data.via).toBe("terminal");
    expect(typeof data.terminalId).toBe("string");
    expect(data.terminalId!.length).toBeGreaterThan(0);
    expect(data.path.endsWith("/feat/term")).toBe(true);

    // `toWorkspaceId(project, branch)` normalises `/` to `-` so the
    // workspaceId is filesystem-safe and routable.
    const workspaceId = "viaproj-feat-term";

    // Terminal becomes registered with the workspace shortly after the
    // mutation returns (spawn is async inside `onSetupComplete`).
    const terminals = await waitFor(
      async () => {
        const list = await listTerminals(server.url, workspaceId, DEFAULT_TOKEN);
        return list.find((t) => t.terminalId === data.terminalId) ? list : undefined;
      },
      { label: "terminal registered" },
    );
    expect(terminals.some((t) => t.terminalId === data.terminalId)).toBe(true);

    // The vendor CLI received the prompt as its first positional arg.
    // The stub prints `ARGV:<arg0>|<arg1>|`. We assert on the substring
    // rather than the whole line so trailing PTY shell decoration
    // (prompt redraw, line wrapping) doesn't make this brittle.
    const output = await waitFor(
      async () => {
        const out = await readTerminalOutput(server.url, data.terminalId!, DEFAULT_TOKEN);
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
      DEFAULT_TOKEN,
    );
    const removeBody = await removeRes.text();
    expect(removeRes.status, removeBody).toBe(200);

    const afterRemove = await waitFor(
      async () => {
        const list = await listTerminals(server.url, workspaceId, DEFAULT_TOKEN);
        return list.length === 0 ? list : undefined;
      },
      { label: "terminal removed on workspace delete" },
    );
    expect(afterRemove).toEqual([]);
  });

  it("via=chat (explicit) does NOT spawn a terminal", async () => {
    const createRes = await trpcMutate(
      server.url,
      "workspaces.create",
      {
        project: "viaproj",
        branch: "feat/chatpath",
        prompt: "implement feature Y",
        via: "chat",
      },
      DEFAULT_TOKEN,
    );
    const createBody = await createRes.text();
    expect(createRes.status, createBody).toBe(200);
    const data = (JSON.parse(createBody) as { result: { data: CreateResponse } }).result.data;

    expect(data.via).toBe("chat");
    expect(data.terminalId).toBeUndefined();

    const workspaceId = "viaproj-feat-chatpath";

    // Positive anchor: prove the chat path actually dispatched. Polling
    // `tasks.list` for the workspace gives us a deterministic signal
    // without a wall-clock sleep — `taskService.submitTask` persists a
    // row synchronously, but the runSetup callback that calls it fires
    // on next tick. A regression that silently dropped chat-path
    // dispatch when `via: "chat"` is explicit would leave this empty.
    const tasks = await waitFor(
      async () => {
        const list = await listTasksForWorkspace(server.url, workspaceId, DEFAULT_TOKEN);
        return list.find((t) => t.prompt === "implement feature Y") ? list : undefined;
      },
      { label: "chat task submitted for via=chat" },
    );
    expect(tasks.some((t) => t.prompt === "implement feature Y")).toBe(true);

    // No PTY should be associated with this workspace — chat-path
    // dispatch goes through `taskService.submitTask`, which never
    // touches the terminal pool.
    const terminals = await listTerminals(server.url, workspaceId, DEFAULT_TOKEN);
    expect(terminals).toEqual([]);
  });

  it("omitting via defaults to chat (web-UI default)", async () => {
    // The schema makes `via` optional and the server defaults to chat
    // so the web UI continues working without sending the field. The
    // Rust CLI defaults to "terminal" *client-side*, but no flag here
    // means the server's default kicks in — same shape the dashboard
    // sees today.
    const createRes = await trpcMutate(
      server.url,
      "workspaces.create",
      {
        project: "viaproj",
        branch: "feat/default",
        prompt: "implement feature Z",
        // intentionally no `via` field
      },
      DEFAULT_TOKEN,
    );
    const createBody = await createRes.text();
    expect(createRes.status, createBody).toBe(200);
    const data = (JSON.parse(createBody) as { result: { data: CreateResponse } }).result.data;
    expect(data.via).toBe("chat");
    expect(data.terminalId).toBeUndefined();
  });
});

describe("workspaces.create --via terminal — adapter fallback", () => {
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
      tokenSecret: DEFAULT_TOKEN,
      // cursor-cli intentionally returns `unsupported: true` from
      // `cliInvocation` — there's no usable one-shot interactive REPL
      // for it. The server must detect that and fall back to chat
      // dispatch so the create call still succeeds.
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
      DEFAULT_TOKEN,
    );
    const createBody = await createRes.text();
    expect(createRes.status, createBody).toBe(200);
    const data = (JSON.parse(createBody) as { result: { data: CreateResponse } }).result.data;

    // The response reports the *actual* dispatch the server used, not
    // the value the caller asked for — so a CLI scripting around
    // `terminalId` can branch on the absence of the field.
    expect(data.via).toBe("chat");
    expect(data.terminalId).toBeUndefined();

    // Positive anchor: the fallback must actually queue a chat task —
    // not silently drop the prompt. A regression that returned
    // `via: "chat"` without dispatching would pass the field assertions
    // above but fail this poll.
    const tasks = await waitFor(
      async () => {
        const list = await listTasksForWorkspace(server.url, "fbproj-feat-fallback", DEFAULT_TOKEN);
        return list.find((t) => t.prompt === "implement feature W") ? list : undefined;
      },
      { label: "cursor-cli fallback dispatched to chat" },
    );
    expect(tasks.some((t) => t.prompt === "implement feature W")).toBe(true);
  });
});
