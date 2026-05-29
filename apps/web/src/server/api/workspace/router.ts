import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { diffService } from "../../services/diff-service";
import { subscribeToFileChanges } from "../../services/file-watcher";
import { filesService } from "../../services/files-service";
import { FormatterError, formatFile } from "../../services/formatter";
import { searchService } from "../../services/search-service";
import { terminalService } from "../../services/terminal-service";
import { workspaceService } from "../../services/workspace-service";
import { publicProcedure, t } from "../trpc";

/**
 * Workspace (singular) sub-router — per-workspace operations: file CRUD,
 * search, diff, git pull/push/commit, agent switching, format. The router
 * is validation + delegation only (issue #535, follow-up 1): every line of
 * business logic lives behind a service-tier seam:
 *
 *   - `filesService`  → file CRUD + path-traversal / .git guards.
 *   - `searchService` → file-name fuzzy search and ripgrep content search.
 *   - `diffService`   → branch listing, diff, file diff, revert.
 *   - `workspaceService` → gitPull/gitPush/gitCommit (workspaceId-keyed),
 *     generateCommitMessage, switchAgent.
 *   - `formatFile`    → Prettier wrapper (services/formatter.ts).
 *   - `terminalService.getWorkspaceConfig` → per-workspace terminal config.
 *   - `subscribeToFileChanges` → file-watcher subscription.
 *
 * The plural `workspaces.*` namespace handles workspace lifecycle
 * (create, remove, runScript, gitPull/Push by `(project, branch)`); see
 * `api/workspaces/router.ts`. Every existing client (FileBrowser,
 * ChangesView, CommitDialog, search popups, agent picker) speaks
 * `trpc.workspace.*`.
 */

/**
 * Branch names accepted by diff/revert procedures. Forbids leading `-` so the
 * value can't be interpreted by git as a flag (e.g. `--upload-pack=`, `--exec=`)
 * when it lands in `git merge-base <branch> HEAD` or `git checkout <branch> -- file`.
 * The trpc server is local-only, but `execFile` doesn't pass through a shell, so
 * a leading-dash check is enough to close the only realistic injection vector.
 */
const compareBranchSchema = z
  .string()
  .min(1)
  .regex(/^[^-]/, "branch name must not start with '-'")
  .optional();

/**
 * Re-throw an error from a service-tier call. Currently a pass-through
 * — services raise plain `Error` / `WorkspaceNotFoundError` instances
 * and the tRPC adapter surfaces them as HTTP 500. The legacy wire
 * contract for this router is 500-on-any-error (the trpc integration
 * tests pin it), matching the project-tier `ProjectNotFoundError` /
 * `PlainProjectError` handling in `api/workspaces/router.ts`. Promoting
 * `WorkspaceNotFoundError` to a 404 is a separate change that needs to
 * land alongside the pinned-test update.
 */
function rethrow(err: unknown): never {
  throw err;
}

export const workspaceRouter = t.router({
  getTerminalConfig: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(({ input }) => {
      return { config: terminalService.getWorkspaceConfig(input.workspaceId) };
    }),

  /**
   * Format the supplied `content` using Prettier as if it were the file at
   * `filePath` inside `workspaceId`. The procedure is pure — it does not
   * read or write the file on disk. The client passes in the live editor
   * buffer and applies the returned `formatted` string back to the editor.
   * Persistence is the caller's responsibility via `workspace.saveFile`.
   *
   * Returns `{ skipped: true, reason }` when Prettier has no parser for
   * the file's extension (or it's covered by `.prettierignore`). Editors
   * fire this off Shift+Alt+F without checking the file type first, so a
   * soft skip is the right outcome for unsupported files rather than a
   * surfaced error.
   *
   * Auth: enforced at the transport layer (the `band_token` cookie gates
   * the WebSocket upgrade and HTTP requests in start-server.ts) — same
   * pattern as the rest of `workspaceRouter`.
   */
  formatFile: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        filePath: z.string().min(1),
        // 1 MB ceiling — covers every realistic source file (the largest
        // human-authored .ts in the world is well under 500 KB) and stops a
        // pathological caller from blocking the event loop with a multi-MB
        // string while Prettier churns on it.
        content: z.string().max(1_000_000),
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = workspaceService.resolve(input.workspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Workspace ${input.workspaceId} not found`,
        });
      }
      try {
        return await formatFile(workspace.worktree.path, input.filePath, input.content);
      } catch (err) {
        if (err instanceof FormatterError) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: err.message,
            cause: err,
          });
        }
        throw err;
      }
    }),

  /**
   * Subscribe to external file-system changes inside a single workspace.
   * The watcher is started on demand for that workspace and torn down when
   * the last subscriber disconnects, so we don't keep OS watch handles
   * open on every worktree the user has ever added (see issue #384).
   *
   * Yields one event per coalesced (parentDir) change; `path` is the
   * workspace-relative parent directory ("" for the worktree root). The
   * FileBrowser uses it as a cache invalidation key.
   *
   * Auth: enforced at the transport layer (the `band_token` cookie gates
   * the WebSocket upgrade and HTTP requests in start-server.ts), so no
   * per-procedure guard is needed — consistent with the rest of
   * `workspaceRouter`.
   */
  fileChanges: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .subscription(async function* (opts) {
      // We rely on the tRPC adapter supplying a cancellation signal — both
      // the WebSocket and HTTP transports we use today set it on every
      // subscription. Fail loud if a future adapter omits it rather than
      // silently parking this generator forever.
      if (!opts.signal) {
        throw new Error(
          "workspace.fileChanges requires a cancellable subscription (opts.signal missing)",
        );
      }
      const signal = opts.signal;

      const queue: { path: string }[] = [];
      let resolve: (() => void) | null = null;
      // Set to true if the underlying watcher dies — the generator then
      // finishes cleanly so the client sees the stream complete instead
      // of waiting forever for an event from a dead handle.
      let watcherClosed = false;

      const unsubscribe = subscribeToFileChanges(opts.input.workspaceId, (path) => {
        if (path === null) {
          watcherClosed = true;
        } else {
          queue.push({ path });
        }
        resolve?.();
      });

      // Only unpark the generator here; the watcher tear-down lives in
      // `finally` so we don't risk a double-unsubscribe if abort fires
      // before the loop's last cleanup.
      const onAbort = () => resolve?.();
      signal.addEventListener("abort", onAbort);

      try {
        while (!signal.aborted && !watcherClosed) {
          while (queue.length > 0) {
            yield queue.shift()!;
          }
          if (signal.aborted || watcherClosed) break;
          await new Promise<void>((r) => {
            resolve = r;
            // Close the race where abort/watcher-close fires between
            // `resolve = null` and entering this executor: in that
            // window the upstream `resolve?.()` was a no-op, so wake
            // immediately ourselves.
            if (signal.aborted || watcherClosed) r();
          });
          resolve = null;
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        unsubscribe();
      }
    }),

  listBranches: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input }) => {
      try {
        return await diffService.listBranches(input.workspaceId);
      } catch (err) {
        rethrow(err);
      }
    }),

  getDiff: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        contextLines: z.number().int().min(0).max(99999).optional(),
        diffMode: z.enum(["uncommitted", "branch"]).optional(),
        compareBranch: compareBranchSchema,
      }),
    )
    .query(async ({ input }) => {
      try {
        return await diffService.getDiff(input.workspaceId, {
          contextLines: input.contextLines,
          diffMode: input.diffMode,
          compareBranch: input.compareBranch,
        });
      } catch (err) {
        rethrow(err);
      }
    }),

  getDiffSummary: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        diffMode: z.enum(["uncommitted", "branch"]).optional(),
        compareBranch: compareBranchSchema,
      }),
    )
    .query(async ({ input }) => {
      try {
        return await diffService.getDiffSummary(input.workspaceId, {
          diffMode: input.diffMode,
          compareBranch: input.compareBranch,
        });
      } catch (err) {
        rethrow(err);
      }
    }),

  getFileDiff: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        filePath: z.string(),
        mergeBase: z.string(),
        contextLines: z.number().int().min(0).max(99999).optional(),
      }),
    )
    .query(async ({ input }) => {
      try {
        return await diffService.getFileDiff(input.workspaceId, {
          filePath: input.filePath,
          mergeBase: input.mergeBase,
          contextLines: input.contextLines,
        });
      } catch (err) {
        rethrow(err);
      }
    }),

  revertFile: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        filePath: z.string(),
        diffMode: z.enum(["uncommitted", "branch"]),
        compareBranch: compareBranchSchema,
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await diffService.revertFile(input.workspaceId, {
          filePath: input.filePath,
          diffMode: input.diffMode,
          compareBranch: input.compareBranch,
        });
      } catch (err) {
        rethrow(err);
      }
    }),

  gitPull: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      try {
        return await workspaceService.gitPullByWorkspaceId(input.workspaceId);
      } catch (err) {
        rethrow(err);
      }
    }),

  gitPush: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      try {
        return await workspaceService.gitPushByWorkspaceId(input.workspaceId);
      } catch (err) {
        rethrow(err);
      }
    }),

  gitCommit: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        message: z.string().min(1, "commit message is required"),
        body: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await workspaceService.gitCommit(input.workspaceId, {
          message: input.message,
          body: input.body,
        });
      } catch (err) {
        rethrow(err);
      }
    }),

  generateCommitMessage: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      try {
        return await workspaceService.generateCommitMessage(input.workspaceId);
      } catch (err) {
        rethrow(err);
      }
    }),

  listFiles: publicProcedure
    .input(z.object({ workspaceId: z.string(), path: z.string().default("") }))
    .query(async ({ input }) => {
      try {
        return await filesService.listFiles(input.workspaceId, input.path);
      } catch (err) {
        rethrow(err);
      }
    }),

  getFile: publicProcedure
    .input(z.object({ workspaceId: z.string(), path: z.string() }))
    .query(async ({ input }) => {
      try {
        return await filesService.getFile(input.workspaceId, input.path);
      } catch (err) {
        rethrow(err);
      }
    }),

  saveFile: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        path: z.string().min(1),
        content: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await filesService.saveFile(input.workspaceId, input.path, input.content);
      } catch (err) {
        rethrow(err);
      }
    }),

  createFile: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        path: z.string().min(1),
        content: z.string().default(""),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await filesService.createFile(input.workspaceId, input.path, input.content);
      } catch (err) {
        rethrow(err);
      }
    }),

  createDirectory: publicProcedure
    .input(z.object({ workspaceId: z.string(), path: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        return await filesService.createDirectory(input.workspaceId, input.path);
      } catch (err) {
        rethrow(err);
      }
    }),

  deletePath: publicProcedure
    .input(z.object({ workspaceId: z.string(), path: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        return await filesService.deletePath(input.workspaceId, input.path);
      } catch (err) {
        rethrow(err);
      }
    }),

  renamePath: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        fromPath: z.string().min(1),
        toPath: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await filesService.renamePath(input.workspaceId, input.fromPath, input.toPath);
      } catch (err) {
        rethrow(err);
      }
    }),

  copyPath: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        fromPath: z.string().min(1),
        toPath: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await filesService.copyPath(input.workspaceId, input.fromPath, input.toPath);
      } catch (err) {
        rethrow(err);
      }
    }),

  searchFiles: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        query: z.string().default(""),
        limit: z.number().default(50),
      }),
    )
    .query(async ({ input }) => {
      try {
        return await searchService.searchFiles(input.workspaceId, {
          query: input.query,
          limit: input.limit,
        });
      } catch (err) {
        rethrow(err);
      }
    }),

  searchContent: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        query: z.string().min(1),
        caseSensitive: z.boolean().default(false),
        wholeWord: z.boolean().default(false),
        regex: z.boolean().default(false),
        limit: z.number().default(100),
      }),
    )
    .query(async ({ input }) => {
      try {
        return await searchService.searchContent(input.workspaceId, {
          query: input.query,
          caseSensitive: input.caseSensitive,
          wholeWord: input.wholeWord,
          regex: input.regex,
          limit: input.limit,
        });
      } catch (err) {
        rethrow(err);
      }
    }),

  switchAgent: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        agentId: z.string(),
        chatId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await workspaceService.switchAgent(input);
      } catch (err) {
        rethrow(err);
      }
    }),
});

export type WorkspaceRouter = typeof workspaceRouter;
