// Integration tests for the project coordinator session (plan step 6.2). A real hub (the production bundle on a
// random port, auth on) with real git repos. The coding agent is the scripted ACP stub: its request log shows
// what Band sent in `session/new` (the charter and the `mcpServers`), and the coordinator's tools are called over
// HTTP with the `mcp_` token the hub gave that session, exactly as the agent would.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type McpStub, startMcpStub } from "./fixtures/mcp-stub";
import { type StubRequest, stubRequests, TEST_TOKEN } from "./helpers/acp-chat";
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

interface ProjectView {
  id: string;
  name: string;
  coordinatorModel: string;
  coordinator: { chatId: string } | null;
  effectivePolicy: {
    autonomy: string;
    autoMerge: boolean;
    models: { coordinator: string; worker: string; reviewer: string };
  };
}

interface ToolAnswer {
  isError: boolean;
  text: string;
  json: () => Record<string, unknown>;
}

let home: string;
let server: ServerHandle;
let upstream: McpStub;

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

const createProject = (name: string, repos: string[], policy: Record<string, unknown> = {}) =>
  m<{ project: ProjectView }>("projects.create", {
    name,
    repos: repos.map((repo) => ({ repo })),
    policy,
  }).then((r) => r.project);

const setPolicy = (project: string, policy: Record<string, unknown>) =>
  m<{ project: ProjectView }>("projects.update", { project, policy });

/** The `session/new` the stub got for a worktree, once it has arrived. */
const sessionNewFor = (worktreeSlug: string): Promise<StubRequest> =>
  waitFor(() => stubRequests(home, "session/new").find((r) => r.cwd.endsWith(worktreeSlug)), {
    label: `session/new for ${worktreeSlug}`,
    timeoutMs: 30_000,
  });

const bearerOf = (request: StubRequest): string => {
  const entries = request.params.mcpServers as Array<{
    headers: Array<{ name: string; value: string }>;
  }>;
  return entries[0].headers.find((h) => h.name === "Authorization")?.value ?? "";
};

/** Calls a tool of the coordinator server with the given Authorization header. */
async function callTool(bearer: string, name: string, args: Record<string, unknown> = {}) {
  const client = new Client({ name: "coordinator-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${server.url}/mcp-proxy/band-coordinator`), {
      requestInit: { headers: { Authorization: bearer } },
    }),
  );
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    const text = res.content.map((c) => c.text).join("");
    return {
      isError: res.isError === true,
      text,
      json: () => JSON.parse(text) as Record<string, unknown>,
    } satisfies ToolAnswer;
  } finally {
    await client.close();
  }
}

async function listTools(bearer: string): Promise<string[]> {
  const client = new Client({ name: "coordinator-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${server.url}/mcp-proxy/band-coordinator`), {
      requestInit: { headers: { Authorization: bearer } },
    }),
  );
  try {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

/** A worktree in `repo` that belongs to `project`, with one chat. */
async function worker(project: string, repo: string, branch: string) {
  await m("worktrees.create", { repo, branch, projectId: project });
  const worktreeId = `${repo}-${branch}`;
  const { chat } = await m<{ chat: { id: string } }>("chats.create", {
    worktreeId,
    name: branch,
  });
  return { worktreeId, chatId: chat.id };
}

const seedSpend = (worktreeId: string, repo: string, costUsd: number) => {
  const db = new DatabaseSync(join(home, ".band", "band.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare(
      `INSERT INTO usage_events (task_id, session_id, worktree_id, repo, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, reasoning_output_tokens, cost_usd, captured_at)
       VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?)`,
    ).run(`t-${worktreeId}`, `s-${worktreeId}`, worktreeId, repo, costUsd, Date.now());
  } finally {
    db.close();
  }
};

let shopCoordinator: StubRequest;
let bearer: string;
let shop: ProjectView;
let other: ProjectView;
let a: { worktreeId: string; chatId: string };
let b: { worktreeId: string; chatId: string };
let c: { worktreeId: string; chatId: string };

beforeAll(async () => {
  home = createTmpHome("band-coordinator-");
  const repos = ["api", "client", "docs"].map((name) => {
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
  // A turn that starts with "hold" runs until it is cancelled, so a chat stays busy on demand.
  const scenario = join(home, "scenario.json");
  writeFileSync(
    scenario,
    JSON.stringify({
      turns: [{ match: "^hold", steps: [{ waitForCancel: true }] }, { steps: [{ say: "ok" }] }],
    }),
  );
  upstream = await startMcpStub({ authorize: () => true, json: true });
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

  shop = await createProject("shop", ["api", "client"], { maxConcurrent: 5 });
  other = await createProject("other", ["docs"]);
  shopCoordinator = await sessionNewFor("/projects/shop");
  bearer = bearerOf(shopCoordinator);
  a = await worker("shop", "api", "feat-a");
  b = await worker("shop", "client", "feat-b");
  c = await worker("other", "docs", "feat-c");
}, 180_000);

afterAll(async () => {
  await server?.close();
  await upstream?.close();
  if (home) removeTmpHome(home);
});

describe("the coordinator session starts with the project (S1)", () => {
  it("creates a coordinator chat on the project's first repo, on opus by default", async () => {
    expect(shop.coordinator?.chatId).toBeTruthy();
    const { chats } = await q<{
      chats: Array<{ id: string; model: string; labels: object; worktreeId: string | null }>;
    }>("chats.list", { worktreeId: `project:${shop.id}` });
    expect(chats).toHaveLength(1);
    expect(chats[0].labels).toEqual({ "band:coordinator": shop.id });
    expect(chats[0]).toMatchObject({
      id: shop.coordinator?.chatId,
      model: "opus",
      worktreeId: null,
    });
    expect(shop.coordinatorModel).toBe("opus");
  });

  it("has AGENTS.md in the project folder with CLAUDE.md importing it, and sends no charter system prompt", async () => {
    const folder = join(realpathSync(home), ".band", "projects", "shop");
    const agents = await waitFor(
      () =>
        existsSync(join(folder, "AGENTS.md"))
          ? readFileSync(join(folder, "AGENTS.md"), "utf8")
          : undefined,
      { label: "AGENTS.md" },
    );
    expect(readFileSync(join(folder, "CLAUDE.md"), "utf8").trim()).toBe("@AGENTS.md");
    const meta = shopCoordinator.params._meta as { systemPrompt?: { append?: string } } | undefined;
    expect(meta?.systemPrompt?.append ?? "").not.toContain("coordinator of the Band project");
    expect(agents).toContain('Coordinator of the Band project "shop"');
    expect(agents).toContain("`api`");
    expect(agents).toContain("`client`");
    expect(agents).toContain("at most 5 worker agents run at once");
    expect(agents).toContain("Autonomy is autonomous");
    expect(agents).toContain("project_status");
    expect(agents).toContain("inbox/<agent>.md");
  });

  it("gives the session only the coordinator tool set", async () => {
    const servers = shopCoordinator.params.mcpServers as Array<{ name: string; url: string }>;
    expect(servers.map((s) => s.name)).toEqual(["band-coordinator"]);
    expect(servers[0].url).toBe(`${server.url}/mcp-proxy/band-coordinator`);
    expect(bearer).toMatch(/^Bearer mcp_/);
    expect(await listTools(bearer)).toEqual([
      "chats_read",
      "chats_send",
      "project_status",
      "repo_log",
      "repo_read",
      "repo_search",
      "worktree_create",
      "worktree_stop",
      "worktrees_list",
    ]);
  });

  it("defaults the model lanes to opus, sonnet and sonnet and autonomy to autonomous", () => {
    expect(shop.effectivePolicy.models).toEqual({
      coordinator: "opus",
      worker: "sonnet",
      reviewer: "sonnet",
    });
    expect(shop.effectivePolicy).toMatchObject({ autonomy: "autonomous", autoMerge: false });
  });

  it("keeps the coordinator's worktree out of the project's worker list", async () => {
    const { project } = await q<{ project: { worktrees: Array<{ worktreeId: string }> } }>(
      "projects.get",
      { project: "shop" },
    );
    expect(project.worktrees.map((w) => w.worktreeId).sort()).toEqual([a.worktreeId, b.worktreeId]);
  });
});

describe("the tools are scoped to the project (S2)", () => {
  it("lists only the project's own worktrees and chats", async () => {
    const res = await callTool(bearer, "worktrees_list");
    expect(res.isError).toBe(false);
    const ids = (res.json().worktrees as Array<{ worktreeId: string }>).map((w) => w.worktreeId);
    expect(ids.sort()).toEqual([a.worktreeId, b.worktreeId]);
    expect(res.text).not.toContain(c.chatId);
    expect(res.text).not.toContain("coordinator-shop");
  });

  it("refuses to read or message a chat of another project's worktree", async () => {
    const read = await callTool(bearer, "chats_read", { chatId: c.chatId });
    expect(read.isError).toBe(true);
    expect(read.text).toContain('not a chat of a worktree in project "shop"');
    const send = await callTool(bearer, "chats_send", { chatId: c.chatId, message: "hello" });
    expect(send.isError).toBe(true);
    expect(send.text).toContain('not a chat of a worktree in project "shop"');
    const stop = await callTool(bearer, "worktree_stop", { worktreeId: c.worktreeId });
    expect(stop.isError).toBe(true);
    expect(stop.text).toContain('not in project "shop"');
  });

  it("refuses its own chat and the other project's coordinator chat", async () => {
    const own = await callTool(bearer, "chats_read", { chatId: shop.coordinator?.chatId });
    expect(own.isError).toBe(true);
    const theirs = await callTool(bearer, "chats_read", { chatId: other.coordinator?.chatId });
    expect(theirs.isError).toBe(true);
  });

  it("answers for the project the token was issued for, whatever the caller names", async () => {
    const otherSession = await sessionNewFor("/projects/other");
    const res = await callTool(bearerOf(otherSession), "worktrees_list");
    const ids = (res.json().worktrees as Array<{ worktreeId: string }>).map((w) => w.worktreeId);
    expect(ids).toEqual([c.worktreeId]);
  });

  it("gives a worker chat no coordinator tools, and its token cannot reach them", async () => {
    await m("mcp.add", { name: "notes", url: upstream.url, scopeRepos: ["docs"] });
    // A chat that starts a session after the server was added gets a token for it.
    const { chat } = await m<{ chat: { id: string } }>("chats.create", {
      worktreeId: c.worktreeId,
      name: "second",
    });
    const res = await fetch(`${server.url}/api/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
      body: JSON.stringify({ worktreeId: c.worktreeId, text: "hello" }),
    });
    expect(res.ok).toBe(true);
    const workerSession = await waitFor(
      () =>
        stubRequests(home, "session/new").find(
          (r) => r.cwd.endsWith("feat-c") && (r.params.mcpServers as unknown[]).length > 0,
        ),
      { label: "worker session with a token", timeoutMs: 30_000 },
    );
    const names = (workerSession.params.mcpServers as Array<{ name: string }>).map((s) => s.name);
    expect(names).toEqual(["notes"]);
    // A worker may carry the context preamble in `_meta`, but never a coordinator charter.
    expect(JSON.stringify(workerSession.params._meta ?? {})).not.toContain(
      "coordinator of the Band project",
    );

    const workerBearer = bearerOf(workerSession);
    const denied = await fetch(`${server.url}/mcp-proxy/band-coordinator`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        Authorization: workerBearer,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(denied.status).toBe(403);
    const anonymous = await fetch(`${server.url}/mcp-proxy/band-coordinator`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(anonymous.status).toBe(401);
  });

  it("does not let an MCP server take the coordinator's name", async () => {
    const res = await trpcMutate(
      server.url,
      "mcp.add",
      { name: "band-coordinator", url: upstream.url },
      TEST_TOKEN,
    );
    expect(res.status).toBe(400);
  });
});

describe("policy limits and autonomy (S3)", () => {
  const status = async () =>
    (await callTool(bearer, "project_status")).json() as unknown as {
      running: number;
      policy: { autonomy: string; maxConcurrent: number | null };
      spend: { usd: number; budgetUsd: number | null };
    };

  it("refuses a dispatch past maxConcurrent with a clear error, then allows it after a stop", async () => {
    await setPolicy("shop", { maxConcurrent: 1, autonomy: "autonomous" });
    const first = await callTool(bearer, "chats_send", { chatId: a.chatId, message: "hold a" });
    expect(first.isError).toBe(false);
    await waitFor(async () => ((await status()).running === 1 ? true : undefined), {
      label: "one worker running",
      timeoutMs: 30_000,
    });

    const refused = await callTool(bearer, "chats_send", { chatId: b.chatId, message: "go" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("1 worker agents are already running");
    expect(refused.text).toContain("allows 1 at once");

    // A message to the busy chat only queues, so it takes no new slot.
    const queued = await callTool(bearer, "chats_send", { chatId: a.chatId, message: "later" });
    expect(queued.isError).toBe(false);
    expect(queued.json()).toMatchObject({ queued: true });

    const stopped = await callTool(bearer, "worktree_stop", { worktreeId: a.worktreeId });
    expect(stopped.isError).toBe(false);
    expect(stopped.json().stoppedChats).toEqual([a.chatId]);
    await waitFor(async () => ((await status()).running === 0 ? true : undefined), {
      label: "no worker running",
      timeoutMs: 30_000,
    });
  });

  it("refuses new work once the project has spent its budget", async () => {
    await setPolicy("shop", { maxConcurrent: 5, budgetUsd: 1 });
    seedSpend(a.worktreeId, "api", 5);
    const refused = await callTool(bearer, "chats_send", { chatId: b.chatId, message: "go" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("has spent $5.00 of its $1 budget");
    const s = await status();
    expect(s.spend).toMatchObject({ usd: 5, budgetUsd: 1 });
    // The budget is soft: reading and stopping still work.
    expect((await callTool(bearer, "worktrees_list")).isError).toBe(false);
  });

  it("refuses every mutating tool in observe mode and keeps the read tools", async () => {
    await setPolicy("shop", { autonomy: "observe", budgetUsd: 1000 });
    const send = await callTool(bearer, "chats_send", { chatId: b.chatId, message: "go" });
    expect(send.isError).toBe(true);
    expect(send.text).toContain("observe mode");
    const stop = await callTool(bearer, "worktree_stop", { worktreeId: a.worktreeId });
    expect(stop.isError).toBe(true);
    expect(stop.text).toContain("observe mode");

    const s = await status();
    expect(s.policy.autonomy).toBe("observe");
    const read = await callTool(bearer, "chats_read", { chatId: a.chatId });
    expect(read.isError).toBe(false);
  });

  it("rejects a policy with an unknown key or autonomy level", async () => {
    for (const policy of [{ autonomy: "reckless" }, { nope: 1 }]) {
      const res = await trpcMutate(
        server.url,
        "projects.update",
        { project: "shop", policy },
        TEST_TOKEN,
      );
      expect(res.status).toBe(400);
    }
  });

  it("lets the coordinator lane set the coordinator model", async () => {
    const { project } = await setPolicy("shop", { models: { coordinator: "sonnet" } });
    expect(project.coordinatorModel).toBe("sonnet");
    const { chats } = await q<{ chats: Array<{ model: string }> }>("chats.list", {
      worktreeId: `project:${shop.id}`,
    });
    expect(chats[0].model).toBe("sonnet");
  });
});

describe("removing a project", () => {
  it("removes its coordinator chat with it", async () => {
    await m("projects.detachWorktree", { worktreeId: c.worktreeId });
    await m("worktrees.remove", { repo: "docs", name: "feat-c" });
    await m("projects.remove", { project: "other" });
    const { chat } = await q<{ chat: unknown }>("chats.get", {
      chatId: other.coordinator?.chatId,
    });
    expect(chat).toBeNull();
  });
});
