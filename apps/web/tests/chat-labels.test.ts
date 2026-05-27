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
  startServer,
} from "./helpers/server";

// Integration tests for issue #520 — panel labels + cronjob chat dispatch.
//
// Coverage:
//   • Migration adds the column; existing rows load with empty labels.
//   • createChat({ labels }) round-trips through SQLite.
//   • updateChat({ labels }) replaces the full label set.
//   • Validation rejects: too many keys, oversized keys/values, bad
//     characters, empty values, reserved `band:` prefix from tRPC.
//   • cronjobs.trigger creates a chat tagged with `band:cronId` on first
//     fire, reuses it on subsequent fires, and recreates it cleanly when
//     deleted between fires.
//   • Two cronjobs in the same workspace produce two distinct chats.

const FAKE_AGENT_PATH = join(import.meta.dirname, "fake-agent.mjs");
const DEFAULT_TOKEN = "chat-labels-test-token";

// ---------------------------------------------------------------------------
// tRPC HTTP helpers — `trpcMutate` lives in `./helpers/server` (shared with
// `workspace-remove-detached.test.ts`); `trpcQuery` is local because none of
// the other migrated suites need it yet. If a third caller appears, lift it.
// ---------------------------------------------------------------------------

const defaultAuthHeader = { Cookie: `band_token=${DEFAULT_TOKEN}` };

async function trpcQuery(serverUrl: string, procedure: string, input?: unknown) {
  const url =
    input !== undefined
      ? `${serverUrl}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`
      : `${serverUrl}/trpc/${procedure}`;
  return fetch(url, { headers: defaultAuthHeader });
}

// Wrap the shared `trpcMutate` so call sites in this suite don't need to
// thread `DEFAULT_TOKEN` through every invocation. The 4-arg shared
// helper takes the token explicitly precisely so different suites can
// bind their own.
function trpcMutate(serverUrl: string, procedure: string, input?: unknown) {
  return sharedTrpcMutate(serverUrl, procedure, input, DEFAULT_TOKEN);
}

async function trpcData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

// ---------------------------------------------------------------------------
// Git helpers
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

interface ChatRecord {
  id: string;
  name: string;
  labels: Record<string, string>;
}

// ---------------------------------------------------------------------------
// chats.create + chats.update — label round-trip + validation
// ---------------------------------------------------------------------------

describe("chats — label round-trip", () => {
  let server: ServerHandle;
  let tmpHome: string;
  const workspaceId = "myproject-main";

  beforeAll(async () => {
    tmpHome = createTmpHome("band-chat-labels-");
    const repoPath = createGitRepo(tmpHome, "myproject");
    seedState(tmpHome, {
      projects: [
        {
          name: "myproject",
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

  it("rejects chats.create without the band_token cookie (401)", async () => {
    // Negative-auth test for the integration-test doctrine: error paths
    // are part of the contract. The shared `trpcMutate` always sends the
    // cookie, so we have to call `fetch` directly to omit it.
    const res = await fetch(`${server.url}/trpc/chats.create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, labels: { phase: "plan" } }),
    });
    expect(res.status).toBe(401);
  });

  it("creates a chat with labels and persists them through chats.list", async () => {
    const res = await trpcMutate(server.url, "chats.create", {
      workspaceId,
      name: "Tagged chat",
      labels: { phase: "plan", priority: "high" },
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ chat: ChatRecord }>(res);
    expect(data.chat.labels).toEqual({ phase: "plan", priority: "high" });

    const listRes = await trpcQuery(server.url, "chats.list", { workspaceId });
    const listData = await trpcData<{ chats: ChatRecord[] }>(listRes);
    const found = listData.chats.find((c) => c.id === data.chat.id);
    expect(found?.labels).toEqual({ phase: "plan", priority: "high" });
  });

  it("returns empty labels {} for chats created without labels (legacy parity)", async () => {
    const res = await trpcMutate(server.url, "chats.create", {
      workspaceId,
      name: "Bare chat",
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ chat: ChatRecord }>(res);
    expect(data.chat.labels).toEqual({});
  });

  it("survives a server restart — labels rehydrate from SQLite", async () => {
    // Create a labeled chat
    const createRes = await trpcMutate(server.url, "chats.create", {
      workspaceId,
      name: "Restart-survivor",
      labels: { kind: "rehydration-test" },
    });
    const { chat: created } = await trpcData<{ chat: ChatRecord }>(createRes);

    // Restart the server (closes the SQLite handle so the next boot
    // re-reads the row through loadChatsFromDb).
    await server.close();
    server = await startServer({ tmpHome });

    const listRes = await trpcQuery(server.url, "chats.list", { workspaceId });
    const listData = await trpcData<{ chats: ChatRecord[] }>(listRes);
    const found = listData.chats.find((c) => c.id === created.id);
    expect(found?.labels).toEqual({ kind: "rehydration-test" });
  });

  it("chats.update replaces the full label set", async () => {
    const createRes = await trpcMutate(server.url, "chats.create", {
      workspaceId,
      name: "Update-target",
      labels: { phase: "plan" },
    });
    const { chat: created } = await trpcData<{ chat: ChatRecord }>(createRes);

    const updateRes = await trpcMutate(server.url, "chats.update", {
      chatId: created.id,
      labels: { phase: "implement", owner: "alice" },
    });
    expect(updateRes.status).toBe(200);
    const updated = await trpcData<{ chat: ChatRecord }>(updateRes);
    expect(updated.chat.labels).toEqual({ phase: "implement", owner: "alice" });
  });

  it("chats.update with labels: {} clears all labels", async () => {
    const createRes = await trpcMutate(server.url, "chats.create", {
      workspaceId,
      name: "Clear-target",
      labels: { phase: "plan" },
    });
    const { chat: created } = await trpcData<{ chat: ChatRecord }>(createRes);

    const clearRes = await trpcMutate(server.url, "chats.update", {
      chatId: created.id,
      labels: {},
    });
    expect(clearRes.status).toBe(200);
    const cleared = await trpcData<{ chat: ChatRecord }>(clearRes);
    expect(cleared.chat.labels).toEqual({});
  });

  it("chats.update returns 404 for an unknown chatId (no silent no-op)", async () => {
    // Pre-#520 behaviour was 200 + `chat: undefined`. Once `labels` became a
    // "replace the whole record" field, a silent no-op on a typo'd id would
    // let a caller believe their relabel succeeded. Lock in the 404.
    const res = await trpcMutate(server.url, "chats.update", {
      chatId: "chat_does_not_exist",
      labels: { phase: "plan" },
    });
    expect(res.status).toBe(404);
  });

  it("chats.list serializes labels with keys in sorted order", async () => {
    // Insertion order is deliberately reversed so the assertion catches
    // the validateLabels normalization, not happenstance from V8's
    // own iteration order.
    const createRes = await trpcMutate(server.url, "chats.create", {
      workspaceId,
      name: "Sorted",
      labels: { zeta: "z", alpha: "a", mu: "m" },
    });
    expect(createRes.status).toBe(200);
    const { chat: created } = await trpcData<{ chat: ChatRecord }>(createRes);

    const listRes = await trpcQuery(server.url, "chats.list", { workspaceId });
    const listData = await trpcData<{ chats: ChatRecord[] }>(listRes);
    const found = listData.chats.find((c) => c.id === created.id);
    expect(found?.labels).toBeDefined();
    expect(Object.keys(found!.labels)).toEqual(["alpha", "mu", "zeta"]);
  });
});

// ---------------------------------------------------------------------------
// Validation — write boundary rejects malformed payloads
// ---------------------------------------------------------------------------

describe("chats — label validation", () => {
  let server: ServerHandle;
  let tmpHome: string;
  const workspaceId = "myproject-main";

  beforeAll(async () => {
    tmpHome = createTmpHome("band-chat-labels-");
    const repoPath = createGitRepo(tmpHome, "myproject");
    seedState(tmpHome, {
      projects: [
        {
          name: "myproject",
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

  it("rejects label keys using the reserved band: prefix from tRPC", async () => {
    const res = await trpcMutate(server.url, "chats.create", {
      workspaceId,
      labels: { "band:cronId": "cj_user_attempt" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/reserved/);
  });

  it("rejects more than 20 keys", async () => {
    const labels: Record<string, string> = {};
    for (let i = 0; i < 21; i++) labels[`key${i}`] = "v";
    const res = await trpcMutate(server.url, "chats.create", { workspaceId, labels });
    expect(res.status).toBe(400);
  });

  it("rejects keys with disallowed characters", async () => {
    const res = await trpcMutate(server.url, "chats.create", {
      workspaceId,
      labels: { "bad key!": "v" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty keys", async () => {
    const res = await trpcMutate(server.url, "chats.create", {
      workspaceId,
      labels: { "": "v" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty values", async () => {
    const res = await trpcMutate(server.url, "chats.create", {
      workspaceId,
      labels: { phase: "" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects values exceeding 256 chars", async () => {
    const big = "x".repeat(257);
    const res = await trpcMutate(server.url, "chats.create", {
      workspaceId,
      labels: { phase: big },
    });
    expect(res.status).toBe(400);
  });

  it("rejects non-printable values (control characters)", async () => {
    const res = await trpcMutate(server.url, "chats.create", {
      workspaceId,
      labels: { phase: "plan\nwith-newline" },
    });
    expect(res.status).toBe(400);
  });

  it("accepts colons in keys (namespaced labels)", async () => {
    const res = await trpcMutate(server.url, "chats.create", {
      workspaceId,
      labels: { "user:phase": "plan" },
    });
    expect(res.status).toBe(200);
    const data = await trpcData<{ chat: ChatRecord }>(res);
    expect(data.chat.labels).toEqual({ "user:phase": "plan" });
  });
});

// ---------------------------------------------------------------------------
// Migration parity — legacy rows (no labels column written) load as {}
// ---------------------------------------------------------------------------

describe("chats — legacy panel_states rows load with empty labels", () => {
  let server: ServerHandle;
  let tmpHome: string;
  const workspaceId = "myproject-main";

  beforeAll(async () => {
    tmpHome = createTmpHome("band-chat-labels-");
    const repoPath = createGitRepo(tmpHome, "myproject");
    seedState(tmpHome, {
      projects: [
        {
          name: "myproject",
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

    // Inject a panel_states row with `labels` left NULL, simulating a row
    // written before the migration. The migration itself ran in `seedState`
    // (which calls drizzle's migrator before this insert), so the column
    // exists — what's tested here is the loader's tolerance of NULL.
    const sqlite = new DatabaseSync(join(tmpHome, ".band", "band.db"));
    try {
      const now = Date.now();
      const chatState = JSON.stringify({
        name: "Legacy chat",
        agent: "claude-code",
        model: null,
        mode: null,
        activeSessionId: null,
        activeSessionSummary: null,
        activeSessionLastModified: null,
        status: "idle",
      });
      sqlite
        .prepare(
          "INSERT INTO panel_states (id, workspace_id, panel_type, state, labels, created_at, updated_at) VALUES (?, ?, 'chat', ?, NULL, ?, ?)",
        )
        .run("chat_legacy_1", workspaceId, chatState, now, now);
    } finally {
      sqlite.close();
    }

    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("loads a NULL-labels row as {} through chats.list", async () => {
    const res = await trpcQuery(server.url, "chats.list", { workspaceId });
    const data = await trpcData<{ chats: ChatRecord[] }>(res);
    const legacy = data.chats.find((c) => c.id === "chat_legacy_1");
    expect(legacy).toBeDefined();
    expect(legacy?.labels).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Cronjob dispatch — owns its own chat via band:cronId label
// ---------------------------------------------------------------------------

describe("cronjobs — labeled chat dispatch", () => {
  let server: ServerHandle;
  let tmpHome: string;
  let jobId: string;
  let secondJobId: string;
  const workspaceId = "triggerproj-main";

  beforeAll(async () => {
    tmpHome = createTmpHome("band-chat-labels-");
    const repoPath = createGitRepo(tmpHome, "triggerproj");

    // Multi-message scenario: the fake agent emits these for *every* run.
    // Each cron tick submits a new task; the agent replies with one init
    // record + one result so the task transitions to "completed" before
    // the next trigger.
    const scenarioPath = writeScenario(tmpHome, [
      { type: "system", subtype: "init", session_id: "trigger-session" },
      { type: "result", subtype: "success", result: "Done" },
    ]);

    seedState(tmpHome, {
      projects: [
        {
          name: "triggerproj",
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

    const createRes = await trpcMutate(server.url, "cronjobs.create", {
      key: "triggerproj",
      name: "Daily check",
      prompt: "Run automated check",
      cronExpression: "0 0 * * *",
      scope: "project",
    });
    const data = await trpcData<{ job: { id: string } }>(createRes);
    jobId = data.job.id;

    const secondRes = await trpcMutate(server.url, "cronjobs.create", {
      key: "triggerproj",
      name: "Other check",
      prompt: "Run other automated check",
      cronExpression: "30 0 * * *",
      scope: "project",
    });
    const secondData = await trpcData<{ job: { id: string } }>(secondRes);
    secondJobId = secondData.job.id;
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  /** Poll chats.list until the task on the cronjob's chat has finished, so
   * the next trigger doesn't trip TaskConflictError. Uses `expect.poll` to
   * follow the integration-test doctrine (auto-retry with a built-in
   * timeout/interval) — a hand-rolled `setTimeout` loop would silently
   * absorb the polling cadence into the test runtime instead of letting
   * vitest log it. A missing chat is treated as idle (the
   * delete-and-recreate test removes the chat between triggers). */
  async function waitForChatIdle(chatId: string): Promise<void> {
    await expect
      .poll(
        async () => {
          const res = await trpcQuery(server.url, "chats.list", { workspaceId });
          const data = await trpcData<{
            chats: Array<{ id: string; status: string }>;
          }>(res);
          const chat = data.chats.find((c) => c.id === chatId);
          return chat?.status ?? "idle";
        },
        { timeout: 10_000, interval: 100 },
      )
      .toBe("idle");
  }

  it("first trigger creates a chat tagged with band:cronId", async () => {
    const beforeRes = await trpcQuery(server.url, "chats.list", { workspaceId });
    const beforeData = await trpcData<{ chats: ChatRecord[] }>(beforeRes);
    const matchingBefore = beforeData.chats.filter((c) => c.labels[`band:cronId`] === jobId);
    expect(matchingBefore).toHaveLength(0);

    const res = await trpcMutate(server.url, "cronjobs.trigger", {
      key: "triggerproj",
      id: jobId,
    });
    expect(res.status).toBe(200);
    const triggerData = await trpcData<{ chatId: string; workspaceId: string }>(res);
    expect(triggerData.workspaceId).toBe(workspaceId);
    expect(triggerData.chatId).toMatch(/^chat_/);

    const afterRes = await trpcQuery(server.url, "chats.list", { workspaceId });
    const afterData = await trpcData<{ chats: ChatRecord[] }>(afterRes);
    const matching = afterData.chats.filter((c) => c.labels[`band:cronId`] === jobId);
    expect(matching).toHaveLength(1);
    expect(matching[0].id).toBe(triggerData.chatId);
    expect(matching[0].name).toBe("Daily check");

    await waitForChatIdle(triggerData.chatId);
  });

  it("subsequent trigger reuses the same chat (no duplicate creation)", async () => {
    const res = await trpcMutate(server.url, "cronjobs.trigger", {
      key: "triggerproj",
      id: jobId,
    });
    expect(res.status).toBe(200);
    const triggerData = await trpcData<{ chatId: string }>(res);

    const listRes = await trpcQuery(server.url, "chats.list", { workspaceId });
    const listData = await trpcData<{ chats: ChatRecord[] }>(listRes);
    const matching = listData.chats.filter((c) => c.labels[`band:cronId`] === jobId);
    expect(matching).toHaveLength(1);
    expect(matching[0].id).toBe(triggerData.chatId);

    await waitForChatIdle(triggerData.chatId);
  });

  it("a second cronjob in the same workspace gets its own chat", async () => {
    const res = await trpcMutate(server.url, "cronjobs.trigger", {
      key: "triggerproj",
      id: secondJobId,
    });
    expect(res.status).toBe(200);
    const triggerData = await trpcData<{ chatId: string }>(res);

    const listRes = await trpcQuery(server.url, "chats.list", { workspaceId });
    const listData = await trpcData<{ chats: ChatRecord[] }>(listRes);

    const firstJobChats = listData.chats.filter((c) => c.labels[`band:cronId`] === jobId);
    const secondJobChats = listData.chats.filter((c) => c.labels[`band:cronId`] === secondJobId);

    expect(firstJobChats).toHaveLength(1);
    expect(secondJobChats).toHaveLength(1);
    expect(firstJobChats[0].id).not.toBe(secondJobChats[0].id);
    expect(secondJobChats[0].id).toBe(triggerData.chatId);

    await waitForChatIdle(triggerData.chatId);
  });

  it("deleting the cron chat causes the next trigger to recreate it", async () => {
    // Look up the existing cron chat for `jobId`.
    const listRes = await trpcQuery(server.url, "chats.list", { workspaceId });
    const listData = await trpcData<{ chats: ChatRecord[] }>(listRes);
    const existing = listData.chats.find((c) => c.labels[`band:cronId`] === jobId);
    expect(existing).toBeDefined();
    const oldChatId = existing!.id;

    // User deletes the chat.
    const removeRes = await trpcMutate(server.url, "chats.remove", { chatId: oldChatId });
    expect(removeRes.status).toBe(200);

    const afterDeleteRes = await trpcQuery(server.url, "chats.list", { workspaceId });
    const afterDeleteData = await trpcData<{ chats: ChatRecord[] }>(afterDeleteRes);
    expect(afterDeleteData.chats.filter((c) => c.labels[`band:cronId`] === jobId)).toHaveLength(0);

    // Next trigger should re-create the chat with the same label.
    const triggerRes = await trpcMutate(server.url, "cronjobs.trigger", {
      key: "triggerproj",
      id: jobId,
    });
    expect(triggerRes.status).toBe(200);
    const triggerData = await trpcData<{ chatId: string }>(triggerRes);
    expect(triggerData.chatId).not.toBe(oldChatId);

    const finalRes = await trpcQuery(server.url, "chats.list", { workspaceId });
    const finalData = await trpcData<{ chats: ChatRecord[] }>(finalRes);
    const matching = finalData.chats.filter((c) => c.labels[`band:cronId`] === jobId);
    expect(matching).toHaveLength(1);
    expect(matching[0].id).toBe(triggerData.chatId);

    await waitForChatIdle(triggerData.chatId);
  });
});
