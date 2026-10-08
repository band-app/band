import { z } from "zod";
import { browserProfileService } from "../../services/browser-profile-service";
import { cronjobService } from "../../services/cronjob-service";
import { projectService } from "../../services/project-service";
import { repoService } from "../../services/repo-service";
import { adminProcedure, publicProcedure, t } from "../trpc";
import { repoErrorToTrpc } from "./errors";

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

  gitInit: publicProcedure.input(z.object({ path: z.string() })).mutation(async ({ input }) => {
    await repoService.gitInit(input.path);
  }),

  add: publicProcedure
    .input(z.object({ path: z.string(), label: z.string().optional() }))
    .mutation(async ({ input }) => {
      return repoService.add(input);
    }),

  /**
   * Adds the repo that a folder on a host holds (the folder picker of a worker). The hub stores
   * the URL and default branch the host reads there, and the host keeps the folder as its mapping
   * for that URL. A folder outside the host's roots answers PRECONDITION_FAILED ("OUTSIDE_ROOTS:")
   * until the call is repeated with `addRoot: true`, which the UI sends after the user confirmed.
   */
  addFromWorker: adminProcedure
    .input(
      z.object({
        hostId: z.string().min(1),
        path: z.string().min(1),
        name: z.string().min(1).max(100).optional(),
        label: z.string().optional(),
        addRoot: z.boolean().optional(),
        project: z.string().min(1).max(200).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await repoService.addFromWorker(input);
      } catch (err) {
        throw repoErrorToTrpc(err);
      }
    }),

  /**
   * Adds a repo by its remote URL. A worker clones it when the first worktree lands there.
   * Without `defaultBranch` the hub asks the remote.
   */
  addByUrl: adminProcedure
    .input(
      z.object({
        remoteUrl: z.string().trim().min(1).max(500),
        defaultBranch: z.string().trim().min(1).max(200).optional(),
        name: z.string().min(1).max(100).optional(),
        label: z.string().optional(),
        project: z.string().min(1).max(200).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await repoService.addByUrl(input);
      } catch (err) {
        throw repoErrorToTrpc(err);
      }
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
    // And its place in any project.
    projectService.forgetRepo(input.name);

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
