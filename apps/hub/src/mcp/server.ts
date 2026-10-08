import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createContext } from "../server/api/context.ts";
import { appRouter } from "../server/api/router.ts";
import { contextToolsService, type ToolCaller } from "../server/services/context-tools-service.ts";

// ---------------------------------------------------------------------------
// Discover tRPC procedures and extract metadata
// ---------------------------------------------------------------------------

interface ProcedureInfo {
  /** Dot-separated tRPC path, e.g. "repos.list" */
  path: string;
  /** MCP tool name, e.g. "band_repos_list" */
  toolName: string;
  /** "query" | "mutation" */
  type: string;
  /** Zod input schema, or undefined for no-input procedures */
  inputSchema: unknown;
}

function discoverProcedures(): ProcedureInfo[] {
  const procedures: ProcedureInfo[] = [];
  // appRouter._def.procedures is a flat Record<"namespace.method", AnyProcedure>
  const procRecord = (appRouter._def as unknown as Record<string, unknown>).procedures as Record<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: tRPC internal structure
    any
  >;

  for (const [path, procedure] of Object.entries(procRecord)) {
    const type: string = procedure._def.type;

    // Skip subscriptions — they stream and are not request/response
    if (type === "subscription") continue;

    // Credentials and the hosts they register stay out of agent reach: an agent
    // holding a device token must not be able to mint or list others.
    if (
      path.startsWith("tokens.") ||
      path.startsWith("vault.") ||
      path.startsWith("mcp.") ||
      path.startsWith("context.") ||
      path.startsWith("projects.") ||
      path.startsWith("hosts.") ||
      path.startsWith("hostRequests.") ||
      path.startsWith("runners.")
    )
      continue;
    // `environment.validate` reads a directory the caller names on the hub's disk.
    if (path === "environment.validate") continue;
    // `repos.addFromWorker` reads folders on a worker the caller names.
    if (path === "repos.addFromWorker") continue;
    // `repos.addByUrl` makes the hub and its workers contact a URL the caller names.
    if (path === "repos.addByUrl") continue;
    // The add-repo previews read a worker's folders and contact a URL the caller names.
    if (path === "repos.inspectFolder" || path === "repos.resolveRemote") continue;
    // `environment.build` runs commands from the repository on the builder host.
    if (path === "environment.build") continue;

    const toolName = `band_${path.replace(/\./g, "_")}`;

    // tRPC stores input validators in _def.inputs as an array of parsers.
    // Each procedure has 0 or 1 input schemas.
    const inputs = procedure._def.inputs as unknown[];
    const inputSchema = inputs.length > 0 ? inputs[0] : undefined;

    procedures.push({ path, toolName, type, inputSchema });
  }

  return procedures;
}

// ---------------------------------------------------------------------------
// Create a configured McpServer with all tRPC tools registered
// ---------------------------------------------------------------------------

function createMcpServer(req: IncomingMessage): McpServer {
  const server = new McpServer({
    name: "band",
    version: "1.0.0",
  });

  const procedures = discoverProcedures();
  const ctx = createContext({ req });
  const caller = appRouter.createCaller(ctx);
  registerContextTools(server, { chatId: ctx.chatId, worktreeId: ctx.worktreeId });

  for (const proc of procedures) {
    const description = `${proc.type === "mutation" ? "Mutation" : "Query"}: ${proc.path}`;

    const config: {
      description: string;
      inputSchema?: unknown;
    } = { description };

    if (proc.inputSchema) {
      config.inputSchema = proc.inputSchema;
    }

    // biome-ignore lint/suspicious/noExplicitAny: dynamic tRPC caller traversal
    const handler = async (args: any) => {
      try {
        // Navigate the caller proxy: "repos.list" → caller.repos.list(args)
        const parts = proc.path.split(".");
        // biome-ignore lint/suspicious/noExplicitAny: dynamic proxy traversal
        let target: any = caller;
        for (const part of parts) {
          target = target[part];
        }

        const input = args && Object.keys(args).length > 0 ? args : undefined;
        const result = await target(input);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    };

    // biome-ignore lint/suspicious/noExplicitAny: MCP SDK accepts Zod schemas as AnySchema
    server.registerTool(proc.toolName, config as any, handler);
  }

  return server;
}

// ---------------------------------------------------------------------------
// Context tools (plan step 5.4). They are scoped to the calling session's
// project context, so none of them takes a context name.
// ---------------------------------------------------------------------------

function registerContextTools(server: McpServer, caller: ToolCaller): void {
  const run = async (fn: () => Promise<unknown>) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(await fn(), null, 2) }] };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
    }
  };

  server.registerTool(
    "context_search",
    {
      description:
        "Search the project context and the user context by file name and text. Returns ranked files with matching lines. scope is project, user or all (default).",
      inputSchema: z.object({
        query: z.string().min(1).max(200),
        scope: z.enum(["project", "user", "all"]).optional(),
        limit: z.number().int().min(1).max(25).optional(),
      }),
      // biome-ignore lint/suspicious/noExplicitAny: MCP SDK accepts Zod schemas as AnySchema
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: handler args follow the schema above
    (args: any) =>
      run(() => contextToolsService.search(caller, args.query, args.scope, args.limit)),
  );

  server.registerTool(
    "context_append_learning",
    {
      description:
        "Record something future agents should know (how to run a test, a pitfall, a decision) in the project context. Appends to learnings/<date>-<agent>.md.",
      inputSchema: z.object({
        text: z.string().min(1).max(8000),
        tags: z.array(z.string().max(40)).max(10).optional(),
      }),
      // biome-ignore lint/suspicious/noExplicitAny: MCP SDK accepts Zod schemas as AnySchema
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: handler args follow the schema above
    (args: any) => run(() => contextToolsService.appendLearning(caller, args)),
  );

  server.registerTool(
    "context_handoff",
    {
      description:
        "Hand work over to another agent or the coordinator. Writes handoffs/<stamp>-<you>-to-<to>.md and adds a line to inbox/<to>.md in the project context.",
      inputSchema: z.object({
        to: z.string().min(1).max(63),
        summary: z.string().min(1).max(8000),
        links: z.array(z.string().max(500)).max(20).optional(),
      }),
      // biome-ignore lint/suspicious/noExplicitAny: MCP SDK accepts Zod schemas as AnySchema
    } as any,
    // biome-ignore lint/suspicious/noExplicitAny: handler args follow the schema above
    (args: any) => run(() => contextToolsService.handoff(caller, args)),
  );
}

// ---------------------------------------------------------------------------
// HTTP request handler for /mcp
// ---------------------------------------------------------------------------

export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Stateless mode: create a new server + transport per request.
  // This is the recommended pattern from the MCP SDK for stateless servers.
  const server = createMcpServer(req);

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res);

    // Clean up when the response is done
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
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
