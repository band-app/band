/**
 * `clientState.*` — small UI values the dashboard shares across devices
 * (open center tabs, drafts, panel layout). Thin: validates input and
 * delegates to `ClientStateService`.
 *
 * `list` returns one workspace's entries (or the global ones for
 * `workspaceId: null`) for the caller's device type. `set` and `delete` take
 * the version the client last saw and answer `{ ok: false, entry }` with the
 * current row when it is stale, instead of overwriting it.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { ClientStateValueTooLargeError } from "../../errors";
import { clientStateService } from "../../services/client-state-service";
import { publicProcedure, t } from "../trpc";

const key = z.string().min(1).max(512);
const scope = z.enum(["all", "desktop", "mobile"]);
const workspaceId = z.string().min(1).max(512).nullable();
const baseVersion = z.number().int().min(0);
const clientId = z.string().min(1).max(100);

export const clientStateRouter = t.router({
  list: publicProcedure
    .input(z.object({ workspaceId, deviceType: z.enum(["desktop", "mobile"]) }))
    .query(({ input }) => {
      return { entries: clientStateService.list(input.workspaceId, input.deviceType) };
    }),

  set: publicProcedure
    .input(z.object({ key, scope, workspaceId, value: z.unknown(), baseVersion, clientId }))
    .mutation(({ input }) => {
      try {
        return clientStateService.set(input);
      } catch (err) {
        if (err instanceof ClientStateValueTooLargeError) {
          throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: err.message });
        }
        throw err;
      }
    }),

  delete: publicProcedure
    .input(z.object({ key, scope, workspaceId, baseVersion, clientId }))
    .mutation(({ input }) => {
      return clientStateService.delete(input);
    }),
});

export type ClientStateRouter = typeof clientStateRouter;
