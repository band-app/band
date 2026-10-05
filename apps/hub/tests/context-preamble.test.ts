// Integration tests for the session preamble (plan step 5.3). A real hub (the production
// bundle, temp BAND_HOME), real git context repos, and the scripted ACP stub as every agent.
// The stub logs what Band sent it (`session/new` params with `_meta`, and the process env),
// which is how each adapter's mechanism is asserted. S3 adds a real `band-worker`.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  openStream,
  STUB_AGENT_PATH,
  type StubRequest,
  seedAcpHome,
  stubRequests,
  TEST_TOKEN,
  turnEnded,
} from "./helpers/acp-chat";
import { seedSettings } from "./helpers/seed-state";
import { type ServerHandle, startServer, trpcData, trpcMutate, trpcQuery } from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

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
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

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
const write = (name: string, path: string, content: string) =>
  m("context.write", { name, path, content, message: `set ${path}` });

let chats = 0;
/** Creates a chat for `agent` and sends one message, waiting for the turn to end. */
async function turn(url: string, worktreeId: string, agent: string, text = "hello") {
  const chatId = `pre-chat-${++chats}`;
  const res0 = await trpcMutate(url, "chats.create", { worktreeId, id: chatId, agent }, TEST_TOKEN);
  expect(res0.status).toBe(200);
  const stream = await openStream(url, chatId, { until: turnEnded, timeoutMs: 40_000 });
  const res = await fetch(`${url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId, text }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  await stream.events;
  return chatId;
}

/** The newest `session/new` the stub got for a chat. */
const newSession = (stubHome: string, chatId: string): StubRequest => {
  const found = stubRequests(stubHome, "session/new").filter((r) => r.env.BAND_CHAT_ID === chatId);
  expect(found.length, `session/new for ${chatId}`).toBeGreaterThan(0);
  return found[found.length - 1];
};
const appended = (req: StubRequest): string =>
  (req.params._meta as { systemPrompt?: { append?: string } } | undefined)?.systemPrompt?.append ??
  "";

const bigPreferences = [
  "# Preferences",
  ...Array.from({ length: 400 }, (_, i) => `rule ${i}`),
].join("\n");

beforeAll(async () => {
  home = seedAcpHome("band-preamble-");
  scratch.push(home);
  // A worktree on a worker needs a git repo on the hub.
  const hubRepo = join(home, "repo");
  git(hubRepo, "init", "-q", "-b", "main");
  writeFileSync(join(hubRepo, "hello.txt"), "hello\n");
  git(hubRepo, "add", ".");
  git(hubRepo, "commit", "-q", "-m", "init");
  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [
      { id: "claude-code", type: "claude-code", label: "Claude Code" },
      { id: "codex", type: "codex", label: "Codex" },
      { id: "gemini", type: "gemini-cli", label: "Gemini" },
    ],
    defaultCodingAgent: "claude-code",
  });
  server = await startServer({
    tmpHome: home,
    remoteHost: false,
    env: {
      BAND_SERVE_UI: "false",
      BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
      BAND_TEST_ACP_STATE: join(home, "acp-stub-state"),
      BAND_TEST_ACP_LOG: join(home, "acp-stub-log.jsonl"),
    },
  });
  await m("context.create", { name: "user" });
  await m("context.create", { name: "acme", kind: "mission", repos: ["testrepo"] });
  await write("user", "preferences.md", "# Preferences\nAlways use pnpm.\n");
  await write("acme", "notes.md", "# Notes\nThe release train leaves on Fridays.\n");
  await write(
    "acme",
    "docs/deploy.md",
    "---\ndescription: How to deploy to staging\n---\n# Deploying\nsteps\n",
  );
  await write("acme", "docs/api.md", "# The API guide\ntext\n");
}, 120_000);

afterAll(async () => {
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("session preamble", () => {
  it("S1: the agent gets preferences, notes and an index in session/new", async () => {
    const chatId = await turn(server.url, "testrepo-main", "claude-code");
    const text = appended(newSession(home, chatId));
    expect(text).toContain("Always use pnpm.");
    expect(text).toContain("The release train leaves on Fridays.");
    expect(text).toContain("acme/docs/deploy.md: How to deploy to staging");
    expect(text).toContain("acme/docs/api.md: The API guide");
    // The inlined files are not repeated in the index.
    expect(text).not.toContain("acme/notes.md");
    expect(text.split("\n").length).toBeLessThanOrEqual(200);
  });

  it("S1: an over-budget file is cut with a pointer to the full file", async () => {
    await write("user", "preferences.md", bigPreferences);
    try {
      const chatId = await turn(server.url, "testrepo-main", "claude-code");
      const text = appended(newSession(home, chatId));
      expect(text.split("\n").length).toBeLessThanOrEqual(200);
      expect(text).toContain("rule 0");
      expect(text).not.toContain("rule 399");
      expect(text).toMatch(
        /\[Cut: \d+ more lines\. Read the full file at .*context\/user\/preferences\.md\]/,
      );
      // The notes still fit beside the long file.
      expect(text).toContain("The release train leaves on Fridays.");
    } finally {
      await write("user", "preferences.md", "# Preferences\nAlways use pnpm.\n");
    }
  });

  it("S2: Claude gets _meta.systemPrompt.append and autoMemoryDirectory in the session settings", async () => {
    const chatId = await turn(server.url, "testrepo-main", "claude-code");
    const req = newSession(home, chatId);
    const meta = req.params._meta as {
      systemPrompt: { append: string };
      claudeCode: { options: { settings: { autoMemoryDirectory: string } } };
    };
    expect(meta.systemPrompt.append).toContain("Always use pnpm.");
    expect(meta.claudeCode.options.settings.autoMemoryDirectory).toBe(
      join(home, ".band", "context", "projects", "acme", "memory"),
    );
  });

  it("S2: Codex gets developer_instructions through CODEX_CONFIG", async () => {
    const chatId = await turn(server.url, "testrepo-main", "codex");
    const req = newSession(home, chatId);
    const config = JSON.parse(req.env.CODEX_CONFIG ?? "{}") as { developer_instructions?: string };
    expect(config.developer_instructions).toContain("Always use pnpm.");
    expect(config.developer_instructions).toContain("The release train leaves on Fridays.");
    // Codex takes the text from its environment, so session/new carries no _meta.
    expect(req.params._meta).toBeUndefined();
  });

  it("S2: an agent with no known mechanism gets nothing", async () => {
    const chatId = await turn(server.url, "testrepo-main", "gemini");
    const req = newSession(home, chatId);
    expect(req.params._meta).toBeUndefined();
    expect(req.env.CODEX_CONFIG).toBeUndefined();
  });

  it("S4: with the preamble off for the project, nothing is injected", async () => {
    await m("context.update", { name: "acme", preamble: false });
    try {
      for (const agent of ["claude-code", "codex"]) {
        const chatId = await turn(server.url, "testrepo-main", agent);
        const req = newSession(home, chatId);
        expect(req.params._meta, agent).toBeUndefined();
        expect(req.env.CODEX_CONFIG, agent).toBeUndefined();
      }
      const { contexts } = await q<{ contexts: Array<{ name: string; preamble: boolean }> }>(
        "context.list",
      );
      expect(contexts.find((c) => c.name === "acme")?.preamble).toBe(false);
    } finally {
      await m("context.update", { name: "acme", preamble: true });
    }
  });
});

describe("auto memory on a worker", () => {
  let worker: ChildProcess | undefined;
  afterAll(() => worker?.kill("SIGKILL"));

  it("S3: autoMemoryDirectory is inside the synced project context, and a memory file reaches the hub", async () => {
    const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
      hostName: "mem",
      labels: [],
    });
    const wHome = tmp("band-preamble-whome-");
    const root = tmp("band-preamble-wroot-");
    const repo = join(root, "testrepo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "hello.txt"), "hello\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    const bandHome = join(wHome, ".band");
    const memoryDir = join(bandHome, "context", "projects", "acme", "memory");
    writeFileSync(
      join(wHome, "scenario.json"),
      JSON.stringify({
        turns: [
          {
            steps: [
              {
                writeFile: { path: join(memoryDir, "MEMORY.md"), content: "- prefers small PRs\n" },
              },
              { say: "ok" },
            ],
          },
        ],
      }),
    );
    worker = spawn(
      process.execPath,
      [
        WORKER_BIN,
        "--hub",
        server.url,
        "--token",
        issued.token,
        "--root",
        root,
        "--state-dir",
        tmp("band-preamble-state-"),
      ],
      {
        env: {
          ...process.env,
          HOME: wHome,
          BAND_HOME: bandHome,
          BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
          BAND_TEST_ACP_STATE: join(wHome, "acp-state"),
          BAND_TEST_ACP_SCENARIO: join(wHome, "scenario.json"),
          BAND_TEST_ACP_LOG: join(wHome, "acp-stub-log.jsonl"),
        },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    await waitFor(
      async () => {
        const { hosts } = await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list");
        return hosts.find((h) => h.id === issued.hostId)?.status === "online" ? true : undefined;
      },
      { label: "worker online", timeoutMs: 20_000 },
    );
    await m("worktrees.create", {
      repo: "testrepo",
      branch: "mem",
      hostId: issued.hostId,
      hostRepoPath: repo,
    });

    const chatId = await turn(server.url, "testrepo-mem", "claude-code");
    const logged = stubRequests(wHome, "session/new").filter((r) => r.env.BAND_CHAT_ID === chatId);
    const req = logged[0];
    expect(req, "session/new on the worker").toBeDefined();
    const meta = req.params._meta as {
      claudeCode: { options: { settings: { autoMemoryDirectory: string } } };
    };
    expect(meta.claudeCode.options.settings.autoMemoryDirectory).toBe(memoryDir);

    const bare = join(home, ".band", "context", "acme.git");
    await waitFor(
      async () => {
        const files = git(bare, "ls-tree", "-r", "--name-only", "main").split("\n");
        return files.includes("memory/MEMORY.md") ? true : undefined;
      },
      { label: "memory file on the hub", timeoutMs: 30_000 },
    );
    expect(git(bare, "show", "main:memory/MEMORY.md")).toBe("- prefers small PRs\n");
  }, 120_000);
});
