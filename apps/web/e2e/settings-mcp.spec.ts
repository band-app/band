/**
 * Settings > MCP (plan step 4.5): add an HTTP server with a vault API key, test the connection,
 * restrict it to two tools, scope it to one project, and read the audit log of a call made through
 * the proxy. The upstream is a real MCP server (`apps/hub/tests/fixtures/mcp-stub.ts`) and the
 * hub is the production bundle with a temp BAND_HOME. An agent is stood in for by a plain HTTP
 * client holding a session token from `mcp.issueSessionToken`, which is the call the agent
 * launcher makes. `apps/hub/tests/mcp-session-servers.test.ts` covers the session wiring.
 *
 * Stdio servers (plan step 4.4) are not in this spec: that step has not merged.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { type McpStub, startMcpStub } from "../../hub/tests/fixtures/mcp-stub";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { SettingsPage } from "./pages/SettingsPage";

test.use({ viewport: { width: 1280, height: 800 } });

const TOKEN = "e2e-mcp-settings-token";
const API_KEY = "sk-e2e-MCP-UPSTREAM-KEY-123";

let server: ServerHandle;
let tmpHome: string;
let upstream: McpStub;

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

/** One JSON-RPC call to the proxy, as an agent would make it with its session token. */
async function proxyRpc(name: string, bearer: string, method: string, params: object) {
  const res = await fetch(`${server.url}/mcp-proxy/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return await res.text();
}

test.beforeAll(async () => {
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  const alpha = join(tmpHome, "alpha");
  mkdirSync(alpha, { recursive: true });
  seedState(tmpHome, {
    projects: [
      {
        name: "alpha",
        path: alpha,
        defaultBranch: "main",
        worktrees: [{ branch: "main", path: alpha }],
      },
    ],
  });
  upstream = await startMcpStub({
    authorize: (h) => h.authorization === `Bearer ${API_KEY}`,
    json: true,
  });
  server = await startServer({ tmpHome });
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await server.close();
  await upstream.close();
  cleanupTmpHome(tmpHome);
});

test("adds a server with a vault key, limits it to two tools, scopes it to a project and audits a call", async ({
  page,
}) => {
  const settingsPage = new SettingsPage(page, server.url, TOKEN);
  await settingsPage.goto();
  await settingsPage.openDialog("credentials");
  await settingsPage.addCredential("UPSTREAM_KEY", API_KEY);
  await settingsPage.expectRowVisible(settingsPage.credentialRow("UPSTREAM_KEY"));

  await settingsPage.openSection("mcp");
  await settingsPage.startMcpServer("notes", upstream.url, "UPSTREAM_KEY");
  await settingsPage.testMcpConnection();
  await expect(settingsPage.mcpTestResult()).toHaveAttribute("data-ok", "true");

  await settingsPage.allowOnlyMcpTools(["echo", "add"]);
  await expect(settingsPage.mcpMissionsScope()).toBeDisabled();
  await settingsPage.scopeMcpToProject("alpha");
  await settingsPage.saveMcpServer();

  const row = settingsPage.mcpServerRow("notes");
  await settingsPage.expectRowVisible(row);
  await expect(row).toContainText("Projects: alpha");
  await expect(row).toContainText("2 tools allowed");
  await expect(row.getByTestId("settings__mcp-status")).toHaveAttribute("data-state", "ok");
  // The upstream key is in the vault, not in the server row or the page.
  await expect(settingsPage.dialog).not.toContainText(API_KEY);

  const { servers } = await trpc<{
    servers: Array<{ name: string; allowTools: string[] | null; scopeProjects: string[] | null }>;
  }>("mcp.list", undefined, false);
  const saved = servers.find((s) => s.name === "notes");
  expect(saved?.allowTools?.sort()).toEqual(["add", "echo"]);
  expect(saved?.scopeProjects).toEqual(["alpha"]);

  // A session sees only the two tools through the proxy, and the call is audited.
  const issued = await trpc<{ token: string }>("mcp.issueSessionToken", {
    sessionId: "e2e-chat",
    servers: ["notes"],
  });
  const listed = await proxyRpc("notes", issued.token, "tools/list", {});
  expect(listed).toContain('"echo"');
  expect(listed).toContain('"add"');
  expect(listed).not.toContain('"write_note"');
  expect(listed).not.toContain('"wipe"');
  const called = await proxyRpc("notes", issued.token, "tools/call", {
    name: "echo",
    arguments: { text: "hello" },
  });
  expect(called).toContain("echo:hello");

  await settingsPage.openMcpAudit("notes");
  await expect(settingsPage.mcpAuditTools().first()).toHaveText("echo");
  await expect(settingsPage.mcpAuditSessions().first()).toHaveText("e2e-chat");
  await expect(settingsPage.mcpAuditEntries().first()).toHaveAttribute("data-ok", "true");
});
