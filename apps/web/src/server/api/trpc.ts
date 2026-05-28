import { initTRPC } from "@trpc/server";
import type { Context } from "./context";

/**
 * Shared tRPC builder for the 3-tier architecture.
 *
 * Every sub-router under `server/api/*` must import `t` and
 * `publicProcedure` from this module. tRPC's `mergeRouters` only accepts
 * routers built from the same builder instance, so creating a second
 * `initTRPC.context<Context>().create()` anywhere else would silently
 * break the merge in `server/api/router.ts`.
 */
export const t = initTRPC.context<Context>().create();

export const publicProcedure = t.procedure;
