/**
 * `environment.*`: a repository's `.band/environment.json`, parsed and
 * validated, for Settings > Environment and `band env validate`, and the
 * repo's environment image (`imageStatus`, `build`). The MCP
 * endpoint leaves `validate` and `build` out: one reads a path the caller
 * names and the other runs repository commands, so both need an admin token.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { environmentBuildService } from "../../services/environment-build-service";
import { environmentService } from "../../services/environment-service";
import { adminProcedure, publicProcedure, t } from "../trpc";

export const environmentRouter = t.router({
  forRepo: publicProcedure
    .input(z.object({ repoName: z.string().min(1) }))
    .query(async ({ input }) => {
      const view = await environmentService.forRepo(input.repoName);
      if (!view) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Repo not found: ${input.repoName}`,
        });
      }
      return view;
    }),

  /** The repo's current image, its latest build and recent builds. */
  imageStatus: publicProcedure
    .input(z.object({ repoName: z.string().min(1) }))
    .query(({ input }) => environmentBuildService.status(input.repoName)),

  /**
   * Starts building the repo's image at the default branch, or reports a
   * cache hit or a build already running. Admin only: the build runs commands
   * from the repository on the builder host.
   */
  build: adminProcedure
    .input(z.object({ repoName: z.string().min(1), force: z.boolean().optional() }))
    .mutation(({ input }) => environmentBuildService.build(input.repoName, { force: input.force })),

  validate: adminProcedure
    .input(z.object({ path: z.string().min(1).max(4096) }))
    .query(({ input }) => environmentService.validatePath(input.path)),
});
