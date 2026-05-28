import { z } from "zod";
import { checkCli, installCli, resolveCliPaths } from "../../services/cli";
import { publicProcedure, t } from "../trpc";

/**
 * CLI sub-router — migrated into the 3-tier architecture as part of
 * Phase 7.5 (issue #517). Backs the dashboard's "Install CLI" button +
 * status pill: detects the sidecar binary, exposes the symlink location,
 * and creates the `/usr/local/bin/band` symlink when the user opts in.
 *
 * The actual binary resolution / symlinking lives in `services/cli.ts`
 * (absorbed from `lib/cli.ts`).
 */
export const cliRouter = t.router({
  check: publicProcedure.query(async () => {
    const status = await checkCli();
    return { status };
  }),

  resolve: publicProcedure.query(() => {
    return resolveCliPaths();
  }),

  install: publicProcedure
    .input(z.object({ allowPrompt: z.boolean().optional() }).optional())
    .mutation(async ({ input }) => {
      try {
        await installCli({ allowPrompt: input?.allowPrompt });
        return { ok: true };
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : String(err));
      }
    }),
});

export type CliRouter = typeof cliRouter;
