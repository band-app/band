import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { diffService } from "../../services/diff-service";
import { editorService } from "../../services/editor-service";
import { filesService } from "../../services/files-service";
import { FormatterError } from "../../services/formatter";
import { searchService } from "../../services/search-service";
import { terminalService } from "../../services/terminal-service";
import { WorkspaceNotFoundError, workspaceService } from "../../services/workspace-service";
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
 *   - `editorService` → file watcher subscription + Prettier formatFile.
 *   - `terminalService.getWorkspaceConfig` → per-workspace terminal config.
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
 * `mergeBase` is the SHA returned by `getDiffSummary` and threaded
 * back into `getFileDiff` as a revision argument to `git diff`. Pin to
 * a 40-character hex SHA: this closes the leading-dash injection
 * vector (`--exec=`, `--output=…`) AND enforces that `getFileDiff`
 * operates on the same revision shape `getDiffSummary` returned. Real
 * merge-base SHAs from git are always 40-char hex; symbolic refs like
 * `HEAD`, `main`, or `@{-1}` are rejected so a client can't accidentally
 * desync from the summary's view of the world.
 */
const mergeBaseSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/i, "mergeBase must be a 40-character hex SHA");

/**
 * Wire-contract note: every workspace-tier service error (including
 * `WorkspaceNotFoundError`) bubbles as a plain `Error` and the tRPC
 * adapter surfaces it as HTTP 500. That's pinned by the trpc
 * integration tests in `tests/trpc.test.ts` and mirrors the project-
 * tier `ProjectNotFoundError` / `PlainProjectError` handling in
 * `api/workspaces/router.ts`. Promoting `WorkspaceNotFoundError` to a
 * tRPC `NOT_FOUND` (404) is a separate change that needs to land
 * alongside the pinned-test update.
 *
 *
 * TODO(#535-followup): the `WorkspaceNotFoundError` → 404 migration
 * should cover `listBranches`, `getDiff`, `getDiffSummary`, `getFile`,
 * `getFileDiff`, `revertFile`, the `git*` mutations, the `*Path` /
 * `*File` / `*Directory` file CRUD, and the two search procedures —
 * any procedure that goes through `WorkspaceService.resolve` or its
 * `WorkspaceNotFoundError`-throwing siblings. When that lands, the
 * `tests/trpc.test.ts` cases that pin status=500 for "unknown
 * workspace" need to flip to 404 in the same change.
 *
 * `formatFile` and `switchAgent` are the historical exceptions — both
 * threw `TRPCError({code: "NOT_FOUND"})` for the workspace-lookup
 * branch even before the follow-up-1 split. Both kept as-is to
 * preserve the pre-existing wire contract; a future cleanup can align
 * the two against the rest of the router.
 */
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
      // Single workspace lookup happens inside editorService.formatFile;
      // a WorkspaceNotFoundError propagates up here and maps to 404,
      // matching the pre-#535 wire contract. FormatterError maps to 400.
      try {
        return await editorService.formatFile(input.workspaceId, input.filePath, input.content);
      } catch (err) {
        if (err instanceof WorkspaceNotFoundError) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
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

      const unsubscribe = editorService.subscribeToFileChanges(opts.input.workspaceId, (path) => {
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
    .query(({ input }) => diffService.listBranches(input.workspaceId)),

  getDiff: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        contextLines: z.number().int().min(0).max(99999).optional(),
        diffMode: z.enum(["uncommitted", "branch"]).optional(),
        compareBranch: compareBranchSchema,
      }),
    )
    .query(({ input }) =>
      diffService.getDiff(input.workspaceId, {
        contextLines: input.contextLines,
        diffMode: input.diffMode,
        compareBranch: input.compareBranch,
      }),
    ),

  getDiffSummary: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        diffMode: z.enum(["uncommitted", "branch"]).optional(),
        compareBranch: compareBranchSchema,
      }),
    )
    .query(({ input }) =>
      diffService.getDiffSummary(input.workspaceId, {
        diffMode: input.diffMode,
        compareBranch: input.compareBranch,
      }),
    ),

  getFileDiff: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        filePath: z.string().min(1),
        mergeBase: mergeBaseSchema,
        contextLines: z.number().int().min(0).max(99999).optional(),
      }),
    )
    .query(({ input }) =>
      diffService.getFileDiff(input.workspaceId, {
        filePath: input.filePath,
        mergeBase: input.mergeBase,
        contextLines: input.contextLines,
      }),
    ),

  revertFile: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        filePath: z.string().min(1),
        diffMode: z.enum(["uncommitted", "branch"]),
        compareBranch: compareBranchSchema,
      }),
    )
    .mutation(({ input }) =>
      diffService.revertFile(input.workspaceId, {
        filePath: input.filePath,
        diffMode: input.diffMode,
        compareBranch: input.compareBranch,
      }),
    ),

  gitPull: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(({ input }) => workspaceService.gitPullByWorkspaceId(input.workspaceId)),

  gitPush: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(({ input }) => workspaceService.gitPushByWorkspaceId(input.workspaceId)),

  gitCommit: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        message: z.string().min(1, "commit message is required"),
        body: z.string().optional(),
      }),
    )
    .mutation(({ input }) =>
      workspaceService.gitCommit(input.workspaceId, {
        message: input.message,
        body: input.body,
      }),
    ),

  generateCommitMessage: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(({ input }) => workspaceService.generateCommitMessage(input.workspaceId)),

  listFiles: publicProcedure
    .input(z.object({ workspaceId: z.string(), path: z.string().default("") }))
    .query(({ input }) => filesService.listFiles(input.workspaceId, input.path)),

  getFile: publicProcedure
    .input(z.object({ workspaceId: z.string(), path: z.string().min(1) }))
    .query(({ input }) => filesService.getFile(input.workspaceId, input.path)),

  saveFile: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        path: z.string().min(1),
        content: z.string(),
      }),
    )
    .mutation(({ input }) => filesService.saveFile(input.workspaceId, input.path, input.content)),

  createFile: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        path: z.string().min(1),
        content: z.string().default(""),
      }),
    )
    .mutation(({ input }) => filesService.createFile(input.workspaceId, input.path, input.content)),

  createDirectory: publicProcedure
    .input(z.object({ workspaceId: z.string(), path: z.string().min(1) }))
    .mutation(({ input }) => filesService.createDirectory(input.workspaceId, input.path)),

  deletePath: publicProcedure
    .input(z.object({ workspaceId: z.string(), path: z.string().min(1) }))
    .mutation(({ input }) => filesService.deletePath(input.workspaceId, input.path)),

  renamePath: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        fromPath: z.string().min(1),
        toPath: z.string().min(1),
      }),
    )
    .mutation(({ input }) =>
      filesService.renamePath(input.workspaceId, input.fromPath, input.toPath),
    ),

  copyPath: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        fromPath: z.string().min(1),
        toPath: z.string().min(1),
      }),
    )
    .mutation(({ input }) =>
      filesService.copyPath(input.workspaceId, input.fromPath, input.toPath),
    ),

  searchFiles: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        query: z.string().default(""),
        // Raised from 50 → 200 to match the corpus expansion in issue
        // #530: with files from nested git repos now visible to Quick
        // Open, the previous 50-entry cap could push a wanted match
        // off the result list entirely.
        limit: z.number().default(200),
      }),
    )
    .query(({ input }) =>
      searchService.searchFiles(input.workspaceId, {
        query: input.query,
        limit: input.limit,
      }),
    ),

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
    .query(({ input }) =>
      searchService.searchContent(input.workspaceId, {
        query: input.query,
        caseSensitive: input.caseSensitive,
        wholeWord: input.wholeWord,
        regex: input.regex,
        limit: input.limit,
      }),
    ),

  switchAgent: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        agentId: z.string(),
        chatId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // Keep the pre-#535 wire contract: `switchAgent` returned NOT_FOUND
      // (404) when the workspace lookup failed. Other procedures in this
      // router collapse the same condition to a plain 500 to match the
      // legacy pinned-test contract; switchAgent and formatFile are the
      // historical exceptions where the 404 mapping pre-existed the
      // follow-up-1 split.
      try {
        return await workspaceService.switchAgent(input);
      } catch (err) {
        if (err instanceof WorkspaceNotFoundError) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        throw err;
      }
    }),
});

export type WorkspaceRouter = typeof workspaceRouter;
