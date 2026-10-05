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
  scopeProjects: z.array(z.string().min(1).max(200)).max(200).nullable().optional(),
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

  audit: adminProcedure
    .input(
      z.object({ server: name.optional(), limit: z.number().int().min(1).max(500).default(100) }),
    )
    .query(({ input }) => ({ entries: mcpProxyService.listAudit(input.limit, input.server) })),
});
