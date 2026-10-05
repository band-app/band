// Integration tests for the HTTP MCP proxy at /mcp-proxy/<server> (plan step 4.2). The real production
// server runs on a random port against a temp BAND_HOME. Upstreams are real MCP servers (the SDK's
// McpServer over streamable HTTP, `fixtures/mcp-stub.ts`), and clients are the SDK's own MCP client, so
// the proxy is exercised the way an agent uses it. OAuth uses the local authorization server from the
// vault tests.

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type McpStub, startMcpStub } from "./fixtures/mcp-stub";
import { type OAuthStub, startOAuthStub } from "./fixtures/oauth-stub";
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

const ADMIN = "mcp-proxy-admin-shared-secret";
const API_KEY = "sk-upstream-MCP-PLAINTEXT-0123456789";

let home: string;
let server: ServerHandle;
let sse: McpStub;
let json: McpStub;
let oauth: OAuthStub;
let oauthUpstream: McpStub;
let logFile: string;

const m = async <T>(proc: string, input: unknown) => {
  const res = await trpcMutate(server.url, proc, input, ADMIN);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};
const q = async <T>(proc: string, input?: unknown) => {
  const res = await trpcQuery(server.url, proc, input, ADMIN);
  expect(res.status, `${proc}: ${await res.clone().text()}`).toBe(200);
  return trpcData<T>(res);
};

let sessionCounter = 0;
const issue = (servers: string[], ttlSec?: number, sessionId = `session-${++sessionCounter}`) =>
  m<{ token: string; tokenId: string; expiresAt: number }>("mcp.issueSessionToken", {
    sessionId,
    servers,
    ttlSec,
  }).then((t) => ({ ...t, sessionId }));

const proxyUrl = (name: string) => `${server.url}/mcp-proxy/${name}`;

async function connect(name: string, token: string): Promise<Client> {
  const client = new Client({ name: "proxy-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(proxyUrl(name)), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

/** A raw JSON-RPC POST through the proxy. */
async function rpc(name: string, token: string | undefined, body: unknown) {
  const res = await fetch(proxyUrl(name), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return res;
}

/** The JSON-RPC message in a response, whether the body is JSON or an SSE stream. */
async function messageOf(
  res: Response,
): Promise<{ result?: unknown; error?: { message: string } }> {
  const text = await res.text();
  const data = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .at(-1)
    : text;
  return JSON.parse(data ?? "{}");
}

const callBody = (name: string, args: object = {}, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});
const listBody = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };

/** Every byte under the temp home that the hub wrote, plus the server log. */
function allBytes(): Buffer {
  const chunks: Buffer[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (stat.size < 64 * 1024 * 1024) {
        try {
          chunks.push(readFileSync(full));
        } catch {
          // a socket or a file that vanished
        }
      }
    }
  };
  walk(join(home, ".band"));
  chunks.push(readFileSync(logFile));
  return Buffer.concat(chunks);
}

const toolNames = (r: { tools: Array<{ name: string }> }) => r.tools.map((t) => t.name).sort();

beforeAll(async () => {
  home = createTmpHome("band-mcp-proxy-");
  logFile = join(home, "server.log");
  process.env.BAND_TEST_SERVER_LOG = logFile;
  seedSettings(home, { tokenSecret: ADMIN });
  const repo = join(home, "proj");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  seedState(home, {
    repos: [
      {
        name: "proj",
        path: repo,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: repo }],
      },
    ],
  });
  const keyed = (h: Record<string, string | string[] | undefined>) => h["x-api-key"] === API_KEY;
  sse = await startMcpStub({ authorize: keyed });
  json = await startMcpStub({ authorize: keyed, json: true });
  oauth = await startOAuthStub({ expiresIn: 3600 });
  oauthUpstream = await startMcpStub({
    authorize: (h) => {
      const bearer = String(h.authorization ?? "").replace(/^Bearer /, "");
      return oauth.liveAccessTokens().includes(bearer);
    },
    json: true,
  });
  server = await startServer({
    remoteHost: false,
    tmpHome: home,
    env: { BAND_SERVE_UI: "false" },
  });

  const key = await m<{ item: { id: string } }>("vault.put", {
    name: "NOTES_API_KEY",
    kind: "api_key",
    value: API_KEY,
  });
  const keyed2 = { vaultItemId: key.item.id, headerName: "X-Api-Key", headerPrefix: "" };
  await m("mcp.add", { name: "notes", url: sse.url, ...keyed2 });
  await m("mcp.add", { name: "notes-json", url: json.url, ...keyed2 });
  await m("mcp.add", {
    name: "limited",
    url: sse.url,
    ...keyed2,
    allowTools: ["echo", "write_note"],
  });
  await m("mcp.add", { name: "readonly", url: sse.url, ...keyed2, readOnly: true });
  await m("mcp.add", { name: "readonly-json", url: json.url, ...keyed2, readOnly: true });
}, 90_000);

afterAll(async () => {
  await server?.close();
  await Promise.all([sse?.close(), json?.close(), oauth?.close(), oauthUpstream?.close()]);
  delete process.env.BAND_TEST_SERVER_LOG;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("listing and calling through the proxy (S1)", () => {
  for (const [label, name, stub] of [
    ["an SSE upstream", "notes", () => sse],
    ["a JSON upstream", "notes-json", () => json],
  ] as const) {
    it(`lists and calls tools on ${label}, and the upstream sees the key`, async () => {
      const { token } = await issue([name]);
      const before = stub().requests.length;
      const client = await connect(name, token);
      try {
        const tools = await client.listTools();
        expect(toolNames(tools)).toEqual(["add", "boom", "echo", "slow", "wipe", "write_note"]);
        const echoed = await client.callTool({ name: "echo", arguments: { text: "hi" } });
        expect(echoed.content).toEqual([{ type: "text", text: "echo:hi" }]);
        const sum = await client.callTool({ name: "add", arguments: { a: 2, b: 3 } });
        expect(sum.content).toEqual([{ type: "text", text: "5" }]);
      } finally {
        await client.close();
      }
      const seen = stub().requests.slice(before);
      expect(seen.length).toBeGreaterThan(0);
      for (const request of seen) {
        expect(request.headers["x-api-key"]).toBe(API_KEY);
        // The agent's token is not the upstream's business.
        expect(JSON.stringify(request.headers)).not.toContain(token);
      }
    });
  }

  it("never shows the client the stored key, in a body or a header", async () => {
    const { token } = await issue(["notes"]);
    for (const body of [listBody, callBody("echo", { text: "x" })]) {
      const res = await rpc("notes", token, body);
      const headers = JSON.stringify([...res.headers.entries()]);
      expect(headers).not.toContain(API_KEY);
      expect(await res.text()).not.toContain(API_KEY);
    }
  });

  it("streams an answer to the client while the upstream is still working", async () => {
    const { token } = await issue(["notes"]);
    const res = await fetch(proxyUrl("notes"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ...callBody("slow", {}, 7),
        params: { name: "slow", arguments: {}, _meta: { progressToken: "p1" } },
      }),
    });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let seen = "";
    // The progress notification arrives while the tool call is still pending upstream.
    while (!seen.includes("notifications/progress")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended before the progress notification");
      seen += decoder.decode(value, { stream: true });
    }
    expect(seen).not.toContain("slow done");
    await sse.slowWaiting();
    sse.release();
    while (!seen.includes("slow done")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    expect(seen).toContain("slow done");
  });

  it("passes GET and DELETE through, and ends the upstream stream when the client leaves", async () => {
    const { token } = await issue(["notes"]);
    const abort = new AbortController();
    const get = await fetch(proxyUrl("notes"), {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      signal: abort.signal,
    });
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toContain("text/event-stream");
    expect(sse.requests.at(-1)?.method).toBe("GET");
    abort.abort();
    const del = await fetch(proxyUrl("notes"), {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(sse.requests.at(-1)?.method).toBe("DELETE");
    expect(del.status).toBeLessThan(500);
  });
});

describe("tool filters (S2)", () => {
  it("shows only allowed tools and refuses a call to another, which never reaches the upstream", async () => {
    const { token } = await issue(["limited"]);
    const client = await connect("limited", token);
    try {
      expect(toolNames(await client.listTools())).toEqual(["echo", "write_note"]);
      const ran = sse.calls.length;
      await expect(client.callTool({ name: "add", arguments: { a: 1, b: 2 } })).rejects.toThrow(
        /not available through this proxy/,
      );
      expect(sse.calls.length).toBe(ran);
      const ok = await client.callTool({ name: "write_note", arguments: { text: "n" } });
      expect(ok.content).toEqual([{ type: "text", text: "wrote:n" }]);
    } finally {
      await client.close();
    }
  });

  for (const [label, name, stub] of [
    ["SSE", "readonly", () => sse],
    ["JSON", "readonly-json", () => json],
  ] as const) {
    it(`read-only mode keeps tools annotated readOnlyHint (${label} upstream)`, async () => {
      const { token } = await issue([name]);
      const client = await connect(name, token);
      try {
        expect(toolNames(await client.listTools())).toEqual(["add", "echo"]);
        const ran = stub().calls.length;
        for (const tool of ["write_note", "wipe", "boom"]) {
          await expect(client.callTool({ name: tool, arguments: { text: "x" } })).rejects.toThrow(
            /not available through this proxy/,
          );
        }
        expect(stub().calls.length).toBe(ran);
        const ok = await client.callTool({ name: "echo", arguments: { text: "r" } });
        expect(ok.content).toEqual([{ type: "text", text: "echo:r" }]);
      } finally {
        await client.close();
      }
    });
  }

  it("decides a read-only call by looking the tool up when no tools/list came first", async () => {
    const { token } = await issue(["readonly"]);
    const ran = sse.calls.length;
    const denied = await messageOf(
      await rpc("readonly", token, callBody("write_note", { text: "x" })),
    );
    expect(denied.error?.message).toMatch(/not available/);
    expect(sse.calls.length).toBe(ran);
    const allowed = await messageOf(await rpc("readonly", token, callBody("add", { a: 4, b: 5 })));
    expect(allowed.result).toMatchObject({ content: [{ type: "text", text: "9" }] });
  });

  it("lets readOnlyTools name a tool the server does not annotate, and an update changes the filter", async () => {
    await m("mcp.update", { name: "readonly", readOnlyTools: ["wipe"] });
    const { token } = await issue(["readonly"]);
    const client = await connect("readonly", token);
    try {
      expect(toolNames(await client.listTools())).toEqual(["add", "echo", "wipe"]);
      const wiped = await client.callTool({ name: "wipe", arguments: {} });
      expect(wiped.content).toEqual([{ type: "text", text: "wiped" }]);
    } finally {
      await client.close();
    }
    await m("mcp.update", { name: "readonly", readOnlyTools: [] });
    const again = await connect("readonly", (await issue(["readonly"])).token);
    try {
      expect(toolNames(await again.listTools())).toEqual(["add", "echo"]);
    } finally {
      await again.close();
    }
  });

  it("refuses the denied calls of a batch with one error each and forwards none", async () => {
    const { token } = await issue(["limited"]);
    const ran = sse.calls.length;
    const res = await rpc("limited", token, [
      callBody("echo", { text: "a" }, 1),
      callBody("add", { a: 1, b: 1 }, 2),
    ]);
    const replies = (await res.json()) as Array<{ id: number; error?: { message: string } }>;
    expect(replies.map((r) => r.id).sort()).toEqual([1, 2]);
    expect(replies.every((r) => r.error)).toBe(true);
    expect(replies.find((r) => r.id === 2)?.error?.message).toMatch(/not available/);
    expect(sse.calls.length).toBe(ran);
  });

  it("audits each call with the server, tool, session and outcome, and keeps arguments and results out", async () => {
    const { token, sessionId } = await issue(["limited"], undefined, "audited-session");
    const secretArg = "ARGUMENT-VALUE-THAT-MUST-NOT-BE-STORED";
    await messageOf(await rpc("limited", token, callBody("echo", { text: secretArg })));
    await messageOf(await rpc("limited", token, callBody("add", { a: 1, b: 2 })));
    await rpc("limited", token, callBody("write_note", { text: "n" }));

    const { entries } = await waitFor(
      async () => {
        const result = await q<{
          entries: Array<{
            server: string;
            tool: string;
            sessionId: string;
            ok: boolean;
            error: string | null;
          }>;
        }>("mcp.audit", { server: "limited" });
        return result.entries.filter((e) => e.sessionId === sessionId).length >= 3
          ? result
          : undefined;
      },
      { label: "audit rows" },
    );
    const mine = entries.filter((e) => e.sessionId === sessionId);
    expect(mine.find((e) => e.tool === "echo")).toMatchObject({
      server: "limited",
      ok: true,
      error: null,
    });
    expect(mine.find((e) => e.tool === "add")).toMatchObject({ ok: false, error: "not-allowed" });
    expect(mine.find((e) => e.tool === "write_note")?.ok).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(secretArg);
    expect(allBytes().includes(Buffer.from(secretArg))).toBe(false);
  });

  it("records a tool that reports an error as a failed call", async () => {
    const { token, sessionId } = await issue(["notes"]);
    await messageOf(await rpc("notes", token, callBody("boom")));
    const found = await waitFor(
      async () => {
        const { entries } = await q<{
          entries: Array<{ tool: string; sessionId: string; ok: boolean; error: string | null }>;
        }>("mcp.audit", { server: "notes" });
        return entries.find((e) => e.sessionId === sessionId && e.tool === "boom");
      },
      { label: "boom audit" },
    );
    expect(found).toMatchObject({ ok: false, error: "upstream-error" });
  });
});

describe("an OAuth upstream (S3)", () => {
  it("refreshes an expired access token on a 401 and carries on", async () => {
    const started = await m<{ flowId: string; authorizationUrl: string }>("vault.startOAuth", {
      name: "oauth-notes",
      serverUrl: oauth.resourceUrl,
      scope: "global",
      redirectBase: server.url,
    });
    const auth = await fetch(started.authorizationUrl, { redirect: "manual" });
    expect(auth.status).toBe(302);
    await fetch(auth.headers.get("location") as string);
    const { item } = await q<{ item: { id: string } }>("vault.oauthStatus", {
      flowId: started.flowId,
    });
    await m("mcp.add", { name: "oauth-notes", url: oauthUpstream.url, vaultItemId: item.id });

    const { token } = await issue(["oauth-notes"]);
    const client = await connect("oauth-notes", token);
    try {
      const first = await client.callTool({ name: "echo", arguments: { text: "one" } });
      expect(first.content).toEqual([{ type: "text", text: "echo:one" }]);
      const refreshesBefore = oauth.tokenRequests.filter(
        (r) => r.grant_type === "refresh_token",
      ).length;

      // The access token the hub holds is now dead at the server, though the hub thinks it has time left.
      oauth.expireAccessTokens();
      const unauthorized = oauthUpstream.requests.length;
      const second = await client.callTool({ name: "echo", arguments: { text: "two" } });
      expect(second.content).toEqual([{ type: "text", text: "echo:two" }]);

      const refreshes = oauth.tokenRequests.filter((r) => r.grant_type === "refresh_token");
      expect(refreshes.length).toBe(refreshesBefore + 1);
      // The upstream saw the dead token, then the fresh one.
      const bearers = oauthUpstream.requests
        .slice(unauthorized)
        .map((r) => (r.headers.authorization ?? "").replace("Bearer ", ""));
      expect(bearers.length).toBeGreaterThanOrEqual(2);
      expect(bearers[0]).not.toBe(bearers.at(-1));
      expect(oauth.liveAccessTokens()).toContain(bearers.at(-1));
    } finally {
      await client.close();
    }
  });

  it("answers 502 without leaking anything when the refresh fails", async () => {
    const { token } = await issue(["oauth-notes"]);
    oauth.expireAccessTokens();
    oauth.failNextToken();
    const res = await rpc("oauth-notes", token, callBody("echo", { text: "x" }));
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toContain("rejected the stored credential");
    expect(body).not.toMatch(/at-[0-9a-f]{8}|rt-[0-9a-f]{8}/);
  });
});

describe("tokens (S4)", () => {
  it("refuses a missing, malformed or unknown token with 401", async () => {
    for (const token of [
      undefined,
      "garbage",
      "mcp_not-a-real-token",
      "bdt_looks-like-a-device-token",
    ]) {
      const res = await rpc("notes", token, listBody);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    }
    // The hub's own admin token is no credential for the proxy.
    expect((await rpc("notes", ADMIN, listBody)).status).toBe(401);
  });

  it("refuses an expired token", async () => {
    const { token } = await issue(["notes"], 1);
    expect((await rpc("notes", token, listBody)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect((await rpc("notes", token, listBody)).status).toBe(401);
  });

  it("refuses a token for a server it does not name with 403, and an unknown server", async () => {
    const { token } = await issue(["notes"]);
    expect((await rpc("limited", token, listBody)).status).toBe(403);
    expect((await rpc("does-not-exist", token, listBody)).status).toBe(403);
  });

  it("stops a session's tokens when the session is revoked", async () => {
    const a = await issue(["notes"], undefined, "revoked-session");
    const b = await issue(["notes", "limited"], undefined, "revoked-session");
    const other = await issue(["notes"]);
    expect((await rpc("notes", a.token, listBody)).status).toBe(200);
    expect(
      (await m<{ revoked: number }>("mcp.revokeSession", { sessionId: "revoked-session" })).revoked,
    ).toBe(2);
    expect((await rpc("notes", a.token, listBody)).status).toBe(401);
    expect((await rpc("limited", b.token, listBody)).status).toBe(401);
    expect((await rpc("notes", other.token, listBody)).status).toBe(200);
  });

  it("does not let tokens for a removed server reach a server added under the same name", async () => {
    await m("mcp.add", { name: "reused", url: json.url, headerName: "x-api-key" });
    const { token } = await issue(["reused", "notes"]);
    await m("mcp.remove", { name: "reused" });
    await m("mcp.add", { name: "reused", url: sse.url });
    expect((await rpc("reused", token, listBody)).status).toBe(403);
    expect((await rpc("notes", token, listBody)).status).toBe(200);
    await m("mcp.remove", { name: "reused" });
  });

  it("refuses a batch that uses one request id twice", async () => {
    const { token } = await issue(["limited"]);
    const res = await rpc("limited", token, [listBody, callBody("echo", { text: "x" }, 1)]);
    expect(res.status).toBe(400);
    expect((await messageOf(res)).error).toBeDefined();
  });

  it("revokes a session's tokens when its chat is removed", async () => {
    const chatId = "mcp-revoke-chat";
    await m("chats.create", { worktreeId: "proj-main", id: chatId });
    const { token } = await issue(["notes"], undefined, chatId);
    expect((await rpc("notes", token, listBody)).status).toBe(200);
    await m("chats.remove", { chatId });
    await waitFor(
      async () => ((await rpc("notes", token, listBody)).status === 401 ? true : undefined),
      {
        label: "token revoked",
      },
    );
  });

  it("answers 404 for a disabled server, and works again once it is enabled", async () => {
    const { token } = await issue(["notes-json"]);
    await m("mcp.update", { name: "notes-json", enabled: false });
    expect((await rpc("notes-json", token, listBody)).status).toBe(404);
    await m("mcp.update", { name: "notes-json", enabled: true });
    expect((await rpc("notes-json", token, listBody)).status).toBe(200);
  });

  it("rejects routes and methods the proxy does not serve", async () => {
    const { token } = await issue(["notes"]);
    expect(
      (await fetch(`${server.url}/mcp-proxy/`, { headers: { authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(404);
    expect(
      (await fetch(`${proxyUrl("notes")}/extra`, { headers: { authorization: `Bearer ${token}` } }))
        .status,
    ).toBe(404);
    const put = await fetch(proxyUrl("notes"), {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(put.status).toBe(405);
    const bad = await rpc("notes", token, "not json");
    expect([200, 400]).toContain(bad.status);
  });

  it("stores only a hash of each token and keeps tokens and keys out of the log", async () => {
    const { token } = await issue(["notes"]);
    await rpc("notes", token, callBody("echo", { text: "log-check" }));
    const bytes = allBytes();
    expect(bytes.includes(Buffer.from(token))).toBe(false);
    expect(bytes.includes(Buffer.from(token.slice(4)))).toBe(false);
    expect(bytes.includes(Buffer.from(API_KEY))).toBe(false);
    expect(readFileSync(logFile, "utf8")).not.toMatch(/mcp_[A-Za-z0-9_-]{20,}/);
  });

  it("limits what is configured and who may configure it", async () => {
    const bad = async (proc: string, input: unknown) =>
      (await trpcMutate(server.url, proc, input, ADMIN)).status;
    expect(await bad("mcp.add", { name: "Bad Name", url: sse.url })).toBe(400);
    expect(await bad("mcp.add", { name: "notes", url: sse.url })).toBe(400);
    expect(await bad("mcp.add", { name: "plain", url: "http://example.com/mcp" })).toBe(400);
    expect(await bad("mcp.add", { name: "creds", url: "https://user:pw@example.com/mcp" })).toBe(
      400,
    );
    expect(await bad("mcp.add", { name: "novault", url: sse.url, vaultItemId: "nope" })).toBe(400);
    expect(await bad("mcp.add", { name: "hdr", url: sse.url, headerName: "Host" })).toBe(400);
    expect(await bad("mcp.issueSessionToken", { sessionId: "s", servers: ["missing"] })).toBe(404);
    expect(await bad("mcp.remove", { name: "missing" })).toBe(404);

    // A device token that is not an admin cannot touch any of it.
    const device = await m<{ token: string }>("tokens.createDevice", { label: "plain" });
    for (const [proc, input] of [
      ["mcp.add", { name: "x", url: sse.url }],
      ["mcp.issueSessionToken", { sessionId: "s", servers: ["notes"] }],
      ["mcp.revokeSession", { sessionId: "s" }],
    ] as const) {
      expect((await trpcMutate(server.url, proc, input, device.token)).status).toBe(403);
    }
    expect((await trpcQuery(server.url, "mcp.list", undefined, device.token)).status).toBe(403);
    expect((await trpcQuery(server.url, "mcp.audit", {}, device.token)).status).toBe(403);
  });

  it("lists servers without any credential and removes one", async () => {
    const { servers } = await q<{ servers: Array<{ name: string; vaultItemId: string | null }> }>(
      "mcp.list",
    );
    expect(servers.map((s) => s.name)).toEqual(
      expect.arrayContaining(["notes", "limited", "readonly", "oauth-notes"]),
    );
    expect(JSON.stringify(servers)).not.toContain(API_KEY);
    await m("mcp.add", { name: "temp", url: sse.url });
    await m("mcp.remove", { name: "temp" });
    expect(
      (await q<{ servers: Array<{ name: string }> }>("mcp.list")).servers.map((s) => s.name),
    ).not.toContain("temp");
  });

  it("keeps the proxy admin tools out of the hub's own MCP endpoint", async () => {
    const res = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        cookie: `band_token=${ADMIN}`,
      },
      body: JSON.stringify(listBody),
    });
    const text = await res.text();
    expect(text).toContain("band_repos_list");
    expect(text).not.toContain("band_mcp_");
  });
});
