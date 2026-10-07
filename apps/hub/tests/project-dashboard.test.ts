// Integration test for the project dashboard read model (plan step 6.6, S3). A real hub with real git repos and
// the scripted ACP stub. Usage rows are seeded into the hub's SQLite file the way the scanner writes them, and
// every assertion goes through `projects.dashboard` and `projects.stopAgent`.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_TOKEN } from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { removeTmpHome } from "./helpers/tmp-home";
import { waitFor } from "./helpers/wait-for";

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv, stdio: "pipe" });

interface Dashboard {
  agents: Array<{
    chatId: string;
    role: string;
    status: string;
    spendUsd: number;
    worktreeId: string | null;
    model: string | null;
  }>;
  spend: {
    totalUsd: number;
    todayUsd: number;
    last7DaysUsd: number;
    unattributedUsd: number;
    budgetUsd: number | null;
    remainingUsd: number | null;
    days: Array<{ day: string; usd: number }>;
  };
}

let home: string;
let server: ServerHandle;

const m = async <T>(proc: string, input: unknown) => {
  const res = await trpcMutate(server.url, proc, input, TEST_TOKEN);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};
const q = async <T>(proc: string, input?: unknown) => {
  const res = await trpcQuery(server.url, proc, input, TEST_TOKEN);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};
const dashboard = (project: string) => q<Dashboard>("projects.dashboard", { project });

const seedSpend = (
  worktreeId: string,
  repo: string,
  chatId: string | null,
  costUsd: number,
  capturedAt: number,
  key: string,
) => {
  const db = new DatabaseSync(join(home, ".band", "band.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare(
      `INSERT INTO usage_events (task_id, chat_id, session_id, worktree_id, repo, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, reasoning_output_tokens, cost_usd, captured_at, external_key)
       VALUES ('', ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?, ?)`,
    ).run(chatId, `s-${key}`, worktreeId, repo, costUsd, capturedAt, key);
  } finally {
    db.close();
  }
};

let workerA: { worktreeId: string; chatId: string };
let coordinator: { chatId: string };
let projectScope: string;

beforeAll(async () => {
  home = createTmpHome("band-dashboard-");
  const repos = ["api", "docs"].map((name) => {
    const path = join(home, "repos", name);
    mkdirSync(path, { recursive: true });
    git(path, "init", "-q", "-b", "main");
    writeFileSync(join(path, "README.md"), `${name}\n`);
    git(path, "add", ".");
    git(path, "commit", "-q", "-m", "init");
    return { name, path, defaultBranch: "main", worktrees: [{ branch: "main", path }] };
  });
  seedState(home, { repos });
  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  const scenario = join(home, "scenario.json");
  writeFileSync(
    scenario,
    JSON.stringify({
      turns: [{ match: "^hold", steps: [{ waitForCancel: true }] }, { steps: [{ say: "ok" }] }],
    }),
  );
  server = await startServer({
    remoteHost: false,
    tmpHome: home,
    env: {
      BAND_SERVE_UI: "false",
      BAND_TEST_ACP_STATE: join(home, "acp-stub-state"),
      BAND_TEST_ACP_LOG: join(home, "acp-stub-log.jsonl"),
      BAND_TEST_ACP_SCENARIO: scenario,
    },
  });
  await m("projects.create", {
    name: "shop",
    repos: [{ repo: "api" }],
    policy: { budgetUsd: 10 },
  });
  await m("projects.create", { name: "other", repos: [{ repo: "docs" }] });
  await m("worktrees.create", { repo: "api", branch: "feat-a", projectId: "shop" });
  workerA = {
    worktreeId: "api-feat-a",
    chatId: (
      await m<{ chat: { id: string } }>("chats.create", { worktreeId: "api-feat-a", name: "a" })
    ).chat.id,
  };
  const { project } = await q<{ project: { id: string; coordinator: typeof coordinator } }>(
    "projects.get",
    { project: "shop" },
  );
  coordinator = project.coordinator;
  // The coordinator has no worktree, so the usage scanner's rows for it sit under the project scope.
  projectScope = `project:${project.id}`;
}, 180_000);

afterAll(async () => {
  await server?.close();
  if (home) removeTmpHome(home);
});

describe("project dashboard (S3)", () => {
  it("sums spend per project and per agent from the usage rows and shows the budget left", async () => {
    const now = Date.now();
    const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
    seedSpend(workerA.worktreeId, "api", workerA.chatId, 1.5, now, "k1");
    seedSpend(workerA.worktreeId, "api", workerA.chatId, 0.5, threeDaysAgo, "k2");
    seedSpend(projectScope, "api", coordinator.chatId, 2, now, "k3");
    // The scanner backfills sessions Band did not own with no chat id.
    seedSpend(workerA.worktreeId, "api", null, 0.25, now, "k4");
    // Too old for the 7 day window, still part of the total.
    seedSpend(workerA.worktreeId, "api", workerA.chatId, 1, tenDaysAgo, "k5");
    // Another project's spend never shows up here.
    seedSpend("docs-main", "docs", null, 99, now, "k6");

    const d = await dashboard("shop");
    const byChat = Object.fromEntries(d.agents.map((a) => [a.chatId, a]));
    expect(byChat[workerA.chatId]).toMatchObject({ role: "worker", spendUsd: 3 });
    expect(byChat[coordinator.chatId]).toMatchObject({ role: "coordinator", spendUsd: 2 });
    expect(d.spend).toMatchObject({
      totalUsd: 5.25,
      todayUsd: 3.75,
      last7DaysUsd: 4.25,
      unattributedUsd: 0.25,
      budgetUsd: 10,
      remainingUsd: 4.75,
    });
    expect(d.spend.days).toHaveLength(7);
    expect(d.spend.days.reduce((n, day) => n + day.usd, 0)).toBeCloseTo(4.25, 4);
  });

  it("leaves the remaining budget empty when the policy has none", async () => {
    const d = await dashboard("other");
    expect(d.spend).toMatchObject({ budgetUsd: null, remainingUsd: null });
  });

  it("lists agents with live status and stops a running one", async () => {
    await m("chats.send", {
      worktreeId: workerA.worktreeId,
      chatId: workerA.chatId,
      message: "hold on",
    });
    await waitFor(
      async () =>
        (await dashboard("shop")).agents.find((a) => a.chatId === workerA.chatId)?.status ===
        "running"
          ? true
          : undefined,
      { label: "worker running", timeoutMs: 30_000 },
    );
    const res = await m<{ stopped: boolean }>("projects.stopAgent", {
      project: "shop",
      chatId: workerA.chatId,
    });
    expect(res.stopped).toBe(true);
    await waitFor(
      async () =>
        (await dashboard("shop")).agents.find((a) => a.chatId === workerA.chatId)?.status === "idle"
          ? true
          : undefined,
      { label: "worker idle", timeoutMs: 30_000 },
    );
  });

  it("answers 401 to a call with no token", async () => {
    expect((await trpcQuery(server.url, "projects.dashboard", { project: "x" }, "")).status).toBe(
      401,
    );
    expect(
      (await trpcMutate(server.url, "projects.stopAgent", { project: "x", chatId: "c" }, ""))
        .status,
    ).toBe(401);
  });

  it("refuses to stop a chat of another project", async () => {
    const res = await m<{ stopped: boolean }>("projects.stopAgent", {
      project: "other",
      chatId: workerA.chatId,
    });
    expect(res.stopped).toBe(false);
  });
});
