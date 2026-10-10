/**
 * The `band` MCP server every chat gets (origin links, plan section 15). It is built in, so it
 * has no `mcp_servers` row and no upstream: `/mcp-proxy/band` answers here. The chat's session
 * token names the chat, which is how the hub knows where a worktree was started from. Nothing
 * in the request body can change that.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { slugifyBranchName } from "@band-app/shared/branch-name";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { hostRegistry } from "../../infra/host/registry";
import { chatService } from "../../services/chat-service";
import { worktreeService } from "../../services/worktree-service";

const createInput = z.object({
  repo: z.string().describe("Name of a repo registered with Band"),
  branch: z.string().describe("Branch for the new worktree. The worktree id derives from it."),
  base: z.string().optional().describe("Branch or commit to start from"),
  hostId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Host to create it on. Defaults to the host this chat runs on; a chat on a worker cannot pick another host.",
    ),
  prompt: z
    .string()
    .max(100_000)
    .optional()
    .describe("First prompt for a coding agent in the new worktree"),
  codingAgentId: z.string().optional().describe("Which coding agent runs the prompt"),
  origin: z
    .string()
    .min(1)
    .optional()
    .describe("Worktree id to record as the origin instead of this chat's worktree"),
  noOrigin: z.boolean().optional().describe("Record no origin for the new worktree"),
});

function jsonText(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function createServer(chatId: string): McpServer {
  const server = new McpServer({ name: "band", version: "1.0.0" });
  server.registerTool(
    "worktrees_create",
    {
      description:
        "Start linked work: create a worktree in a repo, optionally with a first prompt for a coding agent. " +
        "The new worktree records this chat's worktree and this chat as its origin, and may start work of its own.",
      // biome-ignore lint/suspicious/noExplicitAny: the SDK accepts a Zod object here
      inputSchema: createInput as any,
    },
    // biome-ignore lint/suspicious/noExplicitAny: arguments are validated by the schema above
    async (args: any) => {
      try {
        const input = createInput.parse(args);
        const chat = chatService.get(chatId);
        if (!chat) return jsonText({ error: "This chat no longer exists" }, true);
        // A chat on a worker acts for that worker. Another host is the hub's call to make, not the worker's.
        const callerHost = hostRegistry.hostIdOfScope(chat.worktreeId) ?? hostRegistry.local.id;
        if (callerHost !== hostRegistry.local.id) {
          if (input.hostId !== undefined && input.hostId !== callerHost) {
            return jsonText(
              { error: "A chat on a worker creates worktrees on that worker only" },
              true,
            );
          }
          input.hostId = callerHost;
          if (
            input.origin !== undefined &&
            hostRegistry.hostIdOfScope(input.origin) !== callerHost
          ) {
            return jsonText(
              { error: "A chat on a worker can only link to worktrees on that worker" },
              true,
            );
          }
        }
        const result = await worktreeService.create(input, {
          worktreeId: chat.worktreeId,
          chatId,
        });
        const branch = slugifyBranchName(input.branch);
        return jsonText({
          ...result,
          worktreeId: result.provisioning ? undefined : toWorktreeId(input.repo, branch),
        });
      } catch (err) {
        return jsonText({ error: err instanceof Error ? err.message : String(err) }, true);
      }
    },
  );
  return server;
}

export async function handleBandTools(
  req: IncomingMessage,
  res: ServerResponse,
  chatId: string,
): Promise<void> {
  const server = createServer(chatId);
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }),
      );
    }
  }
}
