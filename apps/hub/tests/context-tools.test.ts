// Integration tests for the context MCP tools and post-session capture (plan step 5.4). A real hub
// (the production bundle on a random port, auth on) serves the tools on /mcp, and the SDK's MCP client
// calls them with the chat and worktree headers an agent carries. Context repos are read and written with
// the real `git` binary through the hub's git endpoint. The coding agent is the scripted ACP stub.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openStream, STUB_AGENT_PATH, TEST_TOKEN, turnEnded } from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
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

let home: string;
let server: ServerHandle;
const scratch: string[] = [];

const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv, stdio: "pipe" });
}

const auth = (token: string) => ["-c", `http.extraHeader=Authorization: Bearer ${token}`];
const gitUrl = (name: string) => `${server.url}/git/context/${name}.git`;

const m = async <T>(proc: string, input: unknown) => {
  const res = await trpcMutate(server.url, proc, input, TEST_TOKEN);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};

/** Clones a context with the admin token. */
function clone(name: string): string {
  const dir = tmp(`band-ctx-${name}-`);
  git(dir, ...auth(TEST_TOKEN), "clone", "-q", gitUrl(name), "wc");
  return join(dir, "wc");
}

/** Commits files into a context through a clone and pushes them. */
function seedFiles(name: string, files: Record<string, string>): void {
  const wc = clone(name);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(wc, path, ".."), { recursive: true });
    writeFileSync(join(wc, path), body);
  }
  git(wc, "add", "-A");
  git(wc, "commit", "-q", "-m", "seed");
  git(wc, ...auth(TEST_TOKEN), "push", "-q", "origin", "HEAD");
}

const read = (wc: string, path: string) => {
  git(wc, ...auth(TEST_TOKEN), "pull", "-q", "--ff-only", "origin");
  return existsSync(join(wc, path)) ? readFileSync(join(wc, path), "utf8") : "";
};

interface ToolReply {
  isError?: boolean;
  text: string;
  json: unknown;
}

/** Calls a context tool the way an agent in `chatId` does. */
async function tool(
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<ToolReply> {
  const client = new Client({ name: "context-tools-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TEST_TOKEN}`, ...headers } },
    }),
  );
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    const text = res.content.map((c) => c.text).join("");
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // An error reply is plain text.
    }
    return { isError: res.isError, text, json };
  } finally {
    await client.close();
  }
}

const agentHeaders = (chatId: string, worktreeId: string) => ({
  "x-band-chat-id": chatId,
  "x-band-worktree-id": worktreeId,
});

/** Posts a prompt to a chat (creating it) and waits for the turn to end. */
async function runTurn(chatId: string, worktreeId: string, text: string): Promise<void> {
  const stream = await openStream(server.url, chatId, {
    until: (e) => turnEnded(e) && e.eventId !== 0,
    timeoutMs: 30_000,
  });
  const res = await fetch(`${server.url}/api/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId, text }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  await stream.events;
}

type SearchJson = {
  results: Array<{
    context: string;
    contextName: string;
    hit: { path: string; nameMatch: boolean };
  }>;
  searched: string[];
};

const today = () => new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  home = createTmpHome("band-context-tools-");
  const alphaRepo = join(home, "repo-alpha");
  const betaRepo = join(home, "repo-beta");
  const bareRepo = join(home, "repo-bare");
  for (const dir of [alphaRepo, betaRepo, bareRepo]) mkdirSync(dir, { recursive: true });
  seedState(home, {
    repos: [alphaRepo, betaRepo, bareRepo].map((path) => ({
      name: path.split("-").pop() as string,
      path,
      defaultBranch: "main",
      worktrees: [{ branch: "main", path }],
    })),
  });
  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  const scenario = join(home, "scenario.json");
  writeFileSync(
    scenario,
    JSON.stringify({
      turns: [{ steps: [{ say: "Closing reply: the zebra protocol is documented." }] }],
    }),
  );
  server = await startServer({
    remoteHost: false,
    tmpHome: home,
    env: {
      BAND_SERVE_UI: "false",
      BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
      BAND_TEST_ACP_STATE: join(home, "acp-stub-state"),
      BAND_TEST_ACP_LOG: join(home, "acp-stub-log.jsonl"),
      BAND_TEST_ACP_SCENARIO: scenario,
    },
  });

  await m("context.create", { name: "user" });
  await m("context.create", { name: "proj-alpha", repos: ["alpha"] });
  await m("context.create", { name: "proj-beta", repos: ["beta"] });
  seedFiles("user", {
    "preferences.md": "# Preferences\n\nAlways answer with tabs, never spaces.\n",
  });
  seedFiles("proj-alpha", {
    "notes.md": "# Notes\n\nAlpha deploys with the frobnicate script.\n",
    "docs/deploy-runbook.md": "frobnicate frobnicate frobnicate\nfrobnicate again\n",
    "docs/frobnicate.md": "A short file named after the topic.\n",
  });
  seedFiles("proj-beta", { "notes.md": "# Notes\n\nBeta launches with the quokka incantation.\n" });
}, 120_000);

afterAll(async () => {
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  if (home) removeTmpHome(home);
});

const alphaChat = agentHeaders("chat-alpha", "alpha-main");
const betaChat = agentHeaders("chat-beta", "beta-main");

describe("context_search", () => {
  beforeAll(async () => {
    await runTurn("chat-alpha", "alpha-main", "hello from alpha");
    await runTurn("chat-beta", "beta-main", "hello from beta");
  }, 60_000);

  it("finds a phrase in the project notes and in the user preferences (S1)", async () => {
    const project = await tool("context_search", { query: "frobnicate script" }, alphaChat);
    const hits = (project.json as SearchJson).results;
    expect(hits.some((r) => r.context === "project" && r.hit.path === "notes.md")).toBe(true);

    const user = await tool("context_search", { query: "tabs never spaces" }, alphaChat);
    const userHits = (user.json as SearchJson).results;
    expect(userHits).toEqual([
      expect.objectContaining({
        context: "user",
        contextName: "user",
        hit: expect.objectContaining({ path: "preferences.md" }),
      }),
    ]);
  });

  it("ranks a file name match first, then files with more matching lines (S1)", async () => {
    const res = await tool("context_search", { query: "frobnicate" }, alphaChat);
    const paths = (res.json as SearchJson).results.map((r) => r.hit.path);
    expect(paths.slice(0, 3)).toEqual(["docs/frobnicate.md", "docs/deploy-runbook.md", "notes.md"]);
  });

  it("never returns another project's files (S1)", async () => {
    const fromAlpha = await tool("context_search", { query: "quokka" }, alphaChat);
    expect((fromAlpha.json as SearchJson).results).toEqual([]);
    expect((fromAlpha.json as SearchJson).searched.sort()).toEqual(["proj-alpha", "user"]);

    const fromBeta = await tool("context_search", { query: "frobnicate" }, betaChat);
    expect((fromBeta.json as SearchJson).results).toEqual([]);
    const own = await tool("context_search", { query: "quokka" }, betaChat);
    expect((own.json as SearchJson).results.map((r) => r.contextName)).toEqual(["proj-beta"]);
  });

  it("limits a user scope to the user context and refuses a call with no session", async () => {
    const userOnly = await tool(
      "context_search",
      { query: "frobnicate", scope: "user" },
      alphaChat,
    );
    expect((userOnly.json as SearchJson).results).toEqual([]);

    const anonymous = await tool("context_search", { query: "frobnicate" }, {});
    expect(anonymous.isError).toBe(true);
    expect(anonymous.text).toContain("chat or worktree headers");

    const mismatch = await tool(
      "context_search",
      { query: "frobnicate" },
      agentHeaders("chat-alpha", "beta-main"),
    );
    expect(mismatch.isError).toBe(true);
  });

  it("searches the user context only for a repo with no project context", async () => {
    await runTurn("chat-bare", "bare-main", "hello from bare");
    const res = await tool(
      "context_search",
      { query: "tabs" },
      agentHeaders("chat-bare", "bare-main"),
    );
    expect((res.json as SearchJson).searched).toEqual(["user"]);
    const write = await tool(
      "context_append_learning",
      { text: "x" },
      agentHeaders("chat-bare", "bare-main"),
    );
    expect(write.isError).toBe(true);
    expect(write.text).toContain("No project context");
  });
});

describe("context_append_learning and context_handoff", () => {
  it("create files with frontmatter that another worker sees on its next pull (S2)", async () => {
    // A worker holds a clone from before the writes.
    const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
      hostName: "worker-b",
      labels: [],
    });
    const exchange = await fetch(`${server.url}/api/workers/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: issued.token, workerId: issued.hostId }),
    });
    const workerToken = ((await exchange.json()) as { sessionToken: string }).sessionToken;
    const workerDir = tmp("band-ctx-worker-");
    git(workerDir, ...auth(workerToken), "clone", "-q", gitUrl("proj-alpha"), "wc");
    const wc = join(workerDir, "wc");

    const learned = await tool(
      "context_append_learning",
      { text: "Run the suite with pnpm test, not npm test.", tags: ["testing", "pnpm"] },
      alphaChat,
    );
    expect(learned.isError).toBeFalsy();
    const learnPath = `learnings/${today()}-claude-code.md`;
    expect(learned.json).toMatchObject({ context: "proj-alpha", path: learnPath });
    await tool("context_append_learning", { text: "Second note, same file." }, alphaChat);

    const handed = await tool(
      "context_handoff",
      {
        to: "reviewer",
        summary: "Finished the parser.\nTests are in parser.test.ts.",
        links: ["https://example.com/pr/1"],
      },
      alphaChat,
    );
    expect(handed.isError, handed.text).toBeFalsy();
    const { path: handoffPath } = handed.json as { path: string };
    expect(handoffPath).toMatch(/^handoffs\/\d{8}-\d{6}-claude-code-to-reviewer-[0-9a-f]{4}\.md$/);

    git(wc, ...auth(workerToken), "pull", "-q", "--ff-only", "origin");
    const learnings = readFileSync(join(wc, learnPath), "utf8");
    expect(learnings.startsWith("---\ntype: learnings\nagent: claude-code\n")).toBe(true);
    expect(learnings).toContain("Run the suite with pnpm test, not npm test.");
    expect(learnings).toContain("tags: testing, pnpm");
    expect(learnings).toContain("source: agent");
    expect(learnings).toContain("Second note, same file.");
    expect(learnings.match(/^# Learnings/gm)).toHaveLength(1);

    const handoff = readFileSync(join(wc, handoffPath), "utf8");
    expect(handoff).toContain("type: handoff\nfrom: claude-code\nto: reviewer\n");
    expect(handoff).toContain('links: ["https://example.com/pr/1"]');
    expect(handoff).toContain("Tests are in parser.test.ts.");

    const inbox = readFileSync(join(wc, "inbox/reviewer.md"), "utf8");
    expect(inbox).toContain("type: inbox");
    expect(inbox).toContain(`Finished the parser. (${handoffPath})`);

    // The other project got nothing.
    const beta = clone("proj-beta");
    expect(existsSync(join(beta, learnPath))).toBe(false);
    expect(existsSync(join(beta, "inbox/reviewer.md"))).toBe(false);
  });

  it("keeps secrets out of what it writes", async () => {
    const secret = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    await tool(
      "context_append_learning",
      { text: `Deploy key is ${secret} and password=hunter2hunter2 for staging.` },
      alphaChat,
    );
    const wc = clone("proj-alpha");
    const file = read(wc, `learnings/${today()}-claude-code.md`);
    expect(file).not.toContain(secret);
    expect(file).not.toContain("hunter2hunter2");
    expect(file).toContain("[redacted]");
  });

  it("refuses a tag or target that looks like a secret", async () => {
    const secret = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const badTag = await tool("context_append_learning", { text: "x", tags: [secret] }, alphaChat);
    expect(badTag.isError).toBe(true);
    const badTo = await tool(
      "context_handoff",
      { to: secret.toLowerCase(), summary: "x" },
      alphaChat,
    );
    expect(badTo.isError).toBe(true);
  });

  it("refuses a call with no token or a wrong one", async () => {
    for (const headers of [{}, { Authorization: "Bearer wrong-token" }]) {
      const res = await fetch(`${server.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
    }
  });

  it("refuses a bad target and bad tags", async () => {
    const badTo = await tool("context_handoff", { to: "../etc", summary: "x" }, alphaChat);
    expect(badTo.isError).toBe(true);
    const badTag = await tool(
      "context_append_learning",
      { text: "x", tags: ["has space"] },
      alphaChat,
    );
    expect(badTag.isError).toBe(true);
  });
});

describe("post-session capture", () => {
  it("appends nothing when the setting is off, and an auto-captured learning when on (S3)", async () => {
    await runTurn("chat-off", "alpha-main", "investigate the grommet issue");
    await m("chats.remove", { chatId: "chat-off" });

    await m("settings.update", { context: { captureLearnings: true } });
    await runTurn(
      "chat-on",
      "alpha-main",
      "document the zebra protocol, key sk-abcdefghijklmnopqrstuvwxyz123456",
    );
    await m("chats.remove", { chatId: "chat-on" });
    const file = await waitFor(
      async () => {
        const wc = clone("proj-alpha");
        const text = read(wc, `learnings/${today()}-claude-code.md`);
        return text.includes("chat: chat-on") ? text : undefined;
      },
      { label: "auto-captured learning", timeoutMs: 20_000, intervalMs: 500 },
    );
    // chat-off was removed first and shares the file with chat-on, so its absence is checked
    // after chat-on's write landed.
    expect(file).not.toContain("chat: chat-off");
    expect(file).toContain("source: auto-captured");
    expect(file).toContain("tags: auto-captured");
    expect(file).toContain("document the zebra protocol");
    expect(file).toContain("the zebra protocol is documented");
    expect(file).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  }, 90_000);
});
