import { z } from "zod";
import {
  checkCli,
  installCli,
  isCliCheckApplicable,
  resolveCliPaths,
} from "../../services/cli-service";
import { adminProcedure, publicProcedure, t } from "../trpc";

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
  // `applicable` is false when nobody can act on the answer: the hub runs no worktrees of its
  // own (workers carry their own CLI), or the caller is not an admin.
  check: publicProcedure.query(async ({ ctx }) => {
    // Not applicable: skip the file system probe and report the neutral answer.
    if (!isCliCheckApplicable(ctx.admin))
      return { status: "Installed" as const, applicable: false };
    return { status: await checkCli(), applicable: true };
  }),

  resolve: adminProcedure.query(() => {
    return resolveCliPaths();
  }),

  install: adminProcedure
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
