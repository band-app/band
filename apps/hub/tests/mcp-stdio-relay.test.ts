// Integration test for stdio MCP servers behind the hub's proxy (plan step 4.4). A real `band-worker` dials a
// real hub (the production bundle on a random port with auth on). The stdio server (`fixtures/mcp-stdio-server.mjs`)
// is configured on that worker's host, and the MCP SDK's client calls it through `/mcp-proxy/<server>` on the hub.
// The process runs on the worker, so the test reads its pid and checks it from outside.

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
import { waitFor } from "./helpers/wait-for";

const WORKER_BIN = join(import.meta.dirname, "../../worker/bin/band-worker.mjs");
const STDIO_SERVER = join(import.meta.dirname, "fixtures/mcp-stdio-server.mjs");
const SECRET = "stdio-SECRET-VALUE-0123456789";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

let server: ServerHandle;
let hostId: string;
let bootstrap: string;
let workerHome: string;
let workerRoot: string;
let stateDir: string;
let worker: ChildProcess | undefined;
let workerOutput = "";

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

function startWorker(): void {
  worker = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      server.url,
      "--token",
      bootstrap,
      "--root",
      workerRoot,
      "--state-dir",
      stateDir,
    ],
    {
      env: { ...process.env, HOME: workerHome, BAND_HOME: join(workerHome, ".band") },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  worker.stdout?.on("data", (d) => {
    workerOutput += String(d);
  });
  worker.stderr?.on("data", (d) => {
    workerOutput += String(d);
  });
}

const hostStatus = async () =>
  (await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list")).hosts.find(
    (h) => h.id === hostId,
  )?.status;

const waitHost = (status: string) =>
  waitFor(async () => ((await hostStatus()) === status ? true : undefined), {
    label: `worker ${status}`,
    timeoutMs: 20_000,
  });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const proxyUrl = (name: string) => new URL(`${server.url}/mcp-proxy/${name}`);

async function issue(
  servers: string[],
  sessionId = `session-${Math.random().toString(36).slice(2)}`,
) {
  const { token } = await m<{ token: string }>("mcp.issueSessionToken", { sessionId, servers });
  return { token, sessionId };
}

async function connect(name: string, token: string) {
  const transport = new StreamableHTTPClientTransport(proxyUrl(name), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

const textOf = (result: unknown) =>
  ((result as { content: Array<{ text: string }> }).content[0] ?? { text: "" }).text;

async function whoami(client: Client) {
  return JSON.parse(textOf(await client.callTool({ name: "whoami", arguments: {} }))) as {
    pid: number;
    cwd: string;
  };
}

function filesContaining(dir: string, needle: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) filesContaining(path, needle, found);
    else if (entry.isFile() && statSync(path).size < 50 * 1024 * 1024) {
      if (readFileSync(path).includes(needle)) found.push(path);
    }
  }
  return found;
}

beforeAll(async () => {
  const hubHome = createTmpHome("band-mcp-stdio-hub-");
  scratch.push(hubHome);
  seedSettings(hubHome, { tokenSecret: TEST_TOKEN });
  seedState(hubHome, { projects: [] });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    env: { BAND_SERVE_UI: "false", BAND_MCP_STDIO_IDLE_MS: "600000" },
  });

  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: "stdio-worker",
    labels: [],
  });
  hostId = issued.hostId;
  bootstrap = issued.token;
  workerHome = tmp("band-mcp-stdio-home-");
  workerRoot = tmp("band-mcp-stdio-root-");
  stateDir = tmp("band-mcp-stdio-state-");
  startWorker();
  await waitHost("online");

  const secret = await m<{ item: { id: string } }>("vault.put", {
    name: "STDIO_SECRET",
    kind: "env",
    value: SECRET,
  });
  const base = { transport: "stdio", hostId, command: process.execPath, cwd: workerRoot };
  await m("mcp.add", {
    name: "local-tools",
    ...base,
    args: [STDIO_SERVER],
    env: [
      { name: "STDIO_SECRET", vaultItemId: secret.item.id },
      { name: "PLAIN_VALUE", value: "not-a-secret" },
    ],
  });
  await m("mcp.add", { name: "listed-tools", ...base, args: [STDIO_SERVER], allowTools: ["echo"] });
  await m("mcp.add", { name: "read-only-tools", ...base, args: [STDIO_SERVER], readOnly: true });
}, 120_000);

afterAll(async () => {
  worker?.kill("SIGKILL");
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
});

describe("stdio MCP servers through the proxy", () => {
  it("lists and calls a tool, and the process runs on the worker in the configured directory (S1)", async () => {
    const { token } = await issue(["local-tools"]);
    const { client } = await connect("local-tools", token);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect([...tools].sort()).toEqual(["add", "echo", "env_hash", "whoami", "write_note"]);
      expect(textOf(await client.callTool({ name: "echo", arguments: { text: "hi" } }))).toBe(
        "echo:hi",
      );
      const who = await whoami(client);
      expect(who.pid).not.toBe(process.pid);
      expect(realpathSync(who.cwd)).toBe(workerRoot);
      expect(alive(who.pid)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("applies the allowlist and read-only filters and writes the audit rows (S2)", async () => {
    const { token, sessionId } = await issue(["listed-tools", "read-only-tools"]);
    const listed = await connect("listed-tools", token);
    try {
      expect((await listed.client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
      const denied = await listed.client
        .callTool({ name: "add", arguments: { a: 1, b: 2 } })
        .catch((e) => e);
      expect(String(denied)).toContain("not available through this proxy");
      expect(
        textOf(await listed.client.callTool({ name: "echo", arguments: { text: "ok" } })),
      ).toBe("echo:ok");
    } finally {
      await listed.client.close();
    }

    const readOnly = await connect("read-only-tools", token);
    try {
      expect((await readOnly.client.listTools()).tools.map((t) => t.name)).not.toContain(
        "write_note",
      );
      const refused = await readOnly.client
        .callTool({ name: "write_note", arguments: { text: "x" } })
        .catch((e) => e);
      expect(String(refused)).toContain("not available through this proxy");
      expect(
        textOf(await readOnly.client.callTool({ name: "add", arguments: { a: 2, b: 3 } })),
      ).toBe("5");
    } finally {
      await readOnly.client.close();
    }

    const { entries } = await q<{
      entries: Array<{
        server: string;
        tool: string;
        sessionId: string;
        ok: boolean;
        error: string | null;
      }>;
    }>("mcp.audit", { server: "listed-tools" });
    const mine = entries.filter((e) => e.sessionId === sessionId);
    expect(mine.find((e) => e.tool === "echo")).toMatchObject({ ok: true, error: null });
    expect(mine.find((e) => e.tool === "add")).toMatchObject({ ok: false, error: "not-allowed" });
    const { entries: roEntries } = await q<{
      entries: Array<{ tool: string; ok: boolean; error: string | null }>;
    }>("mcp.audit", { server: "read-only-tools" });
    expect(roEntries.find((e) => e.tool === "write_note")).toMatchObject({
      ok: false,
      error: "not-allowed",
    });
    expect(roEntries.find((e) => e.tool === "add")).toMatchObject({ ok: true });
    // Arguments and results never reach the audit log.
    expect(JSON.stringify(entries)).not.toContain("echo:ok");
  });

  it("passes a vault secret to the process and nowhere else (S4)", async () => {
    const { token } = await issue(["local-tools"]);
    const { client } = await connect("local-tools", token);
    try {
      const hash = textOf(
        await client.callTool({ name: "env_hash", arguments: { name: "STDIO_SECRET" } }),
      );
      expect(hash).toBe(sha256(SECRET));
      const plain = textOf(
        await client.callTool({ name: "env_hash", arguments: { name: "PLAIN_VALUE" } }),
      );
      expect(plain).toBe(sha256("not-a-secret"));
    } finally {
      await client.close();
    }
    const listing = JSON.stringify(await q("mcp.list"));
    expect(listing).not.toContain(SECRET);
    expect(workerOutput).not.toContain(SECRET);
    // Nothing on either machine's disk holds it: not the hub's home (the vault holds only ciphertext) and not the worker's.
    for (const dir of [server.home, workerHome, workerRoot, stateDir]) {
      expect(filesContaining(dir, SECRET)).toEqual([]);
    }
  });

  it("kills the process when the proxy session is closed, or its token is revoked (S5)", async () => {
    const closed = await issue(["local-tools"]);
    const first = await connect("local-tools", closed.token);
    const { pid } = await whoami(first.client);
    expect(alive(pid)).toBe(true);
    await first.transport.terminateSession();
    await waitFor(async () => (alive(pid) ? undefined : true), {
      label: "process gone after DELETE",
    });
    await first.client.close();

    const revoked = await issue(["local-tools"]);
    const second = await connect("local-tools", revoked.token);
    const other = (await whoami(second.client)).pid;
    expect(alive(other)).toBe(true);
    await m("mcp.revokeSession", { sessionId: revoked.sessionId });
    await waitFor(async () => (alive(other) ? undefined : true), {
      label: "process gone after revoke",
    });
    await second.client.close().catch(() => {});
  });

  it("refuses another token's session id and a request without a session", async () => {
    const owner = await issue(["local-tools"]);
    const { client, transport } = await connect("local-tools", owner.token);
    try {
      const sessionId = transport.sessionId;
      expect(sessionId).toBeTruthy();
      const intruder = await issue(["local-tools"]);
      const stolen = await fetch(proxyUrl("local-tools"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${intruder.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId ?? "",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(stolen.status).toBe(404);
      const bare = await fetch(proxyUrl("local-tools"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(bare.status).toBe(400);
    } finally {
      await client.close();
    }
  });

  it("answers 503 while the worker is offline and works again after it reconnects (S3)", async () => {
    const { token } = await issue(["local-tools"]);
    const before = await connect("local-tools", token);
    const { pid } = await whoami(before.client);
    worker?.kill("SIGKILL");
    worker = undefined;
    await waitFor(async () => ((await hostStatus()) !== "online" ? true : undefined), {
      label: "worker offline",
      timeoutMs: 30_000,
    });
    await waitFor(async () => (alive(pid) ? undefined : true), {
      label: "process gone with worker",
    });
    await before.client.close().catch(() => {});

    const initialize = await fetch(proxyUrl("local-tools"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    expect(initialize.status).toBe(503);
    expect(((await initialize.json()) as { error: string }).error).toContain("offline");

    startWorker();
    await waitHost("online");
    const after = await connect("local-tools", token);
    try {
      expect(
        textOf(await after.client.callTool({ name: "echo", arguments: { text: "again" } })),
      ).toBe("echo:again");
    } finally {
      await after.client.close();
    }
  }, 90_000);

  it("only an admin can configure a stdio server, and an agent's token cannot", async () => {
    const { token } = await issue(["local-tools"]);
    const res = await trpcMutate(
      server.url,
      "mcp.add",
      { name: "sneaky", transport: "stdio", hostId, command: "/bin/sh" },
      token,
    );
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(500);
    const list = JSON.stringify(await q("mcp.list"));
    expect(list).not.toContain("sneaky");
    const missing = await fetch(proxyUrl("local-tools"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(missing.status).toBe(401);
    const garbage = await fetch(proxyUrl("local-tools"), {
      method: "POST",
      headers: {
        authorization: "Bearer mcp_garbage",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(garbage.status).toBe(401);
    const bad = await trpcMutate(
      server.url,
      "mcp.add",
      { name: "nohost", transport: "stdio", hostId: "h-nonexistent", command: "x" },
      TEST_TOKEN,
    );
    expect(bad.status).toBe(400);
  });
});
