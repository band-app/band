/**
 * Talks to the `band` MCP server in process. `tools.list` and `tools.run` go through here, so the
 * CLI sees the tool set `/mcp-proxy/band` serves, built by the same `createBandServer`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBandServer } from "./band-tools";
import type { ToolScope } from "./tool-scope";

/** Runs `fn` against a client connected to a fresh `band` server for this scope. */
async function withClient<T>(scope: ToolScope, fn: (client: Client) => Promise<T>): Promise<T> {
  const server = await createBandServer(scope);
  const client = new Client({ name: "band-tools-api", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverSide);
    await client.connect(clientSide);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

async function listAll(client: Client) {
  const tools = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

export async function listBandTools(scope: ToolScope) {
  return withClient(scope, listAll);
}

/** The MCP SDK default is 60 s. Extension tools (a render, an export) can run for minutes. */
const CALL_TIMEOUT_MS = 10 * 60_000;

/** Calls one tool on a single server instance. Returns null when the scope has no such tool. */
export async function runBandTool(scope: ToolScope, name: string, args: Record<string, unknown>) {
  return withClient(scope, async (client) => {
    if (!(await listAll(client)).some((tool) => tool.name === name)) return null;
    return client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
  });
}
