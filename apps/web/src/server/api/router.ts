/**
 * Root tRPC router for the web server's 3-tier architecture.
 *
 * Per `docs/web-architecture.md`, the API tier lives under
 * `apps/web/src/server/api/`. Each domain (projects, workspaces, chats,
 * tasks, …) owns a sub-router under `apps/web/src/server/api/<domain>/router.ts`
 * and this file merges them via `t.mergeRouters(…)`.
 *
 * Phase 1 (issue #312) migrates the first sub-router (`settings/`) into the
 * new 3-tier shape. The rest of the procedures still live in the legacy
 * `apps/web/src/trpc/router.ts`; we merge that legacy router with the
 * migrated `settingsRouter` so the public tRPC surface stays identical
 * during the multi-phase migration. Subsequent phases will lift more
 * sub-routers out of the legacy file and pull them in here one at a time.
 *
 * Both routers must be built with the same tRPC builder (see `./trpc.ts`)
 * for `mergeRouters` to accept them.
 */

import { appRouter as legacyAppRouter } from "../../trpc/router";
import { settingsRouter } from "./settings/router";
import { t } from "./trpc";

// INVARIANT: the legacy router (`apps/web/src/trpc/router.ts`) must not contain
// a `settings:` key. `t.mergeRouters` accepts two routers and silently picks
// last-write-wins for duplicate keys, so a stray legacy entry would mask the
// migrated `settingsRouter` without a build error. Each subsequent phase of
// the 3-tier migration adds a key here and removes it from the legacy router
// in the same diff; the invariant must hold for every key composed below.
export const appRouter = t.mergeRouters(legacyAppRouter, t.router({ settings: settingsRouter }));

export type AppRouter = typeof appRouter;
