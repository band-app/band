/**
 * `/mcp-proxy/band-task`: the hub's own MCP server for the agent of a task (plan step T.2). It sits
 * on the proxy route next to `band-coordinator`, so it shares the per-session `mcp_` token. The
 * token's session id is the task's chat. The hub maps that chat to its task, so a call can change
 * only its own task, and a chat that is not a task chat gets 403.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@band-app/logger";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ProjectInputError, ProjectTaskNotFoundError } from "../../errors";
import { chatService } from "../../services/chat-service";
import { projectTaskService } from "../../services/project-task-service";
import { sendJson } from "./http-util";

const log = createLogger("task-mcp");

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

async function run(fn: () => unknown | Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await fn();
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  } catch (err) {
    if (!(err instanceof ProjectInputError) && !(err instanceof ProjectTaskNotFoundError)) {
      log.warn({ err }, "task tool failed");
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

/** The task of a task chat. A chat of a member worktree is not one, because it has a worktree of its own. */
function taskOfChat(chatId: string) {
  const chat = chatService.get(chatId);
  if (!chat?.taskId || chat.worktreeId) return undefined;
  return projectTaskService.find(chat.taskId);
}

function createServer(chatId: string): McpServer {
  const server = new McpServer({ name: "band-task", version: "1.0.0" });
  const task = () => {
    const row = taskOfChat(chatId);
    if (!row) throw new ProjectInputError("This task no longer exists.");
    return row;
  };
  const tool = (
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    // biome-ignore lint/suspicious/noExplicitAny: handler args follow the schema given with it
    handler: (args: any) => unknown | Promise<unknown>,
  ) => {
    // biome-ignore lint/suspicious/noExplicitAny: MCP SDK accepts Zod shapes as AnySchema
    server.registerTool(name, { description, inputSchema } as any, (args: any) =>
      run(() => handler(args ?? {})),
    );
  };

  tool(
    "task_info",
    "This task's folder, branch, host and the repos that already have a worktree in it.",
    {},
    () => projectTaskService.get(task().id),
  );
  tool(
    "task_add_repo",
    "Add a repo of this task's project to the task: a git worktree on the task's branch, started from the repo's default branch, in a folder of its own in the task folder. Returns its path. Only the project's repos are allowed, and the task's host must have the labels the project requires. A refused call names the reason, so stop and hand over instead of retrying.",
    { repo: z.string().min(1).max(200), role: z.string().max(100).optional() },
    (args) => projectTaskService.addRepo(task().id, { repo: args.repo, role: args.role }),
  );
  tool(
    "task_remove_repo",
    "Remove a repo's worktree from this task. Refused while it has commits that are not on the default branch or uncommitted changes.",
    { repo: z.string().min(1).max(200) },
    async (args) => {
      await projectTaskService.removeRepo(task().id, args.repo);
      return { removed: args.repo };
    },
  );
  return server;
}

export async function handleTaskMcp(
  req: IncomingMessage,
  res: ServerResponse,
  auth: { sessionId: string },
): Promise<void> {
  if (!taskOfChat(auth.sessionId)) {
    return sendJson(res, 403, { error: "This session is not a task chat" });
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
    log.warn({ err }, "task MCP request failed");
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}
