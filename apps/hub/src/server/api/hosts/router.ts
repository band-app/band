/** `hosts.list` — the machines Band can run workspaces on, for the Hosts screen. */

import { tokenService } from "../../services/token-service";
import { publicProcedure, t } from "../trpc";

export const hostsRouter = t.router({
  list: publicProcedure.query(() => ({ hosts: tokenService.listHosts() })),
});
