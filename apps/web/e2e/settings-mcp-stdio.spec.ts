/**
 * Settings > MCP, stdio servers (plan steps 4.4 and 4.5, scenario S4). The user path: add a worker
 * from Settings > Hosts, run the real `band-worker` binary with the printed environment, store an
 * environment secret in the vault, then add a stdio server on that host from the MCP form, test it,
 * restrict it to two tools and save. A plain HTTP client then talks to the proxy the way an agent
 * does and sees only those two tools. Real hub and worker, temp dirs, never the real `~/.band`.
 * `apps/hub/tests/mcp-stdio-relay.test.ts` covers the relay itself.
 */

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  startServer,
} from "./helpers/server";
import { parseWorkerCommand, startWorker, type WorkerHandle } from "./helpers/worker";
import { SettingsPage } from "./pages/SettingsPage";

test.use({ viewport: { width: 1280, height: 800 } });

const TOKEN = "e2e-mcp-stdio-token";
const STDIO_SERVER = join(import.meta.dirname, "../../hub/tests/fixtures/mcp-stdio-server.mjs");

let server: ServerHandle;
let tmpHome: string;
let worker: WorkerHandle | undefined;
const dirs: string[] = [];

const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

async function trpc<T>(procedure: string, input: unknown, mutation = true): Promise<T> {
  const url = mutation
    ? `${server.url}/trpc/${procedure}`
    : `${server.url}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await fetch(url, {
    method: mutation ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Cookie: `band_token=${TOKEN}` },
    body: mutation ? JSON.stringify(input) : undefined,
  });
  if (!res.ok) throw new Error(`${procedure}: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { result: { data: T } }).result.data;
}

/** One JSON-RPC POST to the proxy. Returns the reply text and the session id the server set. */
async function proxyRpc(bearer: string, body: object, sessionId?: string) {
  const res = await fetch(`${server.url}/mcp-proxy/e2e-stdio`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearer}`,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  return { text: await res.text(), sessionId: res.headers.get("mcp-session-id") ?? undefined };
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await worker?.kill();
  await server.close();
  cleanupTmpHome(tmpHome);
  for (const dir of dirs) cleanupTmpHome(dir);
});

test("adds a stdio server on a worker host, tests it, limits its tools and serves them through the proxy", async ({
  page,
}) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("hosts");

  await settingsPage.addWorker("stdio-box", "");
  const env = parseWorkerCommand(await settingsPage.readWorkerCommand());
  const hostId = env.BAND_WORKER_ID;
  const root = tmpDir("band-e2e-stdio-root-");
  worker = startWorker({
    env: {
      BAND_HUB_URL: env.BAND_HUB_URL,
      BAND_BOOTSTRAP_TOKEN: env.BAND_BOOTSTRAP_TOKEN,
      BAND_WORKER_ID: hostId,
    },
    root,
    stateDir: tmpDir("band-e2e-stdio-state-"),
    home: tmpDir("band-e2e-stdio-home-"),
  });
  await expect(settingsPage.hostRow(hostId)).toHaveAttribute("data-status", "online", {
    timeout: 20_000,
  });

  await settingsPage.openSection("credentials");
  await settingsPage.addCredential("STDIO_SECRET", "stdio-e2e-SECRET-0123", "Environment variable");
  await settingsPage.expectRowVisible(settingsPage.credentialRow("STDIO_SECRET"));
  await settingsPage.openSection("mcp");

  await settingsPage.startMcpStdioServer({
    name: "e2e-stdio",
    hostId,
    command: process.execPath,
    args: [STDIO_SERVER],
    cwd: root,
    envName: "STDIO_SECRET",
    envVaultItem: "STDIO_SECRET",
  });
  await settingsPage.testMcpConnection();
  await expect(settingsPage.mcpTestResult()).toHaveAttribute("data-ok", "true", {
    timeout: 20_000,
  });
  await settingsPage.allowOnlyMcpTools(["echo", "add"]);
  await settingsPage.saveMcpServer();

  const row = settingsPage.mcpServerRow("e2e-stdio");
  await settingsPage.expectRowVisible(row);
  await expect(row).toContainText("2 tools allowed");
  await expect(settingsPage.mcpServerStatus("e2e-stdio")).toHaveAttribute("data-state", "ok");
  // The secret is in the vault, not in the form, the row or the page.
  await expect(settingsPage.dialog).not.toContainText("stdio-e2e-SECRET-0123");

  const { servers } = await trpc<{
    servers: Array<{ name: string; transport: string; hostId: string | null; command: string }>;
  }>("mcp.list", undefined, false);
  const saved = servers.find((s) => s.name === "e2e-stdio");
  expect(saved).toMatchObject({ transport: "stdio", hostId, command: process.execPath });

  // An agent's view: initialize, then list. Only the two allowed tools come back.
  const { token } = await trpc<{ token: string }>("mcp.issueSessionToken", {
    sessionId: "e2e-stdio-chat",
    servers: ["e2e-stdio"],
  });
  const init = await proxyRpc(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "1.0.0" },
    },
  });
  expect(init.sessionId).toBeTruthy();
  await proxyRpc(token, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId);
  const listed = await proxyRpc(
    token,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    init.sessionId,
  );
  expect(listed.text).toContain('"echo"');
  expect(listed.text).toContain('"add"');
  expect(listed.text).not.toContain('"write_note"');
  expect(listed.text).not.toContain('"whoami"');
});
