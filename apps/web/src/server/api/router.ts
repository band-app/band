/**
 * Root tRPC router for the web server's 3-tier architecture.
 *
 * Per `docs/web-architecture.md`, the API tier lives under
 * `apps/web/src/server/api/`. Each domain (projects, workspaces, chats,
 * tasks, …) owns a sub-router under `apps/web/src/server/api/<domain>/router.ts`
 * and this file merges them via `t.mergeRouters(…)`.
 *
 * Migrated sub-routers so far (each phase removes its keys from the legacy
 * router at `apps/web/src/trpc/router.ts` in the same diff that adds them
 * here, so `t.mergeRouters` always sees disjoint key sets):
 *
 *   - Phase 1 (issue #312): `settings.*`.
 *   - Phase 2 (issue #313): `projects.*`.
 *   - Phase 3 (issue #314): `workspaces.*`.
 *   - Phase 4 (issue #315): `cronjobs.*`.
 *   - Phase 5 (issue #316): `chats.*`, `chatLayout.*`, `browsers.*`,
 *     `browserLayout.*`.
 *   - Phase 7 (issue #318): `terminals/` (exposes `terminal` + `terminalLayout`).
 *
 * Phase 4 landed ahead of Phase 3 because cronjobs is a small, self-contained
 * domain (no workspace-graph dependencies on the legacy router) and was a
 * safer second migration target than workspaces. The phase numbers track
 * issue IDs, not landing order.
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
import { browserLayoutRouter, browsersRouter } from "./browsers/router";
import { chatLayoutRouter, chatsRouter } from "./chats/router";
import { cronjobsRouter } from "./cronjobs/router";
import { projectsRouter } from "./projects/router";
import { settingsRouter } from "./settings/router";
import { terminalsRouters } from "./terminals/router";
import { t } from "./trpc";
import { workspacesRouter } from "./workspaces/router";

// INVARIANT: the legacy router (`apps/web/src/trpc/router.ts`) must not
// contain any key that this file also defines (`settings`, `projects`,
// `workspaces`, `cronjobs`, `chats`, `chatLayout`, `browsers`,
// `browserLayout`, `terminal`, `terminalLayout`, …).
// `t.mergeRouters` accepts two routers and silently picks last-write-wins
// for duplicate keys, so a stray legacy entry would mask the migrated
// router without a build error. Each phase of the 3-tier migration adds a
// key here and removes it from the legacy router in the same diff; the
// invariant must hold for every key composed below.
//
// Migrated keys so far:
//   - `settings`        (Phase 1, issue #312)
//   - `projects`        (Phase 2, issue #313)
//   - `workspaces`      (Phase 3, issue #314)
//   - `cronjobs`        (Phase 4, issue #315)
//   - `chats`           (Phase 5, issue #316)
//   - `chatLayout`      (Phase 5, issue #316)
//   - `browsers`        (Phase 5, issue #316)
//   - `browserLayout`   (Phase 5, issue #316)
//   - `terminal`        (Phase 7, issue #318)
//   - `terminalLayout`  (Phase 7, issue #318)
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
//   - The `workspaces.create` / `workspaces.remove` / `workspaces.runScript`
//     tests in `apps/web/tests/trpc.test.ts` exercise the migrated
//     workspaces sub-router, so a regression that masks the new router
//     with a stale legacy entry trips at least one of those assertions.
//   - `apps/web/tests/workspace-remove-detached.test.ts` pins the
//     detached-HEAD branch of `workspaces.remove` end-to-end.
//   - `apps/web/tests/cronjobs.test.ts` exercises `cronjobs.*` end-to-end,
//     so a regression that masks the migrated `cronjobsRouter` with a
//     stale legacy entry trips one of those assertions.
//   - `apps/web/tests/cold-start.test.ts` and
//     `apps/web/tests/chat-labels.test.ts` cover `chats.*` / `browsers.*`
//     / `chats.create` / `chats.list` / `chats.update`, so a regression
//     that masks the migrated chats/browsers sub-routers trips the
//     corresponding describe block.
//   - `apps/web/tests/terminal-ws.test.ts` (and any other terminal-*
//     integration tests) hit the merged router through the same /trpc
//     endpoint, so a regression that masks the migrated terminal
//     sub-routers with a stale legacy entry trips at least one of those
//     assertions.
export const appRouter = t.mergeRouters(
  legacyAppRouter,
  t.router({
    settings: settingsRouter,
    projects: projectsRouter,
    workspaces: workspacesRouter,
    cronjobs: cronjobsRouter,
    chats: chatsRouter,
    chatLayout: chatLayoutRouter,
    browsers: browsersRouter,
    browserLayout: browserLayoutRouter,
    ...terminalsRouters,
  }),
);

export type AppRouter = typeof appRouter;
