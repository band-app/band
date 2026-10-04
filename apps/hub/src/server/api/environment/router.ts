/**
 * `environment.*`: a repository's `.band/environment.json`, parsed and
 * validated, for Settings > Environment and `band env validate`. The MCP
 * endpoint leaves `validate` out because it reads a path the caller names,
 * and it needs an admin token for the same reason.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { environmentService } from "../../services/environment-service";
import { adminProcedure, publicProcedure, t } from "../trpc";

export const environmentRouter = t.router({
  forProject: publicProcedure
    .input(z.object({ projectName: z.string().min(1) }))
    .query(async ({ input }) => {
      const view = await environmentService.forProject(input.projectName);
      if (!view) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Project not found: ${input.projectName}`,
        });
      }
      return view;
    }),

  validate: adminProcedure
    .input(z.object({ path: z.string().min(1).max(4096) }))
    .query(({ input }) => environmentService.validatePath(input.path)),
});
