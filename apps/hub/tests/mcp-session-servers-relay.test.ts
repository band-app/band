// Integration test for MCP servers in `session/new` on a worker (plan step 4.3, S2). A real `band-worker`
// dials a real hub (the production bundle on a random port, auth on). The agent on the worker is the scripted
// ACP stub. Band passes it `mcpServers` whose URL is the worker's relay, and the stub calls a tool through
// exactly that URL and those headers. The relay carries the call to the hub's proxy, which reaches a real MCP
// server (`fixtures/mcp-stub.ts`).

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
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
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type McpStub, startMcpStub } from "./fixtures/mcp-stub";
import { openStream, STUB_AGENT_PATH, TEST_TOKEN, turnEnded } from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");
const API_KEY = "sk-relay-MCP-PLAINTEXT-9876543210";

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

let server: ServerHandle;
let upstream: McpStub;
let workerChild: ChildProcess;
let workerHome: string;
let httpLogFile: string;
let stubLogFile: string;

const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

interface HttpLine {
  name: string;
  status: number;
  body: string;
}
const httpLog = (): HttpLine[] =>
  existsSync(httpLogFile)
    ? readFileSync(httpLogFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as HttpLine)
    : [];

const stubRequestsOf = () =>
  existsSync(stubLogFile)
    ? readFileSync(stubLogFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { method: string; params: Record<string, unknown> })
    : [];

beforeAll(async () => {
  const hubHome = createTmpHome("band-mcp-session-hub-");
  scratch.push(hubHome);
  const hubRepo = join(tmp("band-mcp-session-hubrepo-"), "proj");
  mkdirSync(hubRepo, { recursive: true });
  git(hubRepo, "init", "-q", "-b", "main");
  writeFileSync(join(hubRepo, "hello.txt"), "hello\n");
  git(hubRepo, "add", ".");
  git(hubRepo, "commit", "-q", "-m", "init");
  seedSettings(hubHome, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  seedState(hubHome, {
    repos: [
      {
        name: "proj",
        path: hubRepo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: hubRepo }],
      },
    ],
  });
  upstream = await startMcpStub({ authorize: (h) => h["x-api-key"] === API_KEY, json: true });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: {
      BAND_SERVE_UI: "false",
      BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
      BAND_TEST_ACP_STATE: join(hubHome, "acp-state"),
    },
  });

  const key = await m<{ item: { id: string } }>("vault.put", {
    name: "SESSION_RELAY_MCP_KEY",
    kind: "api_key",
    value: API_KEY,
  });
  const keyed = {
    url: upstream.url,
    vaultItemId: key.item.id,
    headerName: "X-Api-Key",
    headerPrefix: "",
  };
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "mcp-session-worker",
    labels: [],
  });
  await m("mcp.add", { name: "notes", ...keyed, scopeHosts: [issued.hostId] });
  await m("mcp.add", { name: "hub-only", ...keyed, scopeHosts: ["local"] });

  workerHome = tmp("band-mcp-session-home-");
  const root = tmp("band-mcp-session-root-");
  const workerRepo = join(root, "proj");
  mkdirSync(workerRepo, { recursive: true });
  git(workerRepo, "init", "-q", "-b", "main");
  writeFileSync(join(workerRepo, "hello.txt"), "hello from the repo\n");
  git(workerRepo, "add", ".");
  git(workerRepo, "commit", "-q", "-m", "init");
  httpLogFile = join(workerHome, "http-log.jsonl");
  stubLogFile = join(workerHome, "stub-log.jsonl");
  writeFileSync(
    join(workerHome, "scenario.json"),
    JSON.stringify({
      turns: [
        {
          match: "^use-mcp",
          steps: [
            {
              mcpCall: {
                name: "notes-call",
                server: "notes",
                tool: "echo",
                args: { text: "relay" },
              },
            },
            {
              mcpCall: {
                name: "hub-only-call",
                server: "hub-only",
                tool: "echo",
                args: { text: "x" },
              },
            },
            { say: "done" },
          ],
        },
      ],
    }),
  );
  workerChild = spawn(
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
      tmp("band-mcp-session-state-"),
    ],
    {
      env: {
        ...process.env,
        HOME: workerHome,
        BAND_HOME: join(workerHome, ".band"),
        BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        BAND_TEST_ACP_STATE: join(workerHome, "acp-state"),
        BAND_TEST_ACP_LOG: stubLogFile,
        BAND_TEST_ACP_HTTP_LOG: httpLogFile,
        BAND_TEST_ACP_SCENARIO: join(workerHome, "scenario.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  workerChild.stdout?.on("data", () => undefined);
  workerChild.stderr?.on("data", () => undefined);
  await waitFor(
    async () => {
      const { hosts } = await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list");
      return hosts.find((h) => h.id === issued.hostId)?.status === "online" ? true : undefined;
    },
    { label: "worker online", timeoutMs: 20_000 },
  );
  await m("worktrees.create", {
    repo: "proj",
    branch: "mcp",
    hostId: issued.hostId,
    hostRepoPath: workerRepo,
  });

  const chatId = "mcp-session-relay-chat";
  const stream = await openStream(server.url, chatId, { until: turnEnded, timeoutMs: 40_000 });
  const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({
      worktreeId: toWorktreeId("proj", "mcp", issued.hostId),
      text: "use-mcp",
    }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  await stream.events;
}, 180_000);

afterAll(async () => {
  workerChild?.kill("SIGKILL");
  await server?.close();
  await upstream?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("MCP servers in session/new on a worker (S2)", () => {
  it("passes the worker's relay as the URL, with the session token and the relay credential", () => {
    const request = stubRequestsOf().find(
      (r) =>
        r.method === "session/new" &&
        ((r.params.mcpServers as unknown[] | undefined) ?? []).length > 0,
    );
    const entries = (request?.params.mcpServers ?? []) as Array<{
      type: string;
      name: string;
      url: string;
      headers: Array<{ name: string; value: string }>;
    }>;
    // Host scope: `hub-only` is limited to the local host, so the worker's session lacks it.
    // The built-in `band` server comes with every session.
    expect(entries.map((e) => e.name).sort()).toEqual(["band", "notes"]);
    const notes = entries.find((e) => e.name === "notes") as (typeof entries)[number];
    expect(notes.type).toBe("http");
    expect(notes.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp-proxy\/notes$/);
    expect(notes.url.startsWith(server.url)).toBe(false);
    const byName = Object.fromEntries(notes.headers.map((h) => [h.name, h.value]));
    expect(byName.Authorization).toMatch(/^Bearer mcp_/);
    expect(byName["X-Band-Relay-Token"]).toMatch(/^brt_/);
  });

  it("lets the agent call a tool through the relay, and the upstream sees the vault key", () => {
    const line = httpLog().find((l) => l.name === "notes-call");
    expect(line?.status).toBe(200);
    expect(line?.body).toContain("echo:relay");
    expect(upstream.requests.length).toBeGreaterThan(0);
    for (const r of upstream.requests) expect(r.headers["x-api-key"]).toBe(API_KEY);
    expect(httpLog().find((l) => l.name === "hub-only-call")?.status).toBe(-1);
  });
});
