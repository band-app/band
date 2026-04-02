import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createContext } from "../trpc/context.ts";
import { appRouter } from "../trpc/router.ts";

// ---------------------------------------------------------------------------
// Discover tRPC procedures and extract metadata
// ---------------------------------------------------------------------------

interface ProcedureInfo {
  /** Dot-separated tRPC path, e.g. "projects.list" */
  path: string;
  /** MCP tool name, e.g. "band_projects_list" */
  toolName: string;
  /** "query" | "mutation" */
  type: string;
  /** Zod input schema, or undefined for no-input procedures */
  inputSchema: unknown;
}

function discoverProcedures(): ProcedureInfo[] {
  const procedures: ProcedureInfo[] = [];
  // appRouter._def.procedures is a flat Record<"namespace.method", AnyProcedure>
  const procRecord = (appRouter._def as Record<string, unknown>).procedures as Record<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: tRPC internal structure
    any
  >;

  for (const [path, procedure] of Object.entries(procRecord)) {
    const type: string = procedure._def.type;

    // Skip subscriptions — they stream and are not request/response
    if (type === "subscription") continue;

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

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "band",
    version: "1.0.0",
  });

  const procedures = discoverProcedures();
  const caller = appRouter.createCaller(createContext());

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
        // Navigate the caller proxy: "projects.list" → caller.projects.list(args)
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
// HTTP request handler for /mcp
// ---------------------------------------------------------------------------

export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Stateless mode: create a new server + transport per request.
  // This is the recommended pattern from the MCP SDK for stateless servers.
  const server = createMcpServer();

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
