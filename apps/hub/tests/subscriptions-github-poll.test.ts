/**
 * The GitHub polling fallback (plan step S.5): with no public hub URL the
 * hub reads GitHub itself and turns what it finds into the same events the
 * webhook path produces. `GithubPollService.poll` is what the branch-status
 * poller calls on its CI ticks, so this file calls it directly (a real tick
 * is 30 s apart), against a real SQLite database under a temp `BAND_HOME`,
 * the scripted ACP stub agent, and the `gh` Express stub (`BAND_GH_BIN`).
 * Same in-process style as `subscriptions.test.ts`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { toWorkspaceId } from "@band-app/shared/workspace-id";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../src/server/infra/db/connection";
import { initialCursor } from "../src/server/infra/subscriptions/github-poll";
import { agentSessionService } from "../src/server/services/agent-session-service";
import { chatService } from "../src/server/services/chat-service";
import { githubPollService } from "../src/server/services/github-poll-service";
import { githubWebhookService } from "../src/server/services/github-webhook-service";
import { subscriptionService } from "../src/server/services/subscription-service";
import { type CheckRunStub, type GhStub, ghStub } from "./fixtures/gh-stub";
import { TEST_TOKEN, writeStubScenario } from "./helpers/acp-chat";
import { assertTempBandHome } from "./helpers/band-home";
import { seedSettings, seedState } from "./helpers/seed-state";
import { createTmpHome } from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const PROJECT = "testproject";
const WORKSPACE = toWorkspaceId(PROJECT, "main");

const ENV_KEYS = [
  "BAND_HOME",
  "BAND_GH_BIN",
  "BAND_GH_STUB_URL",
  "BAND_PUBLIC_URL",
  "BAND_GITHUB_WEBHOOK_SECRET",
  "BAND_TEST_ACP_LOG",
  "BAND_TEST_ACP_STATE",
  "BAND_TEST_ACP_SCENARIO",
] as const;
const originalEnv: Record<string, string | undefined> = {};

let home: string;
let stubLog: string;
let stub: GhStub;
let seq = 0;

function prompts(): string[] {
  if (!existsSync(stubLog)) return [];
  return readFileSync(stubLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; params: { prompt?: { text?: string }[] } })
    .filter((r) => r.method === "session/prompt")
    .map((r) => r.params.prompt?.[0]?.text ?? "");
}

const promptsAbout = (needle: string) => prompts().filter((p) => p.includes(needle));

/** A repo of its own per test, so stub routes and subscriptions never overlap. */
function newRepo() {
  seq += 1;
  const name = `widgets${seq}`;
  return { coords: { owner: "acme", name }, full: `acme/${name}` };
}

const calls = (needle: string) => stub.requests.filter((r) => r.args.join(" ").includes(needle));

/** A subscription whose repo has no webhook, as when no public URL exists. */
async function subscribe(
  kind: { pr: number } | { branch: string },
  repo: string,
  over: Record<string, unknown> = {},
) {
  const chat = chatService.create(WORKSPACE);
  const input = {
    chatId: chat.id,
    workspaceId: WORKSPACE,
    coalesceSeconds: 0,
    repo,
    ...over,
  };
  const sub =
    "pr" in kind
      ? subscriptionService.createGithubPr({ ...input, number: kind.pr })
      : subscriptionService.createGithubCi({ ...input, branch: kind.branch });
  await githubWebhookService.ensureRegistered(sub);
  // `ensureRegistered` records the webhook status on the stored row.
  return subscriptionService.list().find((s) => s.id === sub.id) ?? sub;
}

const future = (ms: number) => new Date(Date.now() + ms).toISOString();

function prAnswer(comments: { id: string; body: string; createdAt: string }[]) {
  return {
    url: "https://github.com/acme/widgets/pull/7",
    comments: {
      nodes: comments.map((c) => ({
        ...c,
        url: `https://github.com/c/${c.id}`,
        author: { login: "acme" },
      })),
    },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
  };
}

function check(over: Partial<CheckRunStub> & { name: string }): CheckRunStub {
  return { status: "completed", conclusion: "success", head_sha: "abc1234def", ...over };
}

beforeAll(async () => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  home = realpathSync(createTmpHome("band-subscriptions-poll-"));
  process.env.BAND_HOME = join(home, ".band");
  assertTempBandHome();
  delete process.env.BAND_PUBLIC_URL;
  process.env.BAND_GITHUB_WEBHOOK_SECRET = "poll-test-secret";
  const repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@test.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@test.com",
  };
  for (const args of [
    ["init", "-b", "main"],
    ["commit", "--allow-empty", "-m", "initial"],
  ]) {
    execFileSync("git", args, { cwd: repo, env: gitEnv, stdio: "ignore" });
  }
  seedState(home, {
    projects: [
      {
        name: PROJECT,
        path: repo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repo }],
      },
    ],
  });
  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  stub = await ghStub.start();
  Object.assign(process.env, stub.env);
  stubLog = join(home, "acp-stub-log.jsonl");
  process.env.BAND_TEST_ACP_LOG = stubLog;
  process.env.BAND_TEST_ACP_STATE = join(home, "acp-stub-state");
  process.env.BAND_TEST_ACP_SCENARIO = writeStubScenario(home, [{ steps: [{ say: "ok" }] }]);
  subscriptionService.start();
});

afterAll(async () => {
  assertTempBandHome();
  subscriptionService.stop();
  for (const chat of chatService.list(WORKSPACE)) agentSessionService.stop(chat.id);
  await stub.stop();
  closeDb();
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Leftover subscriptions would take slots of the next test's poll.
afterEach(() => {
  for (const sub of subscriptionService.list()) subscriptionService.remove(sub.id);
  stub.requests.splice(0);
});

describe("github polling fallback", () => {
  it("S1: a new review comment is delivered once and not again on the next poll", async () => {
    const { coords, full } = newRepo();
    const old = {
      id: "C_old",
      body: "written before subscribing",
      createdAt: "2020-01-01T00:00:00Z",
    };
    const fresh = { id: "C_new", body: "please rename the helper", createdAt: future(2000) };
    let comments = [old];
    stub.setPrActivityQuery(coords, () => prAnswer(comments));
    const sub = await subscribe({ pr: 7 }, full);
    expect(sub.config.webhook?.status).toBe("waiting-for-url");

    await githubPollService.poll();
    expect(promptsAbout("rename the helper")).toHaveLength(0);
    expect(promptsAbout("written before subscribing")).toHaveLength(0);

    comments = [old, fresh];
    await githubPollService.poll();
    await waitFor(async () => promptsAbout("please rename the helper").length === 1, {
      label: "polled comment delivery",
    });
    expect(subscriptionService.getCursor(sub.id)).toBe(fresh.createdAt);

    await githubPollService.poll();
    await githubPollService.poll();
    // A later comment anchors the check: once it arrives, a repeat would have too.
    comments = [old, fresh, { id: "C_next", body: "and one more thing", createdAt: future(4000) }];
    await githubPollService.poll();
    await waitFor(async () => promptsAbout("and one more thing").length === 1, {
      label: "anchor delivery",
    });
    expect(promptsAbout("please rename the helper")).toHaveLength(1);
  });

  it("S1: a comment older than a second subscription is not delivered to it", async () => {
    const { coords, full } = newRepo();
    const first = await subscribe({ pr: 7 }, full);
    const comment = {
      id: "C_between",
      body: "between the two subscriptions",
      createdAt: initialCursor(first.createdAt + 1000),
    };
    stub.setPrActivityQuery(coords, () => prAnswer([comment]));
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const second = await subscribe({ pr: 7 }, full);
    await githubPollService.poll();
    await waitFor(async () => promptsAbout("between the two subscriptions").length === 1, {
      label: "first subscription delivery",
    });
    expect(subscriptionService.getCursor(first.id)).toBe(comment.createdAt);
    expect(subscriptionService.getCursor(second.id)).toBe(initialCursor(second.createdAt));
    await githubPollService.poll();
    expect(promptsAbout("between the two subscriptions")).toHaveLength(1);
  });

  it("S2: CI is silent while a check is pending and delivers once when the last completes", async () => {
    const { coords, full } = newRepo();
    let runs = [
      check({ name: "build" }),
      check({ name: "test", status: "in_progress", conclusion: null }),
    ];
    stub.setCheckRuns(coords, "fix-ci", () => runs);
    await subscribe({ branch: "fix-ci" }, full);

    await githubPollService.poll();
    await githubPollService.poll();
    expect(calls(`repos/${full}/commits/fix-ci/check-runs`).length).toBeGreaterThan(0);
    expect(promptsAbout("fix-ci")).toHaveLength(0);

    runs = [check({ name: "build" }), check({ name: "test" })];
    await githubPollService.poll();
    await waitFor(async () => promptsAbout("All 2 checks passed").length === 1, {
      label: "ci delivery",
    });
    await githubPollService.poll();
    await githubPollService.poll();
    expect(promptsAbout("All 2 checks passed")).toHaveLength(1);
  });

  it("S3: registers the webhook when a public URL appears, then stops polling", async () => {
    const { coords, full } = newRepo();
    stub.setPrActivityQuery(coords, () => prAnswer([]));
    stub.setHookCreate(coords);
    const sub = await subscribe({ pr: 7 }, full);
    expect(sub.config.webhook?.status).toBe("waiting-for-url");

    process.env.BAND_PUBLIC_URL = "https://hub.example.test";
    try {
      await githubPollService.poll();
    } finally {
      delete process.env.BAND_PUBLIC_URL;
    }
    expect(calls(`repos/${full}/hooks`)).toHaveLength(1);
    expect(subscriptionService.list().find((s) => s.id === sub.id)?.config.webhook?.status).toBe(
      "registered",
    );
    const queries = calls("graphql").filter((r) =>
      r.fields.query?.toString().includes(coords.name),
    );
    expect(queries).toHaveLength(0);
  });

  it("S4: one poll makes a bounded number of gh calls and later polls cover the rest", async () => {
    const { coords, full } = newRepo();
    const branches = Array.from({ length: 6 + 4 }, (_, i) => `branch-${i}`);
    for (const branch of branches) {
      stub.setCheckRuns(coords, branch, [
        check({ name: "build", status: "in_progress", conclusion: null }),
      ]);
      await subscribe({ branch }, full);
    }
    const mine = () => calls(`repos/${full}/commits/`);
    await githubPollService.poll();
    expect(mine()).toHaveLength(6);
    await githubPollService.poll();
    const seen = new Set(mine().map((r) => r.positional[1].split("/commits/")[1].split("/")[0]));
    expect(seen.size).toBe(branches.length);
  });

  it("S4: a failing repo is backed off, not retried on every poll", async () => {
    const { full } = newRepo();
    // No route registered for this repo, so the stub's `gh` exits 1.
    await subscribe({ pr: 3 }, full);
    const queries = () =>
      calls("graphql").filter((r) => r.fields.query?.toString().includes(full.split("/")[1]));
    await githubPollService.poll();
    expect(queries()).toHaveLength(1);
    // One failure skips the next poll, a second one the next four.
    await githubPollService.poll();
    expect(queries()).toHaveLength(1);
    await githubPollService.poll();
    expect(queries()).toHaveLength(2);
    for (let i = 0; i < 3; i++) await githubPollService.poll();
    expect(queries()).toHaveLength(2);
  });
});
