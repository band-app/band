import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ExtensionInstallError, extensionService } from "../../services/extension-service";
import { pluginHost } from "../../services/plugin-host-service";
import { adminProcedure, publicProcedure, t } from "../trpc";

/**
 * `extensions.*`: the extensions installed in `<BAND_HOME>/extensions`. `list` is for every device
 * token, because the UI needs the editors to open a file. `reload` rereads the manifests and is
 * admin only. The MCP endpoint and the worker relay leave the router out.
 */
async function refuse<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ExtensionInstallError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    }
    throw err;
  }
}

export const extensionsRouter = t.router({
  install: adminProcedure
    .input(z.object({ url: z.string().min(1).max(2000), sha256: z.string().max(64).optional() }))
    .mutation(({ input }) => refuse(() => extensionService.install(input.url, input.sha256))),
  remove: adminProcedure.input(z.object({ id: z.string().min(1).max(64) })).mutation(({ input }) =>
    refuse(async () => {
      await extensionService.remove(input.id);
      return { ok: true as const };
    }),
  ),
  /**
   * Calls a worker service of an installed extension, on the worker that holds a worktree. Admin
   * only, and left out of the MCP endpoint and the relay: agents reach a service through the tools
   * an extension registers. `capability` is the name the service's manifest entry gives.
   */
  callService: adminProcedure
    .input(
      z.object({
        worktreeId: z.string().min(1),
        capability: z.string().min(1).max(64),
        method: z.string().min(1).max(100),
        params: z.unknown().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const result = await pluginHost.callForWorktree(
          input.capability,
          input.worktreeId,
          input.method,
          input.params ?? {},
        );
        return { result: result ?? null };
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  /**
   * A panel's call to its extension's worker service, on the worker of a worktree. Any device
   * token may make it, because the panel is the person's own page. The panel names itself, and
   * the manifest decides which service answers, so a panel reaches only its own extension's
   * service. Left out of the MCP endpoint and the relay like the rest of `extensions.*`.
   */
  panelCall: publicProcedure
    .input(
      z.object({
        extensionId: z.string().min(1).max(64),
        panelId: z.string().min(1).max(64),
        worktreeId: z.string().min(1),
        method: z.string().min(1).max(100),
        params: z.unknown().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const manifest = await extensionService.get(input.extensionId);
      const panel = manifest?.contributes.panels.find((p) => p.id === input.panelId);
      if (!manifest || !panel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `${input.extensionId} has no panel ${input.panelId}`,
        });
      }
      try {
        const result = await pluginHost.callForWorktree(
          panel.capability,
          input.worktreeId,
          input.method,
          input.params ?? {},
        );
        return { result: result ?? null };
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  list: publicProcedure.query(() => extensionService.list()),
  reload: adminProcedure.mutation(() => extensionService.reload()),
});
