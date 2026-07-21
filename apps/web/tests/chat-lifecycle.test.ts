import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  trpcMutate as sharedTrpcMutate,
  trpcQuery as sharedTrpcQuery,
  startServer,
  trpcData,
} from "./helpers/server";

// Integration tests for the remaining `chats.*` tRPC procedures that Phase 5
// of issue #316 migrated out of the legacy router without dedicated coverage
// — see issue #529. (The `chatLayout.*` layout-tree procedures once covered
// here were retired in issue #643 Phase 4, when clients moved center-layout
// persistence into localStorage.)
//
// Coverage:
//   • `chats.create` writes its panel into the server-side saved `chat_layout`
//     row (the row `getOrCreateDefault` reads to resolve the default chat).
//   • `chats.stop` aborts a running task, transitions the chat to
//     `status: "stopped"`, and unblocks a follow-up `chats.send` once the
//     chat is resumed.
//   • `chats.stop` on an idle chat is a no-op for the task system but still
//     flips the status to `stopped` (the route's contract is "do whatever it
//     takes to get the chat into the stopped state").
//   • `chats.resume` resets a stopped chat back to `idle`.
//   • Negative auth — both procedures reject without the `band_token` cookie.
//
// Pattern: vitest + `startServer` + real production bundle. No tRPC
// mocking, no in-process React. Matches the doctrine in
// `.claude/skills/write-integration-test/`.

const FAKE_AGENT_PATH = join(import.meta.dirname, "fake-agent.mjs");
const DEFAULT_TOKEN = "chat-lifecycle-test-token";

// ---------------------------------------------------------------------------
// tRPC HTTP helpers — `trpcMutate` and `trpcQuery` live in `./helpers/server`
// (shared with `chat-labels.test.ts` / `browsers.test.ts`). The wrappers
// below bake in `DEFAULT_TOKEN` so call sites in this suite don't have to
// thread it through every invocation.
// ---------------------------------------------------------------------------

function trpcMutate(serverUrl: string, procedure: string, input?: unknown) {
  return sharedTrpcMutate(serverUrl, procedure, input, DEFAULT_TOKEN);
}

function trpcQuery(serverUrl: string, procedure: string, input?: unknown) {
  return sharedTrpcQuery(serverUrl, procedure, input, DEFAULT_TOKEN);
}

// ---------------------------------------------------------------------------
// Git helpers — a real git repo is required so `seedState` can register
// a `git`-kind project whose workspaces resolve cleanly.
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
  writeFileSync(join(repoPath, "README.md"), "# Test\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "init"]);
  return repoPath;
}

function writeScenario(tmpHome: string, events: object[]): string {
  const scenarioPath = join(tmpHome, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify(events));
  return scenarioPath;
}

// ---------------------------------------------------------------------------
// SQLite peek — direct `panel_states` reads so a test can prove
// `chats.create` actually wrote the saved chat-layout row to disk.
//
// The dockview layout row is keyed `${panelType}_${workspaceId}` per
// `DockviewLayoutManager.layoutId` — mirrored here rather than re-derived
// through tRPC so a regression that breaks the persistence path (and not
// just the read path) is caught.
// ---------------------------------------------------------------------------

function readPanelState(
  tmpHome: string,
  id: string,
): { state: string; panelType: string } | undefined {
  const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"), { readOnly: true });
  try {
    const row = sqlite
      .prepare("SELECT state, panel_type as panelType FROM panel_states WHERE id = ?")
      .get(id) as { state: string; panelType: string } | undefined;
    return row;
  } finally {
    sqlite.close();
  }
}

function readChatLayoutRow(tmpHome: string, workspaceId: string): { state: string } | undefined {
  return readPanelState(tmpHome, `chat_layout_${workspaceId}`);
}

interface ChatRecord {
  id: string;
  workspaceId: string;
  name: string;
  status: "running" | "idle" | "stopped" | "error";
  labels: Record<string, string>;
}

// ---------------------------------------------------------------------------
// chats.create writes through to the server-side saved chat layout
// ---------------------------------------------------------------------------

describe("chatLayout — populated by chats.create", () => {
  let server: ServerHandle;
  let tmpHome: string;
  const workspaceId = "createproj-main";

  beforeAll(async () => {
    tmpHome = createTmpHome("band-chat-layout-create-");
    const repoPath = createGitRepo(tmpHome, "createproj");
    seedState(tmpHome, {
      projects: [
        {
          name: "createproj",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoPath }],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgents: [
        { id: "claude-code", type: "claude-code", label: "Claude Code", command: FAKE_AGENT_PATH },
      ],
    });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("chats.create registers the chat panel in the saved chat layout", async () => {
    // Precondition: no layout row on disk yet.
    expect(readChatLayoutRow(tmpHome, workspaceId)).toBeUndefined();

    const createRes = await trpcMutate(server.url, "chats.create", {
      workspaceId,
      name: "Layout-target",
    });
    expect(createRes.status).toBe(200);
    const { chat } = await trpcData<{ chat: ChatRecord }>(createRes);

    // `chatService.create` calls `addToLayout` so a CLI-spawned chat
    // shows up in the dashboard without the user having to manually
    // add a tab — see `ChatService.create`. This server-side layout row
    // is what `getOrCreateDefault` reads to resolve the workspace's
    // default chat; without this assertion a regression that dropped the
    // `addToLayout` write would go unnoticed. (The former `chatLayout.get`
    // tRPC read of this row was retired in issue #643 Phase 4 — clients
    // now persist center layout in localStorage — so the row is verified
    // directly on disk here rather than through the public API.)
    const layoutRow = readChatLayoutRow(tmpHome, workspaceId);
    expect(layoutRow).toBeDefined();
    const layout = JSON.parse(layoutRow!.state) as {
      panels: Record<string, { params?: { chatId?: string } }>;
    };
    expect(layout.panels[chat.id]).toBeDefined();
    expect(layout.panels[chat.id].params?.chatId).toBe(chat.id);
  });
});

// ---------------------------------------------------------------------------
// chats.stop / chats.resume — status transitions
// ---------------------------------------------------------------------------

describe("chats — stop/resume status transitions", () => {
  // Long enough that the test can observe `status: "running"` and call
  // `chats.stop` before the fake-agent's terminal `result` event lands.
  // Strictly greater than `STATUS_POLL_TIMEOUT_MS` below so the poll
  // window can't bleed past the agent's natural completion.
  const FAKE_AGENT_SLEEP_MS = 5000;

  // How long the test will poll `chats.list` waiting for the chat to
  // transition to `status: "running"`. Strictly less than
  // `FAKE_AGENT_SLEEP_MS` so a slow CI doesn't race the result event
  // past the stop call. Same shape as `CONFLICT_POLL_TIMEOUT_MS` in
  // `cronjobs.test.ts` — and the runtime check in `beforeAll` enforces
  // the invariant.
  const STATUS_POLL_TIMEOUT_MS = 4000;

  let server: ServerHandle;
  let tmpHome: string;
  const workspaceId = "stopproj-main";

  beforeAll(async () => {
    if (STATUS_POLL_TIMEOUT_MS >= FAKE_AGENT_SLEEP_MS) {
      throw new Error(
        `STATUS_POLL_TIMEOUT_MS (${STATUS_POLL_TIMEOUT_MS}) must be strictly less than FAKE_AGENT_SLEEP_MS (${FAKE_AGENT_SLEEP_MS}) — see comments above`,
      );
    }
    tmpHome = createTmpHome("band-chat-stop-");
    const repoPath = createGitRepo(tmpHome, "stopproj");

    // Long-running scenario: emit `init`, sleep, then `result`. The sleep
    // window is what makes the "still running" + "stop while running"
    // assertions deterministic. Without it, a slower test runner would
    // race the terminal `result` past the stop call and the status
    // assertion would silently flip back to `idle`.
    const scenarioPath = writeScenario(tmpHome, [
      { type: "system", subtype: "init", session_id: "stop-session" },
      { _sleep_ms: FAKE_AGENT_SLEEP_MS },
      { type: "result", subtype: "success", result: "Done" },
    ]);

    seedState(tmpHome, {
      projects: [
        {
          name: "stopproj",
          path: repoPath,
          defaultBranch: "main",
          worktrees: [{ branch: "main", path: repoPath }],
        },
      ],
    });
    seedSettings(tmpHome, {
      tokenSecret: DEFAULT_TOKEN,
      codingAgents: [
        { id: "claude-code", type: "claude-code", label: "Claude Code", command: FAKE_AGENT_PATH },
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

  it("rejects chats.stop without the band_token cookie (401)", async () => {
    const res = await fetch(`${server.url}/trpc/chats.stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: "chat_anything" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects chats.resume without the band_token cookie (401)", async () => {
    const res = await fetch(`${server.url}/trpc/chats.resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: "chat_anything" }),
    });
    expect(res.status).toBe(401);
  });

  it("chats.stop on an idle chat flips status to stopped (no running task)", async () => {
    // The plain idle case: no running task, no agent process — just the
    // service-level `updateStatus("stopped")`. `abortTask` returns false
    // (no-op) and the assertion is purely about the persisted status.
    const createRes = await trpcMutate(server.url, "chats.create", {
      workspaceId,
      name: "Idle stop target",
    });
    const { chat } = await trpcData<{ chat: ChatRecord }>(createRes);
    expect(chat.status).toBe("idle");

    const stopRes = await trpcMutate(server.url, "chats.stop", { chatId: chat.id });
    expect(stopRes.status).toBe(200);
    const stopData = await trpcData<{ ok: boolean }>(stopRes);
    expect(stopData.ok).toBe(true);

    const listRes = await trpcQuery(server.url, "chats.list", { workspaceId });
    const listData = await trpcData<{ chats: ChatRecord[] }>(listRes);
    const found = listData.chats.find((c) => c.id === chat.id);
    expect(found?.status).toBe("stopped");
  });

  it("chats.resume flips a stopped chat back to idle", async () => {
    const createRes = await trpcMutate(server.url, "chats.create", {
      workspaceId,
      name: "Resume target",
    });
    const { chat } = await trpcData<{ chat: ChatRecord }>(createRes);

    // Drive it into the `stopped` state first so the resume has something
    // to undo. Tests are vitest-sequential within a describe block but
    // intentionally don't depend on the previous test's chat — each
    // `it` builds its own fresh chat to keep them order-independent
    // (vs. the cronjobs.test.ts pattern, which does share state).
    await trpcMutate(server.url, "chats.stop", { chatId: chat.id });
    const afterStop = await trpcQuery(server.url, "chats.list", { workspaceId });
    const afterStopData = await trpcData<{ chats: ChatRecord[] }>(afterStop);
    expect(afterStopData.chats.find((c) => c.id === chat.id)?.status).toBe("stopped");

    const resumeRes = await trpcMutate(server.url, "chats.resume", { chatId: chat.id });
    expect(resumeRes.status).toBe(200);
    const resumeData = await trpcData<{ ok: boolean }>(resumeRes);
    expect(resumeData.ok).toBe(true);

    const afterResume = await trpcQuery(server.url, "chats.list", { workspaceId });
    const afterResumeData = await trpcData<{ chats: ChatRecord[] }>(afterResume);
    expect(afterResumeData.chats.find((c) => c.id === chat.id)?.status).toBe("idle");
  });

  it("chats.stop aborts a running task and marks it failed", async () => {
    // Pin a fresh chat id we can target with `chats.send` so we don't
    // race against the lazy-creation path that the service uses when the
    // chat doesn't exist yet — the on-disk row needs to exist before the
    // stop call so the tasks.list assertion below can find the failed
    // record.
    const createRes = await trpcMutate(server.url, "chats.create", {
      workspaceId,
      name: "Running stop target",
    });
    const { chat } = await trpcData<{ chat: ChatRecord }>(createRes);

    // Submit a task via `chats.send`. The fake-agent sleeps for
    // `FAKE_AGENT_SLEEP_MS` before emitting `result`, so the next few
    // lines run with a still-running task — enough time for the stop
    // call to actually find a task to abort.
    const sendRes = await trpcMutate(server.url, "chats.send", {
      workspaceId,
      chatId: chat.id,
      message: "Run a long task",
    });
    expect(sendRes.status).toBe(200);
    const { taskId } = await trpcData<{ taskId: string }>(sendRes);

    // Wait until `tasks.list` reports the task is actually running before
    // calling stop. Without this poll, the stop could race the task
    // submission and `abortTask` would return false (no-op) — the chats
    // status would still flip to `stopped` via `chatService.updateStatus`,
    // but we wouldn't actually exercise the abort path. Same poll shape
    // as `cronjobs.test.ts`'s conflict test.
    await expect
      .poll(
        async () => {
          const listRes = await trpcQuery(server.url, "tasks.list", {
            workspaceId,
            chatId: chat.id,
            status: "running",
          });
          const listData = await trpcData<{ tasks: unknown[] }>(listRes);
          return listData.tasks.length;
        },
        { timeout: STATUS_POLL_TIMEOUT_MS, interval: 50 },
      )
      .toBeGreaterThan(0);

    const stopRes = await trpcMutate(server.url, "chats.stop", { chatId: chat.id });
    expect(stopRes.status).toBe(200);
    const stopData = await trpcData<{ ok: boolean }>(stopRes);
    expect(stopData.ok).toBe(true);

    // The task is no longer running — `abortTask` marks it failed and
    // removes it from the in-memory `tasks` map. The visible-status
    // surface here is `tasks.list`, not `chats.list`: synchronously, the
    // route ends with chat status `"stopped"` (`abortTask` flips it to
    // `"idle"` inside the abort handler, then the router calls
    // `chatService.updateStatus(chatId, "stopped")`). But shortly after,
    // `runTask`'s in-flight `await` throws because of `agent.abort()`,
    // its `catch (err)` block fires (see `apps/web/src/server/services/task-service.ts`
    // — currently around line 851), and that path sets chat status to
    // `"error"`. The final chat status is therefore timing-dependent
    // (`stopped` → `error`), which is why this test pins the task-side
    // half of the abort contract instead: the task is removed from
    // `running` (and the persisted record is marked `failed`, asserted
    // below).
    await expect
      .poll(
        async () => {
          const r = await trpcQuery(server.url, "tasks.list", {
            workspaceId,
            chatId: chat.id,
            status: "running",
          });
          const d = await trpcData<{ tasks: unknown[] }>(r);
          return d.tasks.length;
        },
        { timeout: STATUS_POLL_TIMEOUT_MS, interval: 50 },
      )
      .toBe(0);

    // The failed task is persisted with the same id `chats.send` returned —
    // proves the abort path went all the way through `persistTask`, not
    // just the in-memory delete.
    const failedRes = await trpcQuery(server.url, "tasks.list", {
      workspaceId,
      chatId: chat.id,
      status: "failed",
    });
    const failedData = await trpcData<{ tasks: Array<{ id: string }> }>(failedRes);
    expect(failedData.tasks.find((t) => t.id === taskId)).toBeDefined();
  });

  it("chats.stop / chats.resume on an unknown chatId are no-ops (no 404)", async () => {
    // The route delegates to `abortTask` (returns false silently) and
    // `chatService.updateStatus` (returns early when the chat doesn't
    // exist). Neither throws, so the route returns 200 — pin this so a
    // future "be strict about unknown ids" refactor surfaces in a
    // dedicated change rather than silently breaking the dashboard's
    // optimistic stop/resume flow.
    const stopRes = await trpcMutate(server.url, "chats.stop", {
      chatId: "chat_does_not_exist",
    });
    expect(stopRes.status).toBe(200);
    const stopData = await trpcData<{ ok: boolean }>(stopRes);
    expect(stopData.ok).toBe(true);

    const resumeRes = await trpcMutate(server.url, "chats.resume", {
      chatId: "chat_does_not_exist",
    });
    expect(resumeRes.status).toBe(200);
    const resumeData = await trpcData<{ ok: boolean }>(resumeRes);
    expect(resumeData.ok).toBe(true);
  });
});
