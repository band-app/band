/**
 * `/mcp-proxy/band-coordinator`: the hub's own MCP server for project
 * coordinators (plan step 6.2). It sits on the proxy route so it shares the
 * per-session `mcp_` token, its revocation and the worker relay path.
 *
 * The token's session id is the chat it was issued for. The hub maps that chat
 * to its project, so no argument of a tool names a project and a call cannot
 * leave it. A chat that is not a coordinator chat gets 403, even with a valid
 * token.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "@band-app/logger";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { dispatchInputShape } from "../../services/_utils/dispatch-input";
import {
  CoordinatorToolError,
  projectCoordinatorService,
} from "../../services/project-coordinator-service";
import { projectDispatchService } from "../../services/project-dispatch-service";
import { sendJson } from "./http-util";

const log = createLogger("coordinator-mcp");

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

async function run(fn: () => unknown | Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await fn();
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  } catch (err) {
    if (!(err instanceof CoordinatorToolError)) {
      log.warn({ err }, "coordinator tool failed");
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

function createServer(projectId: string): McpServer {
  const server = new McpServer({ name: "band-coordinator", version: "1.0.0" });
  // The project is looked up on every call, so a policy change applies at once.
  const project = () => {
    const row = projectCoordinatorService.projectById(projectId);
    if (!row) throw new CoordinatorToolError("This project no longer exists.");
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
    "project_status",
    "The project's repos, policy, running worker agents, worktrees with their chats and pull requests, and spend against the budget.",
    {},
    () => projectCoordinatorService.status(project()),
  );
  tool(
    "worktrees_list",
    "The worktrees of this project with their chat ids, branches, hosts and pull requests. Only these chats can be read or messaged.",
    {},
    () => ({ worktrees: projectCoordinatorService.listWorktrees(project()) }),
  );
  tool(
    "chats_read",
    "Read the last turns of a worker chat of this project as plain text.",
    { chatId: z.string().min(1).max(200), turns: z.number().int().min(1).max(20).optional() },
    (args) => projectCoordinatorService.readChat(project(), args.chatId, args.turns),
  );
  tool(
    "chats_send",
    "Send a message to a worker chat of this project. A busy chat queues it. Refused in observe mode, past the budget, or when the concurrent limit is reached.",
    { chatId: z.string().min(1).max(200), message: z.string().min(1).max(20_000) },
    (args) => projectCoordinatorService.sendToChat(project(), args.chatId, args.message),
  );
  tool(
    "worktree_stop",
    "Stop the running turns of every chat in a worktree of this project. Refused in observe mode.",
    { worktreeId: z.string().min(1).max(300) },
    (args) => projectCoordinatorService.stopWorktree(project(), args.worktreeId),
  );
  tool(
    "repo_read",
    "Read a file from the checkout of a repo's default branch in the project folder, or list a directory (an empty path lists the top level). Only this project's repos can be read.",
    { repo: z.string().min(1).max(200), path: z.string().max(1000) },
    (args) => projectCoordinatorService.repoRead(project(), args.repo, args.path),
  );
  tool(
    "repo_search",
    "Search the checkout of a repo's default branch for a fixed string (case-insensitive). Returns file, line and text. Only this project's repos can be searched.",
    { repo: z.string().min(1).max(200), query: z.string().min(1).max(500) },
    (args) => projectCoordinatorService.repoSearch(project(), args.repo, args.query),
  );
  tool(
    "repo_log",
    "The newest commits on the checkout of a repo's default branch. Only this project's repos can be read.",
    { repo: z.string().min(1).max(200), n: z.number().int().min(1).max(100) },
    (args) => projectCoordinatorService.repoLog(project(), args.repo, args.n),
  );
  tool(
    "worktrees_create",
    "Dispatch work: create a worktree in a repo of this project (or a group of repos), write your brief to .am/BRIEF.md in it, and start a worker agent on the project's worker model that reads it. Pass `repo`, or `group` ({repos:[{repo, role}], mode: split, mergeOrder:[repo...]}) for work across repos: split makes one worktree and agent per repo on the same branch and tells each the siblings and the pull request order. `brief` is markdown the worker works from alone, so state the goal, the constraints and what is out of scope. `scenarios` are the acceptance scenarios the worker must check. `placement` takes labels, requires and isolation within the project's policy. In steer mode the call answers \"pending approval\" and the user decides on the project page. Returns the worktree ids.",
    dispatchInputShape,
    (args) => projectDispatchService.dispatch(project(), args),
  );
  return server;
}

export async function handleCoordinatorMcp(
  req: IncomingMessage,
  res: ServerResponse,
  auth: { sessionId: string },
): Promise<void> {
  const row = projectCoordinatorService.projectOfChat(auth.sessionId);
  if (!row) return sendJson(res, 403, { error: "This session is not a project coordinator" });
  // Stateless: one server and transport per request, as the hub's own /mcp does.
  const server = createServer(row.id);
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    log.warn({ err }, "coordinator MCP request failed");
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}
