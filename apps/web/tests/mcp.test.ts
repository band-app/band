import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedSettings, seedState } from "./helpers/seed-state";
import { SERVER_RUNTIME, SERVER_SCRIPT } from "./helpers/server-runtime";

const PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_TOKEN = "mcp-test-token";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ServerHandle {
  url: string;
  home: string;
  close: () => Promise<void>;
}

function createTmpHome(): string {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "band-mcp-test-")));
  const bandDir = join(tmp, ".band");
  mkdirSync(bandDir, { recursive: true });
  return tmp;
}

function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function startServer(
  opts: { tmpHome?: string; env?: Record<string, string> } = {},
): Promise<ServerHandle> {
  const home = opts.tmpHome || createTmpHome();
  const port = await getRandomPort();

  return new Promise((resolve, reject) => {
    const child = spawn(SERVER_RUNTIME, [SERVER_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HOME: home,
        PORT: String(port),
        NODE_ENV: "production",
        ...opts.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.stdout!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes("listening") && !settled) {
        settled = true;
        resolve({
          url: `http://127.0.0.1:${port}`,
          home,
          close: () =>
            new Promise<void>((r) => {
              child.on("exit", () => r());
              child.kill("SIGTERM");
            }),
        });
      }
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Server exited with code ${code} before listening.\nstderr: ${stderr}`));
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`Server did not start within 15 s.\nstderr: ${stderr}`));
      }
    }, 15_000);
  });
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC helpers
// ---------------------------------------------------------------------------

const authHeaders = { Cookie: `band_token=${DEFAULT_TOKEN}` };

let requestId = 0;

function mcpRequest(method: string, params?: unknown) {
  return {
    jsonrpc: "2.0",
    method,
    ...(params ? { params } : {}),
    id: ++requestId,
  };
}

async function mcpPost(
  serverUrl: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return fetch(`${serverUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...authHeaders,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Parse an MCP response. The response may be either:
 * - Direct JSON (single response)
 * - SSE stream with JSON-RPC messages in `data:` lines
 */
async function parseMcpResponse(res: Response): Promise<unknown[]> {
  const contentType = res.headers.get("content-type") || "";

  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const results: unknown[] = [];
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        const data = line.slice("data: ".length).trim();
        if (data) {
          results.push(JSON.parse(data));
        }
      }
    }
    return results;
  }

  // Direct JSON response
  const json = await res.json();
  return [json];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP server — tool listing and invocation", () => {
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, { projects: [] });
    seedSettings(tmpHome, { tokenSecret: DEFAULT_TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("initializes MCP session and lists tools", async () => {
    // Step 1: Initialize
    const initRes = await mcpPost(
      server.url,
      mcpRequest("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "band-test", version: "1.0.0" },
      }),
    );
    expect(initRes.status).toBe(200);
    const initMessages = await parseMcpResponse(initRes);
    expect(initMessages.length).toBeGreaterThan(0);
    const initResult = initMessages[0] as {
      result: { serverInfo: { name: string }; capabilities: { tools?: unknown } };
    };
    expect(initResult.result.serverInfo.name).toBe("band");
    expect(initResult.result.capabilities.tools).toBeDefined();

    // Step 2: Send initialized notification (required by MCP protocol)
    await mcpPost(server.url, { jsonrpc: "2.0", method: "notifications/initialized" });

    // Step 3: List tools
    const listRes = await mcpPost(server.url, mcpRequest("tools/list"));
    expect(listRes.status).toBe(200);
    const listMessages = await parseMcpResponse(listRes);
    expect(listMessages.length).toBeGreaterThan(0);
    const listResult = listMessages[0] as {
      result: { tools: Array<{ name: string; description: string }> };
    };
    const tools = listResult.result.tools;

    // Should have many tools (all non-subscription tRPC procedures)
    expect(tools.length).toBeGreaterThan(30);

    // Check some expected tools exist
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("band_projects_list");
    expect(toolNames).toContain("band_tasks_submit");
    expect(toolNames).toContain("band_settings_get");
    expect(toolNames).toContain("band_workspace_getDiff");
    expect(toolNames).toContain("band_tunnel_status");
    expect(toolNames).toContain("band_workspaces_create");
    expect(toolNames).toContain("band_cronjobs_list");

    // Subscriptions should NOT be exposed
    expect(toolNames).not.toContain("band_tasks_stream");
    expect(toolNames).not.toContain("band_status_stream");
    expect(toolNames).not.toContain("band_queue_stream");
  });

  it("calls band_projects_list tool and gets results", async () => {
    const callRes = await mcpPost(
      server.url,
      mcpRequest("tools/call", {
        name: "band_projects_list",
        arguments: {},
      }),
    );
    expect(callRes.status).toBe(200);
    const callMessages = await parseMcpResponse(callRes);
    expect(callMessages.length).toBeGreaterThan(0);
    const callResult = callMessages[0] as {
      result: { content: Array<{ type: string; text: string }> };
    };
    expect(callResult.result.content).toHaveLength(1);
    expect(callResult.result.content[0].type).toBe("text");

    // Parse the returned JSON text
    const data = JSON.parse(callResult.result.content[0].text);
    expect(data.projects).toEqual([]);
  });

  it("calls band_settings_get tool and gets results", async () => {
    const callRes = await mcpPost(
      server.url,
      mcpRequest("tools/call", {
        name: "band_settings_get",
        arguments: {},
      }),
    );
    expect(callRes.status).toBe(200);
    const callMessages = await parseMcpResponse(callRes);
    expect(callMessages.length).toBeGreaterThan(0);
    const callResult = callMessages[0] as {
      result: { content: Array<{ type: string; text: string }> };
    };
    expect(callResult.result.content[0].type).toBe("text");

    // Settings should be a valid JSON object
    const data = JSON.parse(callResult.result.content[0].text);
    expect(typeof data).toBe("object");
  });

  it("returns error for unknown tool", async () => {
    const callRes = await mcpPost(
      server.url,
      mcpRequest("tools/call", {
        name: "band_nonexistent_tool",
        arguments: {},
      }),
    );
    expect(callRes.status).toBe(200);
    const callMessages = await parseMcpResponse(callRes);
    expect(callMessages.length).toBeGreaterThan(0);
    const callResult = callMessages[0] as {
      error?: { code: number; message: string };
      result?: { content: Array<{ type: string; text: string }>; isError?: boolean };
    };
    // MCP SDK may return either a JSON-RPC error or a result with isError flag
    const hasError =
      callResult.error !== undefined ||
      callResult.result?.isError === true ||
      callResult.result?.content?.some((c) => c.text?.toLowerCase().includes("error"));
    expect(hasError).toBe(true);
  });

  it("tools have proper descriptions", async () => {
    const listRes = await mcpPost(server.url, mcpRequest("tools/list"));
    const listMessages = await parseMcpResponse(listRes);
    const listResult = listMessages[0] as {
      result: { tools: Array<{ name: string; description: string }> };
    };
    const tools = listResult.result.tools;

    const projectsList = tools.find((t) => t.name === "band_projects_list");
    expect(projectsList?.description).toContain("Query");
    expect(projectsList?.description).toContain("projects.list");

    const tasksSubmit = tools.find((t) => t.name === "band_tasks_submit");
    expect(tasksSubmit?.description).toContain("Mutation");
    expect(tasksSubmit?.description).toContain("tasks.submit");
  });
});

// ---------------------------------------------------------------------------
// Auth enforcement
// ---------------------------------------------------------------------------

describe("MCP server — auth enforcement", () => {
  const TOKEN = "mcp-auth-token";
  let server: ServerHandle;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = createTmpHome();
    seedState(tmpHome, { projects: [] });
    seedSettings(tmpHome, { tokenSecret: TOKEN });
    server = await startServer({ tmpHome });
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns 401 for MCP request without auth", async () => {
    const res = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(
        mcpRequest("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        }),
      ),
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 for MCP request with valid auth", async () => {
    const res = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Cookie: `band_token=${TOKEN}`,
      },
      body: JSON.stringify(
        mcpRequest("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        }),
      ),
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 for MCP request with wrong token", async () => {
    const res = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Cookie: "band_token=wrong-token",
      },
      body: JSON.stringify(
        mcpRequest("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        }),
      ),
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 for MCP request with Bearer token", async () => {
    const res = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(
        mcpRequest("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        }),
      ),
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 for MCP request with wrong Bearer token", async () => {
    const res = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer wrong-token",
      },
      body: JSON.stringify(
        mcpRequest("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        }),
      ),
    });
    expect(res.status).toBe(401);
  });
});
