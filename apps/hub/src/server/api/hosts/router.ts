/**
 * `hosts.list` — the machines Band can run workspaces on, for the Hosts screen
 * and `band hosts list`. The MCP endpoint leaves this procedure out.
 */

import { z } from "zod";
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, tokenService } from "../../services/token-service";
import { publicProcedure, t } from "../trpc";

export const hostsRouter = t.router({
  list: publicProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT) })
        .default({ limit: DEFAULT_LIST_LIMIT }),
    )
    .query(({ input }) => ({ hosts: tokenService.listHosts(input.limit) })),
});
