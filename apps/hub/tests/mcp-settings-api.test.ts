// Integration test for the procedures behind Settings > MCP (plan step 4.5): `mcp.test` lists an
// upstream's tools unfiltered, for a saved server and for a form that is not saved yet, and
// `mcp.audit` pages. Real hub on a random port, real MCP server (`fixtures/mcp-stub.ts`).

import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type McpStub, startMcpStub } from "./fixtures/mcp-stub";
import { seedSettings } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";

const ADMIN = "mcp-settings-admin-secret";
const API_KEY = "sk-settings-MCP-PLAINTEXT-0123456789";

type TestResult =
  | { ok: true; tools: Array<{ name: string; readOnly: boolean }> }
  | { ok: false; reason: string; message: string };

let home: string;
let server: ServerHandle;
let upstream: McpStub;
let keyId: string;

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

beforeAll(async () => {
  home = createTmpHome("band-mcp-settings-");
  seedSettings(home, { tokenSecret: ADMIN });
  upstream = await startMcpStub({
    authorize: (h) => h.authorization === `Bearer ${API_KEY}`,
    json: true,
  });
  server = await startServer({ tmpHome: home, remoteHost: false, env: { BAND_SERVE_UI: "false" } });
  keyId = (
    await m<{ item: { id: string } }>("vault.put", { name: "K", kind: "api_key", value: API_KEY })
  ).item.id;
}, 120_000);

afterAll(async () => {
  await server?.close();
  await upstream?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10 });
});

describe("mcp.test", () => {
  it("lists every tool with its readOnlyHint for an unsaved form", async () => {
    const result = await m<TestResult>("mcp.test", { url: upstream.url, vaultItemId: keyId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byName = new Map(result.tools.map((t) => [t.name, t.readOnly]));
    expect(byName.get("echo")).toBe(true);
    expect(byName.get("write_note")).toBe(false);
    expect(byName.has("wipe")).toBe(true);
  });

  it("reports a refused credential as an auth failure, never echoing the key", async () => {
    const result = await m<TestResult>("mcp.test", { url: upstream.url });
    expect(result).toMatchObject({ ok: false, reason: "auth" });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("reports an unreachable server", async () => {
    const result = await m<TestResult>("mcp.test", { url: "http://127.0.0.1:1/mcp" });
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("never returns the upstream's response body in a failure message", async () => {
    const result = await m<TestResult>("mcp.test", { url: upstream.url, vaultItemId: keyId });
    expect(result.ok).toBe(true);
    const bad = await m<TestResult>("mcp.test", { url: `${upstream.url}/nope` });
    expect(JSON.stringify(bad)).not.toContain(API_KEY);
    if (!bad.ok) expect(bad.message.length).toBeLessThan(80);
  });

  it("ignores a saved server's allowlist so the editor shows every tool", async () => {
    await m("mcp.add", {
      name: "limited",
      url: upstream.url,
      vaultItemId: keyId,
      allowTools: ["echo"],
    });
    const result = await m<TestResult>("mcp.test", { name: "limited" });
    expect(result.ok && result.tools.length).toBeGreaterThan(1);
  });

  it("refuses a non-loopback http URL", async () => {
    const res = await trpcMutate(server.url, "mcp.test", { url: "http://example.com/mcp" }, ADMIN);
    expect(res.status).toBe(400);
  });
});

describe("access", () => {
  it("refuses mcp.test and mcp.audit without a token and for a non-admin device token", async () => {
    const { token } = await m<{ token: string }>("tokens.createDevice", { label: "plain" });
    const body = { url: upstream.url };
    expect((await trpcMutate(server.url, "mcp.test", body, "")).status).toBe(401);
    expect((await trpcMutate(server.url, "mcp.test", body, token)).status).toBe(403);
    expect((await trpcQuery(server.url, "mcp.audit", {}, "")).status).toBe(401);
    expect((await trpcQuery(server.url, "mcp.audit", {}, token)).status).toBe(403);
  });
});

describe("mcp.audit", () => {
  it("pages with offset and says whether more rows exist", async () => {
    const { token } = await m<{ token: string }>("mcp.issueSessionToken", {
      sessionId: "audit-session",
      servers: ["limited"],
    });
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${server.url}/mcp-proxy/limited`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: i,
          method: "tools/call",
          params: { name: "echo", arguments: { text: String(i) } },
        }),
      });
      expect(res.status).toBe(200);
    }
    const first = await q<{ entries: unknown[]; hasMore: boolean }>("mcp.audit", {
      server: "limited",
      limit: 2,
    });
    expect(first.entries).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = await q<{ entries: unknown[]; hasMore: boolean }>("mcp.audit", {
      server: "limited",
      limit: 2,
      offset: 2,
    });
    expect(second.entries).toHaveLength(1);
    expect(second.hasMore).toBe(false);
  });
});
