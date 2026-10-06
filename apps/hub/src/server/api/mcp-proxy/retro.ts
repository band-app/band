/**
 * `/mcp-proxy/band-retro`: the hub's own MCP server for a project's retro agent (plan step 6.5).
 * It sits on the proxy route next to `band-coordinator`, so it shares the per-session `mcp_`
 * token. The token's session id is the retro chat. The hub maps that chat to its project, so a
 * call cannot name another project, and any other chat gets 403.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@band-app/logger";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { retroProposeShape } from "../../services/_utils/retro-items";
import { projectRetroService, RetroToolError } from "../../services/project-retro-service";
import { sendJson } from "./http-util";

const log = createLogger("retro-mcp");

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

async function run(fn: () => unknown | Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await fn();
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  } catch (err) {
    if (!(err instanceof RetroToolError)) log.warn({ err }, "retro tool failed");
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

function createServer(chatId: string): McpServer {
  const server = new McpServer({ name: "band-retro", version: "1.0.0" });
  server.registerTool(
    "retro_propose",
    {
      description:
        "Hand in the retro's proposal: a list of file edits, each with a rationale. The user reviews and accepts or rejects every item, so nothing applies by itself. Call it once, with all items, then stop.",
      // biome-ignore lint/suspicious/noExplicitAny: MCP SDK accepts Zod shapes as AnySchema
      inputSchema: retroProposeShape as any,
      // biome-ignore lint/suspicious/noExplicitAny: handler args follow the schema given with it
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: handler args follow the schema given with it
    (args: any) =>
      run(() => {
        const row = projectRetroService.projectOfChat(chatId);
        if (!row) throw new RetroToolError("This project no longer exists.");
        return projectRetroService.propose(row, chatId, args ?? {});
      }),
  );
  return server;
}

export async function handleRetroMcp(
  req: IncomingMessage,
  res: ServerResponse,
  auth: { sessionId: string },
): Promise<void> {
  if (!projectRetroService.projectOfChat(auth.sessionId)) {
    return sendJson(res, 403, { error: "This session is not a project retro" });
  }
  const server = createServer(auth.sessionId);
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    log.warn({ err }, "retro MCP request failed");
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}
