import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ExtensionInstallError, extensionService } from "../../services/extension-service";
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
  list: publicProcedure.query(() => extensionService.list()),
  reload: adminProcedure.mutation(() => extensionService.reload()),
});
