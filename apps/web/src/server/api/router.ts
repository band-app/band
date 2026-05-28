/**
 * Root tRPC router for the web server's 3-tier architecture.
 *
 * Per `docs/web-architecture.md`, the API tier lives under
 * `apps/web/src/server/api/`. Each domain (projects, workspaces, chats,
 * tasks, …) owns a sub-router under `apps/web/src/server/api/<domain>/router.ts`
 * and this file merges them via `t.mergeRouters(…)`.
 *
 * Migration order:
 *   - Phase 1 (issue #312): `settings/`.
 *   - Phase 2 (issue #313): `projects/`.
 *   - Phase 4 (issue #315): `cronjobs/`.
 *
 * The rest of the procedures still live in the legacy
 * `apps/web/src/trpc/router.ts`; we merge that legacy router with every
 * migrated sub-router so the public tRPC surface stays identical during
 * the multi-phase migration. Subsequent phases will lift more sub-routers
 * out of the legacy file and pull them in here one at a time.
 *
 * Every router (legacy + migrated) must be built with the same tRPC
 * builder (see `./trpc.ts`) for `mergeRouters` to accept them.
 */

import { appRouter as legacyAppRouter } from "../../trpc/router";
import { cronjobsRouter } from "./cronjobs/router";
import { projectsRouter } from "./projects/router";
import { settingsRouter } from "./settings/router";
import { t } from "./trpc";

// INVARIANT: the legacy router (`apps/web/src/trpc/router.ts`) must not
// contain any key that this file also defines (`settings`, `projects`,
// `cronjobs`, …). `t.mergeRouters` accepts two routers and silently picks
// last-write-wins for duplicate keys, so a stray legacy entry would mask
// the migrated router without a build error. Each phase of the 3-tier
// migration adds a key here and removes it from the legacy router in the
// same diff; the invariant must hold for every key composed below.
//
// Live guards:
//   - `tRPC — settings CRUD` in `apps/web/tests/trpc.test.ts` exercises
//     `settings.get` and `settings.update` end-to-end through the merged
//     router, catching a regression that masks the migrated
//     `settingsRouter` with a stale legacy entry.
//   - The wider tRPC test file (`apps/web/tests/trpc.test.ts`) and
//     `apps/web/tests/plain-projects.test.ts` exercise the projects
//     sub-router, so a duplicate-key regression on `projects.*` trips
//     them via the same path.
//   - `apps/web/tests/cronjobs.test.ts` exercises `cronjobs.*` end-to-end,
//     so a regression that masks the migrated `cronjobsRouter` with a
//     stale legacy entry trips one of those assertions.
export const appRouter = t.mergeRouters(
  legacyAppRouter,
  t.router({
    settings: settingsRouter,
    projects: projectsRouter,
    cronjobs: cronjobsRouter,
  }),
);

export type AppRouter = typeof appRouter;
