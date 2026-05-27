/**
 * Root tRPC router for the web server's 3-tier architecture.
 *
 * Per `docs/web-architecture.md`, the API tier lives under
 * `apps/web/src/server/api/`. Each domain (projects, workspaces, chats,
 * tasks, …) will eventually own a sub-router under
 * `apps/web/src/server/api/<domain>/router.ts` and this file will merge
 * them via `t.router({ … })`.
 *
 * Phase 0 (issue #311) only scaffolds the directory and wires the entry
 * point. The full router still lives at `apps/web/src/trpc/router.ts` —
 * we re-export it from here so `start-server.ts` (and any other entry
 * point) can import from the new location without breaking anything.
 * Subsequent phases will move procedures into per-domain sub-routers
 * and replace this re-export with a real `t.router({ … })` composition.
 */

export { type AppRouter, appRouter } from "../../trpc/router.ts";
