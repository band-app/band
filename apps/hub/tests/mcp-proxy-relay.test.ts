// Integration test for the MCP proxy through a worker's relay (plan step 4.2, S5). A real `band-worker`
// dials a real hub (the production bundle on a random port with auth on). The agent on the worker is the
// scripted ACP stub, which calls `<relay>/mcp-proxy/<server>` with its `mcp_` token the way an MCP client
// configured with that URL and header would. The relay carries the call up the worker's link, and the hub's
// proxy checks the token, adds the vault credential and talks to a real MCP server (`fixtures/mcp-stub.ts`).

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
let proxyToken: string;
let narrowToken: string;

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
const logged = (name: string) => httpLog().find((l) => l.name === name);

const rpcBody = (body: object) => ({
  jsonrpc: "2.0",
  id: 1,
  ...body,
});

beforeAll(async () => {
  const hubHome = createTmpHome("band-mcp-relay-hub-");
  scratch.push(hubHome);
  const hubRepo = join(tmp("band-mcp-relay-hubrepo-"), "proj");
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
    name: "RELAY_MCP_KEY",
    kind: "api_key",
    value: API_KEY,
  });
  const keyed = {
    url: upstream.url,
    vaultItemId: key.item.id,
    headerName: "X-Api-Key",
    headerPrefix: "",
  };
  await m("mcp.add", { name: "notes", ...keyed });
  await m("mcp.add", { name: "limited", ...keyed, allowTools: ["echo"] });
  proxyToken = (
    await m<{ token: string }>("mcp.issueSessionToken", {
      sessionId: "relay-agent",
      servers: ["notes", "limited"],
    })
  ).token;
  narrowToken = (
    await m<{ token: string }>("mcp.issueSessionToken", {
      sessionId: "relay-narrow",
      servers: ["notes"],
    })
  ).token;

  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "mcp-worker",
    labels: [],
  });
  workerHome = tmp("band-mcp-relay-home-");
  const root = tmp("band-mcp-relay-root-");
  const workerRepo = join(root, "proj");
  mkdirSync(workerRepo, { recursive: true });
  git(workerRepo, "init", "-q", "-b", "main");
  writeFileSync(join(workerRepo, "hello.txt"), "hello from the repo\n");
  git(workerRepo, "add", ".");
  git(workerRepo, "commit", "-q", "-m", "init");
  httpLogFile = join(workerHome, "http-log.jsonl");
  stubLogFile = join(workerHome, "stub-log.jsonl");

  const asAgent = (token: string) => ({
    authorization: `Bearer ${token}`,
    accept: "application/json, text/event-stream",
  });
  const call = (
    name: string,
    path: string,
    token: string | undefined,
    body: object,
    extra: object = {},
  ) => ({
    http: {
      name,
      path,
      method: "POST",
      body,
      headers: token ? asAgent(token) : { accept: "application/json, text/event-stream" },
      ...extra,
    },
  });
  writeFileSync(
    join(workerHome, "scenario.json"),
    JSON.stringify({
      turns: [
        {
          match: "^mcp-probe",
          steps: [
            call(
              "list",
              "/mcp-proxy/notes",
              proxyToken,
              rpcBody({ method: "tools/list", params: {} }),
            ),
            call(
              "echo",
              "/mcp-proxy/notes",
              proxyToken,
              rpcBody({
                method: "tools/call",
                params: { name: "echo", arguments: { text: "through-the-relay" } },
              }),
            ),
            call(
              "limited-list",
              "/mcp-proxy/limited",
              proxyToken,
              rpcBody({ method: "tools/list", params: {} }),
            ),
            call(
              "limited-denied",
              "/mcp-proxy/limited",
              proxyToken,
              rpcBody({
                method: "tools/call",
                params: { name: "add", arguments: { a: 1, b: 2 } },
              }),
            ),
            call(
              "no-proxy-token",
              "/mcp-proxy/notes",
              undefined,
              rpcBody({ method: "tools/list", params: {} }),
            ),
            call(
              "wrong-proxy-token",
              "/mcp-proxy/notes",
              "mcp_not-issued",
              rpcBody({ method: "tools/list", params: {} }),
            ),
            call(
              "narrow-token",
              "/mcp-proxy/limited",
              narrowToken,
              rpcBody({ method: "tools/list", params: {} }),
            ),
            call(
              "no-relay-credential",
              "/mcp-proxy/notes",
              proxyToken,
              rpcBody({ method: "tools/list", params: {} }),
              {
                auth: "none",
              },
            ),
            { say: "probed" },
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
      tmp("band-mcp-relay-state-"),
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

  const chatId = "mcp-relay-chat";
  const stream = await openStream(server.url, chatId, { until: turnEnded, timeoutMs: 40_000 });
  const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId: "proj-mcp", text: "mcp-probe" }),
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

describe("the MCP proxy through a worker's relay (S5)", () => {
  it("lists and calls tools from the worker with the session token, and the upstream sees the key", () => {
    expect(logged("list")?.status).toBe(200);
    const listed = JSON.parse(logged("list")?.body ?? "{}") as {
      result: { tools: Array<{ name: string }> };
    };
    expect(listed.result.tools.map((t) => t.name)).toContain("echo");

    expect(logged("echo")?.status).toBe(200);
    expect(logged("echo")?.body).toContain("echo:through-the-relay");

    expect(upstream.requests.length).toBeGreaterThan(0);
    for (const request of upstream.requests) {
      expect(request.headers["x-api-key"]).toBe(API_KEY);
      expect(JSON.stringify(request.headers)).not.toContain(proxyToken);
      expect(JSON.stringify(request.headers)).not.toContain(TEST_TOKEN);
    }
  });

  it("applies the server's tool filter to the agent on the worker", () => {
    const tools = (
      JSON.parse(logged("limited-list")?.body ?? "{}") as {
        result: { tools: Array<{ name: string }> };
      }
    ).result.tools;
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    expect(logged("limited-denied")?.body).toContain("not available through this proxy");
    expect(upstream.calls).not.toContain("add");
  });

  it("still requires the proxy token, scoped to the server, as well as the relay's own", () => {
    expect(logged("no-proxy-token")?.status).toBe(401);
    expect(logged("wrong-proxy-token")?.status).toBe(401);
    expect(logged("narrow-token")?.status).toBe(403);
    // The proxy token alone is no way in: the relay wants the worker's token for its own port.
    expect(logged("no-relay-credential")?.status).toBe(401);
  });

  it("keeps the vault key and the hub's tokens away from the agent", () => {
    const agentSide = `${readFileSync(stubLogFile, "utf8")}${httpLog()
      .map((l) => l.body)
      .join("\n")}`;
    expect(agentSide).not.toContain(API_KEY);
    expect(agentSide).not.toContain(TEST_TOKEN);
  });
});
