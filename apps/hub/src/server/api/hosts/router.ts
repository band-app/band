/**
 * `hosts.list` — the machines Band can run workspaces on, for the Hosts screen
 * and `band hosts list`. The MCP endpoint skips this namespace (`src/mcp/server.ts`).
 */

import { tokenService } from "../../services/token-service";
import { publicProcedure, t } from "../trpc";

export const hostsRouter = t.router({
  list: publicProcedure.query(() => ({ hosts: tokenService.listHosts() })),
});
