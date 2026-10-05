// Integration test for MCP servers in ACP `session/new` (plan step 4.3). A real hub (the production bundle on
// a random port, auth on) proxies a real MCP server (`fixtures/mcp-stub.ts`). The coding agent is the scripted
// ACP stub: it records the `mcpServers` Band passes and calls a tool through the URL and headers it was given.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type McpStub, startMcpStub } from "./fixtures/mcp-stub";
import { STUB_AGENT_PATH, seedAcpHome, stubRequests, TEST_TOKEN } from "./helpers/acp-chat";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";

const API_KEY = "sk-session-MCP-PLAINTEXT-1234567890";

interface McpEntry {
  type: string;
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}
interface HttpLine {
  name: string;
  status: number;
  body: string;
}

const homes: string[] = [];
const files: string[] = [];

const mutate = <T>(server: ServerHandle, procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

/** Posts a chat message and waits until the stub has logged the turn's HTTP lines. */
async function send(server: ServerHandle, chatId: string, worktreeId: string, text: string) {
  const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
    body: JSON.stringify({ worktreeId, text }),
  });
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
}

const httpLog = (file: string): HttpLine[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as HttpLine)
    : [];

const newSessions = (home: string) =>
  stubRequests(home, "session/new").filter((r) => r.cwd.includes("repo"));

const mcpOf = (request: { params: Record<string, unknown> }) =>
  (request.params.mcpServers ?? []) as McpEntry[];

interface Booted {
  server: ServerHandle;
  upstream: McpStub;
  home: string;
  httpFile: string;
}

/** A hub with two repos, `alpha` and `beta`, and two proxied servers: `notes` (everywhere) and `alpha-only`. */
async function boot(caps?: Record<string, boolean>): Promise<Booted> {
  const home = seedAcpHome("band-mcp-session-");
  homes.push(home);
  const alphaRepo = join(home, "repo");
  const betaRepo = join(home, "repo-beta");
  seedState(home, {
    repos: [
      {
        name: "alpha",
        path: alphaRepo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: alphaRepo }],
      },
      {
        name: "beta",
        path: betaRepo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: betaRepo }],
      },
    ],
  });
  seedSettings(home, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  mkdirSync(betaRepo, { recursive: true });

  const httpFile = join(home, "http-log.jsonl");
  const call = (name: string, server: string) => ({
    mcpCall: { name, server, tool: "echo", args: { text: name } },
  });
  const scenario = join(home, "scenario.json");
  writeFileSync(
    scenario,
    JSON.stringify({
      turns: [
        {
          match: "^use-mcp",
          steps: [call("notes-call", "notes"), call("alpha-call", "alpha-only"), { say: "done" }],
        },
        { steps: [{ say: "ok" }] },
      ],
    }),
  );

  const upstream = await startMcpStub({ authorize: (h) => h["x-api-key"] === API_KEY, json: true });
  const server = await startServer({
    tmpHome: home,
    remoteHost: false,
    env: {
      BAND_SERVE_UI: "false",
      BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
      BAND_TEST_ACP_STATE: join(home, "acp-stub-state"),
      BAND_TEST_ACP_LOG: join(home, "acp-stub-log.jsonl"),
      BAND_TEST_ACP_HTTP_LOG: httpFile,
      BAND_TEST_ACP_SCENARIO: scenario,
      ...(caps ? { BAND_TEST_ACP_CAPS: JSON.stringify(caps) } : {}),
    },
  });
  const key = await mutate<{ item: { id: string } }>(server, "vault.put", {
    name: "SESSION_MCP_KEY",
    kind: "api_key",
    value: API_KEY,
  });
  const keyed = {
    url: upstream.url,
    vaultItemId: key.item.id,
    headerName: "X-Api-Key",
    headerPrefix: "",
  };
  await mutate(server, "mcp.add", { name: "notes", ...keyed });
  await mutate(server, "mcp.add", { name: "alpha-only", ...keyed, scopeRepos: ["alpha"] });
  return { server, upstream, home, httpFile };
}

const running: Booted[] = [];
afterAll(async () => {
  for (const b of running) {
    await b.server.close();
    await b.upstream.close();
  }
  for (const dir of homes) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  for (const f of files) rmSync(f, { force: true });
});

describe("MCP servers in session/new", () => {
  let b: Booted;
  let alphaEntries: McpEntry[];

  beforeAll(async () => {
    b = await boot();
    running.push(b);
    await send(b.server, "chat-alpha", "alpha-main", "use-mcp");
    await waitFor(() => (httpLog(b.httpFile).length >= 2 ? true : undefined), {
      label: "alpha chat calls its tools",
      timeoutMs: 30_000,
    });
    alphaEntries = mcpOf(newSessions(b.home)[0]);
  }, 120_000);

  it("passes the proxy URL and a session token, and a tool call through it works (S1)", () => {
    const notes = alphaEntries.find((e) => e.name === "notes");
    expect(notes).toMatchObject({
      type: "http",
      name: "notes",
      url: `${b.server.url}/mcp-proxy/notes`,
    });
    expect(notes?.headers).toEqual([
      { name: "Authorization", value: expect.stringMatching(/^Bearer mcp_/) },
    ]);

    const line = httpLog(b.httpFile).find((l) => l.name === "notes-call");
    expect(line?.status).toBe(200);
    expect(line?.body).toContain("echo:notes-call");
    // The upstream sees the vault key, and the agent never does.
    expect(b.upstream.requests.every((r) => r.headers["x-api-key"] === API_KEY)).toBe(true);
    expect(JSON.stringify(stubRequests(b.home))).not.toContain(API_KEY);
  });

  it("gives a server limited to repo alpha to alpha's sessions only (S3)", async () => {
    expect(alphaEntries.map((e) => e.name).sort()).toEqual(["alpha-only", "notes"]);
    expect(httpLog(b.httpFile).find((l) => l.name === "alpha-call")?.status).toBe(200);

    await send(b.server, "chat-beta", "beta-main", "use-mcp");
    await waitFor(
      () =>
        httpLog(b.httpFile).filter((l) => l.name === "alpha-call").length >= 2 ? true : undefined,
      {
        label: "beta chat tries its tools",
        timeoutMs: 30_000,
      },
    );
    const beta = newSessions(b.home).find((r) => r.cwd.endsWith("repo-beta"));
    expect(mcpOf(beta as NonNullable<typeof beta>).map((e) => e.name)).toEqual(["notes"]);
    const betaAlphaCall = httpLog(b.httpFile).filter((l) => l.name === "alpha-call")[1];
    expect(betaAlphaCall?.status).toBe(-1);
  });

  it("revokes the token when the chat is removed, so later calls get 401 (S4)", async () => {
    const entry = alphaEntries.find((e) => e.name === "notes") as McpEntry;
    const rpc = {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "after" } },
    };
    const callWithToken = () =>
      fetch(entry.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: entry.headers[0].value,
        },
        body: JSON.stringify(rpc),
      });
    expect((await callWithToken()).status).toBe(200);

    await mutate(b.server, "chats.remove", { chatId: "chat-alpha" });
    await waitFor(async () => ((await callWithToken()).status === 401 ? true : undefined), {
      label: "token revoked",
      timeoutMs: 10_000,
    });
  });
});

describe("an adapter without HTTP MCP support (S5)", () => {
  it("gets no mcpServers, and the hub logs why", async () => {
    const logFile = join(createTmpHome("band-mcp-session-log-"), "server.log");
    homes.push(join(logFile, ".."));
    files.push(logFile);
    process.env.BAND_TEST_SERVER_LOG = logFile;
    let b: Booted;
    try {
      b = await boot({ mcpHttp: false });
    } finally {
      delete process.env.BAND_TEST_SERVER_LOG;
    }
    running.push(b);
    await send(b.server, "chat-nohttp", "alpha-main", "use-mcp");
    await waitFor(() => (newSessions(b.home).length > 0 ? true : undefined), {
      label: "session started",
      timeoutMs: 30_000,
    });
    expect(mcpOf(newSessions(b.home)[0])).toEqual([]);
    await waitFor(
      () =>
        existsSync(logFile) && readFileSync(logFile, "utf8").includes("does not support HTTP MCP")
          ? true
          : undefined,
      { label: "notice logged", timeoutMs: 10_000 },
    );
  }, 120_000);
});
