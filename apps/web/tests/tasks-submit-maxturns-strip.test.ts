// Regression guard: `maxTurns` was removed from `tasks.submit` (tRPC) and
// `workspaceCreateInput` zod schemas. The removal is a breaking wire change
// for any pre-existing CLI / API caller that still sends `maxTurns`, and the
// expected contract is that Zod's default `.strip()` behaviour silently
// drops the unknown key rather than rejecting the request with a 400. This
// file pins that contract end-to-end against the real production server.
//
// What we prove (TEST-6 — every user-observable change owns an integration test):
//
//   1. `tasks.submit` without `maxTurns` succeeds (baseline). Submitting
//      `maxTurns: 5` returns the same shape — no 400, no error envelope,
//      the task lands on the queue and tasks.list reports it.
//
//   2. `workspaces.create` without `maxTurns` dispatches a chat task.
//      Submitting `maxTurns: 5` does the same — the legacy field is
//      silently stripped and the workspace + task are created identically.
//
// Doctrine compliance (testing-criteria.md):
//   • Real production server (`dist/start-server.mjs`) booted via the
//     canonical `helpers/server.ts` (`startServer` / `createTmpHome` /
//     `trpcMutate` / `trpcQuery`). No in-process route invocation, no
//     tRPC mock (TEST-4, TEST-12, TEST-19).
//   • Port 0 + tmp `$HOME` (TEST-10, TEST-11). Migrations run during boot,
//     including the new `drop_tasks_max_turns` migration that removed
//     the column the chat-path consumers used to write to.
//   • Token-cookie auth via the shared trpcMutate helper (TEST-13).
//   • External boundary (the Claude-Agent SDK subprocess) stubbed with
//     `fake-agent.mjs`, the project's shared protocol stub. A bare shell
//     stub doesn't speak the Claude-Agent SDK protocol and hangs the
//     subprocess on Linux CI; fake-agent emits a success scenario and
//     exits cleanly. Same pattern as `workspace-create-via.test.ts`
//     (TEST-27, TEST-30).
//   • Tasks dispatch asynchronously after `tasks.submit` returns — we
//     wait via the existing `tasks.list` polling helper rather than a
//     wall-clock sleep (TEST-24).

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  writeFileSync(join(repoPath, "README.md"), "# strip test\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "init"]);
  return repoPath;
}

/**
 * Minimal scenario for `fake-agent.mjs`: announce a session, then report
 * a successful turn so `taskService.submitTask` records a completed task
 * and tears the agent down cleanly. Reused from
 * `workspace-create-via.test.ts` so the same scenario shape pins both
 * dispatch surfaces (chat-submit and workspaces.create) — drift here
 * would silently break the workspaces.create assertions.
 */
function writeChatScenario(tmpHome: string, name: string): string {
  const scenarioPath = join(tmpHome, name);
  writeFileSync(
    scenarioPath,
    JSON.stringify([
      { type: "system", subtype: "init", session_id: "strip-test-session" },
      { type: "result", subtype: "success", result: "Done" },
    ]),
    "utf-8",
  );
  return scenarioPath;
}

interface SubmitResponse {
  id: string;
  workspaceId: string;
  chatId: string;
  sessionId?: string;
}

interface CreateResponse {
  ok: true;
  path: string;
  via?: "chat" | "terminal";
  terminalId?: string;
}

interface TaskListItem {
  id: string;
  workspaceId: string;
  prompt: string;
  status: string;
}

/**
 * Wait until the predicate returns a truthy value or the timeout fires.
 * Same shape as the helper in `workspace-create-via.test.ts` — kept inline
 * here rather than promoted to `helpers/` to avoid one more cross-file
 * dependency for a test that's otherwise self-contained.
 */
async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  {
    timeoutMs = 10_000,
    intervalMs = 50,
    label = "condition",
  }: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const start = Date.now();
  const notDone = (v: T | undefined | null | false): v is undefined | null | false =>
    v === undefined || v === null || v === false;
  let value = await fn();
  while (notDone(value)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    value = await fn();
  }
  return value;
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

// ---------------------------------------------------------------------------
// tasks.submit — Zod silently strips a legacy `maxTurns` field from the
// request body. Both the no-field baseline and the legacy-field case must
// return the same SubmitResponse shape; a 400 here would mean Band's tRPC
// router rejected the request, breaking older CLI builds.
// ---------------------------------------------------------------------------

describe("tasks.submit — legacy maxTurns is silently stripped", () => {
  const TOKEN = "strip-tasks-submit-token";
  let server: ServerHandle;
  let tmpHome: string;
  const WORKSPACE_ID = toWorkspaceId("stripproj", "main");

  beforeAll(async () => {
    tmpHome = createTmpHome("band-strip-tasks-");
    const repoPath = createGitRepo(tmpHome, "stripproj");
    const scenarioPath = writeChatScenario(tmpHome, "scenario.json");
    seedState(tmpHome, {
      projects: [
        {
          name: "stripproj",
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
      env: { FAKE_AGENT_SCENARIO: scenarioPath },
    });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("submits successfully without a maxTurns field (baseline)", async () => {
    // Distinct chatId per assertion so the second submission can't 409 on
    // an in-flight task in the same chat pane (the chat pool enforces
    // one running task per chatId; fake-agent finishes quickly enough but
    // we don't want to depend on that race for correctness).
    const res = await trpcMutate(
      server.url,
      "tasks.submit",
      {
        workspaceId: WORKSPACE_ID,
        chatId: "strip-chat-baseline",
        prompt: "baseline no-maxTurns",
      },
      TOKEN,
    );
    const body = await res.text();
    expect(res.status, `tasks.submit failed: ${body}`).toBe(200);

    const data = (JSON.parse(body) as { result: { data: SubmitResponse } }).result.data;
    expect(data.id).toMatch(/^tsk_/);
    expect(data.workspaceId).toBe(WORKSPACE_ID);
    expect(data.chatId).toBe("strip-chat-baseline");

    // Positive anchor: the task actually landed on the queue.
    const tasks = await waitFor(
      async () => {
        const list = await listTasksForWorkspace(server.url, WORKSPACE_ID, TOKEN);
        return list.find((t) => t.id === data.id) ? list : undefined;
      },
      { label: "baseline task persisted" },
    );
    expect(tasks.some((t) => t.id === data.id)).toBe(true);
  });

  it("submits successfully when a legacy maxTurns field is present", async () => {
    // Cast through Record<string, unknown> because TypeScript narrows
    // `trpcMutate`'s `input: unknown` to the inferred tRPC procedure type
    // at the call site, and the procedure no longer declares `maxTurns`.
    // The test is exactly the "the runtime accepts a key the type system
    // says doesn't exist" case — that's the whole point.
    const legacyBody: Record<string, unknown> = {
      workspaceId: WORKSPACE_ID,
      chatId: "strip-chat-legacy",
      prompt: "legacy with maxTurns:5",
      maxTurns: 5,
    };
    const res = await trpcMutate(server.url, "tasks.submit", legacyBody, TOKEN);
    const body = await res.text();
    expect(res.status, `tasks.submit failed for legacy body: ${body}`).toBe(200);

    const data = (JSON.parse(body) as { result: { data: SubmitResponse } }).result.data;
    expect(data.id).toMatch(/^tsk_/);
    expect(data.workspaceId).toBe(WORKSPACE_ID);
    expect(data.chatId).toBe("strip-chat-legacy");

    // The dispatched task carries the same fields as the baseline. The
    // server-side `TaskRecord` no longer carries `maxTurns` (the column
    // was dropped by the `20260619184346_drop_tasks_max_turns` migration);
    // listing the task pins that the persistence layer was not asked to
    // write a column that no longer exists.
    const tasks = await waitFor(
      async () => {
        const list = await listTasksForWorkspace(server.url, WORKSPACE_ID, TOKEN);
        return list.find((t) => t.id === data.id) ? list : undefined;
      },
      { label: "legacy-maxTurns task persisted" },
    );
    const found = tasks.find((t) => t.id === data.id);
    expect(found).toBeDefined();
    expect(found!.prompt).toBe("legacy with maxTurns:5");
    // Pin the shape of the row: `maxTurns` is no longer part of the
    // TaskListItem contract and a future regression that re-attaches the
    // field to the wire payload should fail this assertion. Casting back
    // to `Record<string, unknown>` lets us inspect properties that aren't
    // on the static type.
    expect((found as unknown as Record<string, unknown>).maxTurns).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// workspaces.create — same contract for the workspace-bootstrap path.
// The mutation dispatches an initial chat task when `prompt` is supplied;
// `maxTurns` on the request body must be silently stripped, and the
// dispatched task must land on `tasks.list` exactly as if it had been
// omitted. Two fresh branches keep the assertions independent.
// ---------------------------------------------------------------------------

describe("workspaces.create — legacy maxTurns is silently stripped", () => {
  const TOKEN = "strip-workspaces-create-token";
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome("band-strip-wscreate-");
    const repoPath = createGitRepo(tmpHome, "wsproj");
    const scenarioPath = writeChatScenario(tmpHome, "scenario.json");
    seedState(tmpHome, {
      projects: [
        {
          name: "wsproj",
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
      env: { FAKE_AGENT_SCENARIO: scenarioPath },
    });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("dispatches a chat task without a maxTurns field (baseline)", async () => {
    const res = await trpcMutate(
      server.url,
      "workspaces.create",
      {
        project: "wsproj",
        branch: "feat/strip-baseline",
        prompt: "baseline workspace prompt",
        via: "chat",
      },
      TOKEN,
    );
    const body = await res.text();
    expect(res.status, `workspaces.create failed: ${body}`).toBe(200);

    const data = (JSON.parse(body) as { result: { data: CreateResponse } }).result.data;
    expect(data.via).toBe("chat");
    expect(data.ok).toBe(true);

    const workspaceId = toWorkspaceId("wsproj", "feat/strip-baseline");
    const tasks = await waitFor(
      async () => {
        const list = await listTasksForWorkspace(server.url, workspaceId, TOKEN);
        return list.find((t) => t.prompt === "baseline workspace prompt") ? list : undefined;
      },
      { label: "baseline workspace task dispatched" },
    );
    expect(tasks.some((t) => t.prompt === "baseline workspace prompt")).toBe(true);
  });

  it("dispatches a chat task when a legacy maxTurns field is present", async () => {
    // Same Record<string, unknown> escape hatch as the tasks.submit case
    // — the procedure type no longer carries `maxTurns`, so the test
    // explicitly opts out of the static check to drive the runtime
    // strip-path.
    const legacyBody: Record<string, unknown> = {
      project: "wsproj",
      branch: "feat/strip-legacy",
      prompt: "legacy workspace prompt",
      via: "chat",
      maxTurns: 5,
    };
    const res = await trpcMutate(server.url, "workspaces.create", legacyBody, TOKEN);
    const body = await res.text();
    expect(res.status, `workspaces.create failed for legacy body: ${body}`).toBe(200);

    const data = (JSON.parse(body) as { result: { data: CreateResponse } }).result.data;
    expect(data.via).toBe("chat");
    expect(data.ok).toBe(true);

    // Positive anchor: the dispatched task matches the baseline shape.
    const workspaceId = toWorkspaceId("wsproj", "feat/strip-legacy");
    const tasks = await waitFor(
      async () => {
        const list = await listTasksForWorkspace(server.url, workspaceId, TOKEN);
        return list.find((t) => t.prompt === "legacy workspace prompt") ? list : undefined;
      },
      { label: "legacy-maxTurns workspace task dispatched" },
    );
    const found = tasks.find((t) => t.prompt === "legacy workspace prompt");
    expect(found).toBeDefined();
    expect((found as unknown as Record<string, unknown>).maxTurns).toBeUndefined();
  });
});
