/**
 * `mcp.*`: the MCP servers the hub proxies and the tokens agents use to reach
 * them (plan step 4.2). Every procedure needs an admin device token. The MCP
 * endpoint and the worker relay leave the router out, so an agent cannot add a
 * server or mint a token for itself.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { McpProxyInputError, McpServerNotFoundError } from "../../errors";
import { mcpProxyService } from "../../services/mcp-proxy-service";
import { testMcpConnection, testStdioConnection } from "../../services/mcp-test-service";
import { adminProcedure, t } from "../trpc";

const name = z.string().trim().min(1).max(63);
const toolNames = z.array(z.string().min(1).max(200)).max(500);

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof McpServerNotFoundError) {
      throw new TRPCError({ code: "NOT_FOUND", message: err.message });
    }
    if (err instanceof McpProxyInputError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    }
    throw err;
  }
}

const envEntry = z.union([
  z.object({ name: z.string().min(1).max(128), value: z.string().max(4096) }).strict(),
  z.object({ name: z.string().min(1).max(128), vaultItemId: z.string().min(1).max(100) }).strict(),
]);

const common = {
  vaultItemId: z.string().min(1).max(100).nullable().optional(),
  headerName: z.string().min(1).max(64).optional(),
  headerPrefix: z.string().max(32).optional(),
  allowTools: toolNames.nullable().optional(),
  readOnly: z.boolean().optional(),
  readOnlyTools: toolNames.optional(),
  enabled: z.boolean().optional(),
  scopeRepos: z.array(z.string().min(1).max(200)).max(200).nullable().optional(),
  scopeHosts: z.array(z.string().min(1).max(200)).max(200).nullable().optional(),
};

const settings = {
  ...common,
  url: z.string().url().max(2000).optional(),
  transport: z.enum(["http", "stdio"]).optional(),
  // A stdio server: runs `command` on the worker `hostId`. The command is the admin's, never an agent's.
  hostId: z.string().min(1).max(100).optional(),
  command: z.string().min(1).max(1000).optional(),
  args: z.array(z.string().max(4096)).max(100).optional(),
  env: z.array(envEntry).max(50).optional(),
  cwd: z.string().max(4096).nullable().optional(),
};

export const mcpServersRouter = t.router({
  list: adminProcedure.query(() => ({ servers: mcpProxyService.listServers() })),

  add: adminProcedure
    .input(z.object({ name, ...settings }))
    .mutation(({ input }) => guard(() => ({ server: mcpProxyService.addServer(input) }))),

  update: adminProcedure
    .input(z.object({ name, ...z.object(settings).partial().omit({ transport: true }).shape }))
    .mutation(({ input: { name: serverName, ...patch } }) =>
      guard(() => ({ server: mcpProxyService.updateServer(serverName, patch) })),
    ),

  remove: adminProcedure
    .input(z.object({ name }))
    .mutation(({ input }) => guard(() => mcpProxyService.removeServer(input.name))),

  /** For the agent launcher (plan step 4.3) and tests. The token is shown once. */
  issueSessionToken: adminProcedure
    .input(
      z.object({
        sessionId: z.string().min(1).max(200),
        servers: z.array(name).min(1).max(50),
        ttlSec: z.number().int().positive().max(86_400).optional(),
      }),
    )
    .mutation(({ input }) =>
      guard(() =>
        mcpProxyService.issueSessionToken(
          input.sessionId,
          input.servers,
          input.ttlSec ? input.ttlSec * 1000 : undefined,
        ),
      ),
    ),

  revokeSession: adminProcedure
    .input(z.object({ sessionId: z.string().min(1).max(200) }))
    .mutation(({ input }) => ({ revoked: mcpProxyService.revokeSession(input.sessionId) })),

  /**
   * Connects to an upstream and lists its tools, unfiltered (Settings > MCP). Takes a saved
   * server's `name`, or the `url` and credential fields of a form that is not saved yet.
   */
  test: adminProcedure
    .input(
      z.union([
        z.object({ name }),
        z.object({
          transport: z.literal("stdio"),
          hostId: z.string().min(1).max(100),
          command: z.string().min(1).max(1000),
          args: settings.args,
          env: settings.env,
          cwd: settings.cwd,
        }),
        z.object({
          url: z.string().url().max(2000),
          vaultItemId: settings.vaultItemId,
          headerName: settings.headerName,
          headerPrefix: settings.headerPrefix,
        }),
      ]),
    )
    .mutation(async ({ input }) => {
      const asStdio = (s: {
        id?: string;
        name?: string;
        hostId: string | null;
        command: string | null;
        args?: string[];
        env?: z.infer<typeof envEntry>[];
        cwd?: string | null;
      }) => ({
        id: s.id ?? "m-test",
        name: s.name ?? "test",
        hostId: s.hostId,
        command: s.command,
        args: s.args ?? [],
        env: s.env ?? [],
        cwd: s.cwd ?? null,
      });
      if ("name" in input) {
        const saved = guard(() => {
          const found = mcpProxyService.listServers().find((s) => s.name === input.name);
          if (!found) throw new McpServerNotFoundError(input.name);
          return found;
        });
        if (saved.transport === "stdio") return testStdioConnection(asStdio(saved));
        return testMcpConnection(guard(() => mcpProxyService.connectionView(saved)));
      }
      if ("transport" in input) return testStdioConnection(asStdio(input));
      return testMcpConnection(guard(() => mcpProxyService.connectionView(input)));
    }),

  audit: adminProcedure
    .input(
      z.object({
        server: name.optional(),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).max(100_000).default(0),
      }),
    )
    .query(({ input }) => {
      const rows = mcpProxyService.listAudit(input.limit + 1, input.server, input.offset);
      return { entries: rows.slice(0, input.limit), hasMore: rows.length > input.limit };
    }),
});
