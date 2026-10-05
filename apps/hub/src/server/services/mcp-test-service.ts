/**
 * "Test connection" for Settings > MCP (plan step 4.5): connects to an upstream MCP server with
 * the credential the form picked and lists its tools, unfiltered, so the allowlist editor can show
 * every tool with its `readOnlyHint`. The credential is added here, as the proxy does, and is
 * never returned or logged.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type McpServerView, mcpProxyService } from "./mcp-proxy-service";

const TEST_TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;

export interface McpToolInfo {
  name: string;
  description: string;
  readOnly: boolean;
}

export type McpTestResult =
  | { ok: true; tools: McpToolInfo[] }
  | { ok: false; reason: "unreachable" | "auth" | "error"; message: string };

function looksUnauthorized(err: unknown): boolean {
  return err instanceof StreamableHTTPError && (err.code === 401 || err.code === 403);
}

/**
 * A fixed message for a failed connection. The SDK's error text carries the upstream's response
 * body, which may echo request headers (the credential), so it is never returned.
 */
function describeFailure(err: unknown): string {
  if (err instanceof StreamableHTTPError && err.code) {
    return `The server answered with HTTP ${err.code}.`;
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return "The server did not answer in time.";
  }
  return "The server could not be reached.";
}

async function listOnce(
  server: McpServerView,
  headers: Record<string, string>,
): Promise<McpToolInfo[]> {
  const client = new Client({ name: "band-settings", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers, redirect: "manual" },
  });
  const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
  try {
    await client.connect(transport, { signal });
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const answer = await client.listTools(cursor ? { cursor } : {}, { signal });
      for (const tool of answer.tools) {
        tools.push({
          name: tool.name,
          description: (tool.description ?? "").slice(0, 500),
          readOnly: tool.annotations?.readOnlyHint === true,
        });
      }
      cursor = answer.nextCursor;
      if (!cursor) break;
    }
    return tools;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function testMcpConnection(server: McpServerView): Promise<McpTestResult> {
  let credential: Awaited<ReturnType<typeof mcpProxyService.credentialHeaders>>;
  try {
    credential = await mcpProxyService.credentialHeaders(server);
  } catch {
    return { ok: false, reason: "auth", message: "The stored credential could not be used." };
  }
  try {
    return { ok: true, tools: await listOnce(server, credential.headers) };
  } catch (err) {
    if (looksUnauthorized(err) && credential.refreshable) {
      try {
        const renewed = await mcpProxyService.credentialHeaders(server, true);
        return { ok: true, tools: await listOnce(server, renewed.headers) };
      } catch {
        return { ok: false, reason: "auth", message: "The server refused the credential." };
      }
    }
    if (looksUnauthorized(err)) {
      return { ok: false, reason: "auth", message: "The server refused the credential." };
    }
    return { ok: false, reason: "unreachable", message: describeFailure(err) };
  }
}
