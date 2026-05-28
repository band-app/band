import { z } from "zod";
import { stopJobsForKey } from "../../../lib/cronjob-scheduler";
import { deleteCronjobFile } from "../../../lib/cronjob-store";
import { projectService } from "../../services/project-service";
import { publicProcedure, t } from "../trpc";

/**
 * Projects sub-router — Phase 2 of the 3-tier refactor
 * (`docs/web-architecture.md`, issue #313).
 *
 * Procedures are intentionally thin: each one validates input with Zod,
 * delegates to `ProjectService`, and returns. No business logic lives
 * here.
 *
 * The `remove` route is the one place this router composes more than a
 * single service call: removing a project also has to tear down its
 * project-scoped cronjobs (`stopJobsForKey` + `deleteCronjobFile`).
 * Cronjobs aren't part of project state — they live in their own files
 * and scheduler — so the composition happens at the API layer rather
 * than inside `ProjectService.remove`. This keeps the cross-domain
 * coupling visible at the entry point and prevents the project service
 * from reaching into another bounded context. The same pattern will be
 * used when subsequent phases lift workspaces, chats, and tasks; see
 * `docs/web-architecture.md` § "Tier 1: API".
 *
 * Transitional caveat: the `stopJobsForKey` / `deleteCronjobFile` imports
 * still reach into `lib/cronjob-*` directly because cronjobs haven't been
 * migrated into the 3-tier shape yet. Once `CronjobService` lands (see
 * `docs/web-architecture.md` § "Dependency Direction"), replace the two
 * raw calls with a single `cronjobService.stopAllForProject(name)` so the
 * router only composes services.
 */
export const projectsRouter = t.router({
  list: publicProcedure.query(() => {
    return projectService.list();
  }),

  checkPath: publicProcedure.input(z.object({ path: z.string() })).query(({ input }) => {
    return projectService.checkPath(input.path);
  }),

  gitInit: publicProcedure.input(z.object({ path: z.string() })).mutation(async ({ input }) => {
    await projectService.gitInit(input.path);
  }),

  add: publicProcedure
    .input(z.object({ path: z.string(), label: z.string().optional() }))
    .mutation(async ({ input }) => {
      return projectService.add(input);
    }),

  /**
   * Run `git init` inside a plain project and flip its kind to "git".
   * See `ProjectService.promoteToGit` for the full rationale.
   */
  promoteToGit: publicProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ input }) => {
      return projectService.promoteToGit(input.name);
    }),

  // Sync: `projectService.remove`, `stopJobsForKey`, and
  // `deleteCronjobFile` are all synchronous today. If any of them grows
  // an async path later (e.g. graceful job drain on shutdown), switch
  // this handler to `async` and `await` the call so the promise isn't
  // silently dropped — the response would otherwise return before the
  // cronjob teardown finished and racy `cronjobs.list` reads could see
  // the just-deleted project's jobs.
  remove: publicProcedure.input(z.object({ name: z.string() })).mutation(({ input }) => {
    projectService.remove(input.name);

    // Clean up project-scoped cronjobs. Cronjobs live in their own files
    // + scheduler — not project state — so this teardown is composed at
    // the API layer rather than buried inside `ProjectService.remove`.
    stopJobsForKey(input.name);
    deleteCronjobFile(input.name);

    return { ok: true };
  }),

  reorder: publicProcedure.input(z.object({ names: z.array(z.string()) })).mutation(({ input }) => {
    projectService.reorder(input.names);
    return { ok: true };
  }),

  updateLabel: publicProcedure
    .input(z.object({ name: z.string(), label: z.string().nullable() }))
    .mutation(({ input }) => {
      projectService.updateLabel(input);
      return { ok: true };
    }),
});

export type ProjectsRouter = typeof projectsRouter;
