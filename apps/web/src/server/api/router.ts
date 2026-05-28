/**
 * Root tRPC router for the web server's 3-tier architecture.
 *
 * Per `docs/web-architecture.md`, the API tier lives under
 * `apps/web/src/server/api/`. Each domain (projects, workspaces, chats,
 * tasks, …) owns a sub-router under `apps/web/src/server/api/<domain>/router.ts`
 * and this file merges them via `t.mergeRouters(…)`.
 *
 * **Phase 8 (issue #319) completed the migration.** The legacy router at
 * `apps/web/src/trpc/router.ts` and the supporting `trpc/context.ts` /
 * `trpc/openapi.ts` were deleted; every sub-router now lives under
 * `server/api/<domain>/router.ts`. The merge below is the single source of
 * truth for the tRPC wire surface, and there is no longer a "legacy half"
 * to compose against.
 *
 * Migrated sub-routers by phase (issue numbers track when each domain was
 * lifted, not landing order):
 *
 *   - Phase 1 (issue #312): `settings.*`.
 *   - Phase 2 (issue #313): `projects.*`.
 *   - Phase 3 (issue #314): `workspaces.*`.
 *   - Phase 4 (issue #315): `cronjobs.*`.
 *   - Phase 5 (issue #316): `chats.*`, `chatLayout.*`, `browsers.*`,
 *     `browserLayout.*`.
 *   - Phase 6 (issue #317): `tasks.*`, `sessions.*`.
 *   - Phase 7 (issue #318): `terminals/` (exposes `terminal` + `terminalLayout`).
 *   - Phase 7.5 (issue #517): `cli.*`, `hooks.*`, `host.*`, `browserHost.*`,
 *     `editor.*`, `tunnel.*`, `prereqs.*`, `skills.*`, `modes.*`,
 *     `models.*`, `statuses.*`, `status.*`.
 *   - Phase 8 (issue #319): the final inline sub-routers — `workspace.*`
 *     (singular: file ops, diff, search, git commands, agent switching),
 *     `chat.*` (singular: approval-answer pass-through), `history.*`
 *     (per-workspace browser history), and `queue.*` (queued message
 *     store). With these gone, the legacy `apps/web/src/trpc/` directory
 *     was removed entirely.
 *
 * Every sub-router must be built with the same tRPC builder (see
 * `./trpc.ts`) for `mergeRouters` to accept them.
 */

import { browserHostRouter, hostRouter } from "./browser-host/router";
import { browserLayoutRouter, browsersRouter } from "./browsers/router";
import { chatRouter } from "./chat/router";
import { chatLayoutRouter, chatsRouter } from "./chats/router";
import { cliRouter } from "./cli/router";
import { cronjobsRouter } from "./cronjobs/router";
import { editorRouter } from "./editor/router";
import { historyRouter } from "./history/router";
import { hooksRouter } from "./hooks/router";
import { modelsRouter } from "./models/router";
import { modesRouter } from "./modes/router";
import { prereqsRouter } from "./prereqs/router";
import { projectsRouter } from "./projects/router";
import { queueRouter } from "./queue/router";
import { sessionsRouter } from "./sessions/router";
import { settingsRouter } from "./settings/router";
import { skillsRouter } from "./skills/router";
import { statusesRouter, statusRouter } from "./statuses/router";
import { systemRouter } from "./system/router";
import { tasksRouter } from "./tasks/router";
import { terminalsRouters } from "./terminals/router";
import { t } from "./trpc";
import { tunnelRouter } from "./tunnel/router";
import { workspaceRouter } from "./workspace/router";
import { workspacesRouter } from "./workspaces/router";

export const appRouter = t.router({
  settings: settingsRouter,
  projects: projectsRouter,
  workspaces: workspacesRouter,
  workspace: workspaceRouter,
  cronjobs: cronjobsRouter,
  chats: chatsRouter,
  chatLayout: chatLayoutRouter,
  chat: chatRouter,
  browsers: browsersRouter,
  browserLayout: browserLayoutRouter,
  tasks: tasksRouter,
  sessions: sessionsRouter,
  ...terminalsRouters,
  cli: cliRouter,
  hooks: hooksRouter,
  host: hostRouter,
  browserHost: browserHostRouter,
  editor: editorRouter,
  tunnel: tunnelRouter,
  prereqs: prereqsRouter,
  skills: skillsRouter,
  modes: modesRouter,
  models: modelsRouter,
  statuses: statusesRouter,
  status: statusRouter,
  history: historyRouter,
  queue: queueRouter,
  // `system` is the new home for the legacy `servicesRouter`. The wire
  // surface is preserved by mounting it under the original `services`
  // key so every existing client (TunnelDialog, ResourcesPage, the
  // desktop activity monitor, the CLI) keeps calling `trpc.services.*`
  // without change. The internal name (`system`) follows the 3-tier
  // convention; the public key (`services`) follows the contract.
  services: systemRouter,
});

export type AppRouter = typeof appRouter;
