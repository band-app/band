import { z } from "zod";
import { browserProfileService } from "../../services/browser-profile-service";
import { cronjobService } from "../../services/cronjob-service";
import { repoService } from "../../services/repo-service";
import { publicProcedure, t } from "../trpc";

/**
 * Repos sub-router — Phase 2 of the 3-tier refactor
 * (`docs/web-architecture.md`, issue #313).
 *
 * Procedures are intentionally thin: each one validates input with Zod,
 * delegates to `RepoService`, and returns. No business logic lives
 * here.
 *
 * The `remove` route is the one place this router composes more than a
 * single service call: removing a repo also has to tear down its
 * repo-scoped cronjobs via `cronjobService.removeForKey`. Cronjobs
 * aren't part of repo state — they live in their own files and
 * scheduler — so the composition happens at the API layer rather than
 * inside `RepoService.remove`. This keeps the cross-domain coupling
 * visible at the entry point and prevents the repo service from
 * reaching into another bounded context. The same pattern will be used
 * when subsequent phases lift worktrees, chats, and tasks; see
 * `docs/web-architecture.md` § "Tier 1: API".
 */
export const reposRouter = t.router({
  list: publicProcedure.query(() => {
    return repoService.list();
  }),

  checkPath: publicProcedure.input(z.object({ path: z.string() })).query(({ input }) => {
    return repoService.checkPath(input.path);
  }),

  gitInit: publicProcedure.input(z.object({ path: z.string() })).mutation(async ({ input }) => {
    await repoService.gitInit(input.path);
  }),

  add: publicProcedure
    .input(z.object({ path: z.string(), label: z.string().optional() }))
    .mutation(async ({ input }) => {
      return repoService.add(input);
    }),

  /**
   * Run `git init` inside a plain repo and flip its kind to "git".
   * See `RepoService.promoteToGit` for the full rationale.
   */
  promoteToGit: publicProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ input }) => {
      return repoService.promoteToGit(input.name);
    }),

  // Sync: `repoService.remove` and `cronjobService.removeForKey` are
  // both synchronous today. If either grows an async path later (e.g.
  // graceful job drain on shutdown), switch this handler to `async` and
  // `await` the call so the promise isn't silently dropped — the response
  // would otherwise return before the cronjob teardown finished and racy
  // `cronjobs.list` reads could see the just-deleted repo's jobs.
  remove: publicProcedure.input(z.object({ name: z.string() })).mutation(({ input }) => {
    repoService.remove(input.name);

    // Clean up repo-scoped cronjobs. Cronjobs live in their own files
    // + scheduler — not repo state — so this teardown is composed at
    // the API layer rather than buried inside `RepoService.remove`.
    cronjobService.removeForKey(input.name);
    // Same for the repo's default browser profile mapping.
    browserProfileService.forgetRepo(input.name);

    return { ok: true };
  }),

  reorder: publicProcedure.input(z.object({ names: z.array(z.string()) })).mutation(({ input }) => {
    repoService.reorder(input.names);
    return { ok: true };
  }),

  updateLabel: publicProcedure
    .input(z.object({ name: z.string(), label: z.string().nullable() }))
    .mutation(({ input }) => {
      repoService.updateLabel(input);
      return { ok: true };
    }),
});

export type ReposRouter = typeof reposRouter;
