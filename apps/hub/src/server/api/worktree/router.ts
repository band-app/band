import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { isFolderScope } from "../../infra/project-scope";
import { diffService } from "../../services/diff-service";
import { editorService } from "../../services/editor-service";
import { filesService } from "../../services/files-service";
import { FormatterError } from "../../services/formatter";
import { gitGraphService } from "../../services/git-graph-service";
import { searchService } from "../../services/search-service";
import { terminalService } from "../../services/terminal-service";
import { WorktreeNotFoundError, worktreeService } from "../../services/worktree-service";
import { publicProcedure, t } from "../trpc";

/**
 * Worktree (singular) sub-router — per-worktree operations: file CRUD,
 * search, diff, git pull/push/commit, format. The router
 * is validation + delegation only (issue #535, follow-up 1): every line of
 * business logic lives behind a service-tier seam:
 *
 *   - `filesService`  → file CRUD + path-traversal / .git guards.
 *   - `searchService` → file-name fuzzy search and ripgrep content search.
 *   - `diffService`   → branch listing, Changes sections, file diff,
 *     stage / unstage / discard.
 *   - `gitGraphService` → commit history, commit files, per-commit file diff.
 *   - `worktreeService` → gitPull/gitPush/gitCommit (worktreeId-keyed),
 *     generateCommitMessage.
 *   - `editorService` → file watcher subscription + Prettier formatFile.
 *   - `terminalService.getWorktreeConfig` → per-worktree terminal config.
 *
 * The plural `worktrees.*` namespace handles worktree lifecycle
 * (create, remove, runScript, gitPull/Push by `(repo, branch)`); see
 * `api/worktrees/router.ts`. Every existing client (FileBrowser,
 * Changes sidepanel, diff leaves, search popups, agent picker) speaks
 * `trpc.worktree.*`.
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
 * `mergeBase` is the SHA returned by `getChanges` and threaded
 * back into `getFileDiff` as a revision argument to `git diff`. Pin to
 * a 40-character hex SHA: this closes the leading-dash injection
 * vector (`--exec=`, `--output=…`) AND enforces that `getFileDiff`
 * operates on the same revision shape `getChanges` returned. Real
 * merge-base SHAs from git are always 40-char hex; symbolic refs like
 * `HEAD`, `main`, or `@{-1}` are rejected so a client can't accidentally
 * desync from the Changes list's view of the world.
 */
const mergeBaseSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/i, "mergeBase must be a 40-character hex SHA");

/** A section of the Changes view (see `DiffService.getChanges`). */
const changeSectionSchema = z.enum(["conflicts", "unstaged", "staged", "untracked", "branch"]);

/**
 * A worktree-relative path handed to git as a pathspec. The leading-dash
 * guard keeps it from being read as a flag; the service also checks it
 * stays inside the worktree.
 */
const filePathSchema = z.string().min(1).regex(/^[^-]/, "path must not start with '-'");

/**
 * The worktree of a git write (stage, discard, commit, push, pull). A project's folder syncs on its
 * own through the context sync, which scans for credentials, so git calls never write it.
 */
const gitWorktreeIdSchema = z
  .string()
  .refine((id) => !isFolderScope(id), "A project's folder syncs on its own and has no git actions");

/** Paths for the stage / unstage / discard mutations. A header action sends
 *  every file of its section; the service hands them to git in batches. */
const pathListSchema = z.array(filePathSchema).min(1).max(50_000);

/**
 * A commit SHA passed to the commit-history procedures. Pinned to 7–40 hex
 * chars so git can never read it as a flag (`--exec=…`) or a symbolic ref:
 * the Commits panel always hands us a real object id.
 */
const commitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/i, "sha must be a 7–40 character hex commit id");

/**
 * Wire-contract note: every worktree-tier service error (including
 * `WorktreeNotFoundError`) bubbles as a plain `Error` and the tRPC
 * adapter surfaces it as HTTP 500. That's pinned by the trpc
 * integration tests in `tests/trpc.test.ts` and mirrors the repo-
 * tier `RepoNotFoundError` / `PlainRepoError` handling in
 * `api/worktrees/router.ts`. Promoting `WorktreeNotFoundError` to a
 * tRPC `NOT_FOUND` (404) is a separate change that needs to land
 * alongside the pinned-test update.
 *
 *
 * TODO(#535-followup): the `WorktreeNotFoundError` → 404 migration
 * should cover `listBranches`, `getDiff`, `getChanges`, `getFile`,
 * `getFileDiff`, `stageFiles`, `discardChanges`, the `git*` mutations, the `*Path` /
 * `*File` / `*Directory` file CRUD, and the two search procedures —
 * any procedure that goes through `WorktreeService.resolve` or its
 * `WorktreeNotFoundError`-throwing siblings. When that lands, the
 * `tests/trpc.test.ts` cases that pin status=500 for "unknown
 * worktree" need to flip to 404 in the same change.
 *
 * `formatFile` is the historical exception — it threw
 * `TRPCError({code: "NOT_FOUND"})` for the worktree-lookup branch even
 * before the follow-up-1 split, and is kept as-is to preserve the
 * pre-existing wire contract; a future cleanup can align it with the
 * rest of the router.
 */
export const worktreeRouter = t.router({
  getTerminalConfig: publicProcedure
    .input(z.object({ worktreeId: z.string() }))
    .query(async ({ input }) => {
      return { config: await terminalService.getWorktreeConfig(input.worktreeId) };
    }),

  /**
   * Format the supplied `content` using Prettier as if it were the file at
   * `filePath` inside `worktreeId`. The procedure is pure — it does not
   * read or write the file on disk. The client passes in the live editor
   * buffer and applies the returned `formatted` string back to the editor.
   * Persistence is the caller's responsibility via `worktree.saveFile`.
   *
   * Returns `{ skipped: true, reason }` when Prettier has no parser for
   * the file's extension (or it's covered by `.prettierignore`). Editors
   * fire this off Shift+Alt+F without checking the file type first, so a
   * soft skip is the right outcome for unsupported files rather than a
   * surfaced error.
   *
   * Auth: enforced at the transport layer (the `band_token` cookie gates
   * the WebSocket upgrade and HTTP requests in start-server.ts) — same
   * pattern as the rest of `worktreeRouter`.
   */
  formatFile: publicProcedure
    .input(
      z.object({
        worktreeId: z.string(),
        filePath: z.string().min(1),
        // 1 MB ceiling — covers every realistic source file (the largest
        // human-authored .ts in the world is well under 500 KB) and stops a
        // pathological caller from blocking the event loop with a multi-MB
        // string while Prettier churns on it.
        content: z.string().max(1_000_000),
      }),
    )
    .mutation(async ({ input }) => {
      // Single worktree lookup happens inside editorService.formatFile;
      // a WorktreeNotFoundError propagates up here and maps to 404,
      // matching the pre-#535 wire contract. FormatterError maps to 400.
      try {
        return await editorService.formatFile(input.worktreeId, input.filePath, input.content);
      } catch (err) {
        if (err instanceof WorktreeNotFoundError) {
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
   * Subscribe to external file-system changes inside a single worktree.
   * The watcher is started on demand for that worktree and torn down when
   * the last subscriber disconnects, so we don't keep OS watch handles
   * open on every worktree the user has ever added (see issue #384).
   *
   * Yields one event per coalesced (parentDir) change; `path` is the
   * worktree-relative parent directory ("" for the worktree root). The
   * FileBrowser uses it as a cache invalidation key.
   *
   * Auth: enforced at the transport layer (the `band_token` cookie gates
   * the WebSocket upgrade and HTTP requests in start-server.ts), so no
   * per-procedure guard is needed — consistent with the rest of
   * `worktreeRouter`.
   */
  fileChanges: publicProcedure
    .input(z.object({ worktreeId: z.string() }))
    .subscription(async function* (opts) {
      // We rely on the tRPC adapter supplying a cancellation signal — both
      // the WebSocket and HTTP transports we use today set it on every
      // subscription. Fail loud if a future adapter omits it rather than
      // silently parking this generator forever.
      if (!opts.signal) {
        throw new Error(
          "worktree.fileChanges requires a cancellable subscription (opts.signal missing)",
        );
      }
      const signal = opts.signal;

      const queue: { path: string }[] = [];
      let resolve: (() => void) | null = null;
      // Set to true if the underlying watcher dies — the generator then
      // finishes cleanly so the client sees the stream complete instead
      // of waiting forever for an event from a dead handle.
      let watcherClosed = false;

      const unsubscribe = editorService.subscribeToFileChanges(opts.input.worktreeId, (path) => {
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
    .input(
      z.object({
        worktreeId: z.string(),
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(({ input }) =>
      diffService.listBranches(input.worktreeId, { query: input.query, limit: input.limit }),
    ),

  getCommitHistory: publicProcedure
    .input(
      z.object({
        worktreeId: z.string(),
        skip: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
    )
    .query(({ input }) =>
      gitGraphService.getCommitHistory(input.worktreeId, {
        skip: input.skip,
        limit: input.limit,
      }),
    ),

  getCommitHistorySignature: publicProcedure
    .input(z.object({ worktreeId: z.string() }))
    .query(({ input }) => gitGraphService.getCommitHistorySignature(input.worktreeId)),

  getCommitDetails: publicProcedure
    .input(z.object({ worktreeId: z.string(), sha: commitShaSchema }))
    .query(({ input }) => gitGraphService.getCommitDetails(input.worktreeId, input.sha)),

  getCommitFileDiff: publicProcedure
    .input(
      z.object({
        worktreeId: z.string(),
        sha: commitShaSchema,
        filePath: z.string().min(1).regex(/^[^-]/, "filePath must not start with '-'"),
        contextLines: z.number().int().min(0).max(99999).optional(),
      }),
    )
    .query(({ input }) =>
      gitGraphService.getCommitFileDiff(input.worktreeId, input.sha, input.filePath, {
        contextLines: input.contextLines,
      }),
    ),

  getDiff: publicProcedure
    .input(
      z.object({
        worktreeId: z.string(),
        contextLines: z.number().int().min(0).max(99999).optional(),
        diffMode: z.enum(["uncommitted", "branch"]).optional(),
        compareBranch: compareBranchSchema,
      }),
    )
    .query(({ input }) =>
      diffService.getDiff(input.worktreeId, {
        contextLines: input.contextLines,
        diffMode: input.diffMode,
        compareBranch: input.compareBranch,
      }),
    ),

  getChanges: publicProcedure
    .input(z.object({ worktreeId: z.string(), compareBranch: compareBranchSchema }))
    .query(({ input }) =>
      diffService.getChanges(input.worktreeId, { compareBranch: input.compareBranch }),
    ),

  getFileDiff: publicProcedure
    .input(
      z.object({
        worktreeId: z.string(),
        filePath: filePathSchema,
        section: changeSectionSchema,
        /** Required for the `branch` section. */
        mergeBase: mergeBaseSchema.optional(),
        /** The path before a rename, so git pairs the two sides. */
        oldPath: filePathSchema.optional(),
        contextLines: z.number().int().min(0).max(99999).optional(),
      }),
    )
    .query(({ input }) =>
      diffService.getFileDiff(input.worktreeId, {
        filePath: input.filePath,
        section: input.section,
        mergeBase: input.mergeBase,
        oldPath: input.oldPath,
        contextLines: input.contextLines,
      }),
    ),

  stageFiles: publicProcedure
    .input(z.object({ worktreeId: gitWorktreeIdSchema, paths: pathListSchema }))
    .mutation(({ input }) => diffService.stageFiles(input.worktreeId, input.paths)),

  unstageFiles: publicProcedure
    .input(z.object({ worktreeId: gitWorktreeIdSchema, paths: pathListSchema }))
    .mutation(({ input }) => diffService.unstageFiles(input.worktreeId, input.paths)),

  discardChanges: publicProcedure
    .input(
      z.object({
        worktreeId: gitWorktreeIdSchema,
        paths: pathListSchema,
        section: z.enum(["unstaged", "staged", "untracked"]),
      }),
    )
    .mutation(({ input }) =>
      diffService.discardChanges(input.worktreeId, {
        paths: input.paths,
        section: input.section,
      }),
    ),

  gitPull: publicProcedure
    .input(z.object({ worktreeId: gitWorktreeIdSchema }))
    .mutation(({ input }) => worktreeService.gitPullByWorktreeId(input.worktreeId)),

  gitPush: publicProcedure
    .input(z.object({ worktreeId: gitWorktreeIdSchema }))
    .mutation(({ input }) => worktreeService.gitPushByWorktreeId(input.worktreeId)),

  gitCommit: publicProcedure
    .input(
      z.object({
        worktreeId: gitWorktreeIdSchema,
        message: z.string().min(1, "commit message is required"),
        body: z.string().optional(),
      }),
    )
    .mutation(({ input }) =>
      worktreeService.gitCommit(input.worktreeId, {
        message: input.message,
        body: input.body,
      }),
    ),

  generateCommitMessage: publicProcedure
    .input(z.object({ worktreeId: gitWorktreeIdSchema }))
    .mutation(({ input }) => worktreeService.generateCommitMessage(input.worktreeId)),

  listFiles: publicProcedure
    .input(z.object({ worktreeId: z.string(), path: z.string().default("") }))
    .query(({ input }) => filesService.listFiles(input.worktreeId, input.path)),

  getFile: publicProcedure
    .input(z.object({ worktreeId: z.string(), path: z.string().min(1) }))
    .query(({ input }) => filesService.getFile(input.worktreeId, input.path)),

  saveFile: publicProcedure
    .input(
      z.object({
        worktreeId: z.string(),
        path: z.string().min(1),
        content: z.string(),
      }),
    )
    .mutation(({ input }) => filesService.saveFile(input.worktreeId, input.path, input.content)),

  createFile: publicProcedure
    .input(
      z.object({
        worktreeId: z.string(),
        path: z.string().min(1),
        content: z.string().default(""),
      }),
    )
    .mutation(({ input }) => filesService.createFile(input.worktreeId, input.path, input.content)),

  createDirectory: publicProcedure
    .input(z.object({ worktreeId: z.string(), path: z.string().min(1) }))
    .mutation(({ input }) => filesService.createDirectory(input.worktreeId, input.path)),

  deletePath: publicProcedure
    .input(z.object({ worktreeId: z.string(), path: z.string().min(1) }))
    .mutation(({ input }) => filesService.deletePath(input.worktreeId, input.path)),

  renamePath: publicProcedure
    .input(
      z.object({
        worktreeId: z.string(),
        fromPath: z.string().min(1),
        toPath: z.string().min(1),
      }),
    )
    .mutation(({ input }) =>
      filesService.renamePath(input.worktreeId, input.fromPath, input.toPath),
    ),

  copyPath: publicProcedure
    .input(
      z.object({
        worktreeId: z.string(),
        fromPath: z.string().min(1),
        toPath: z.string().min(1),
      }),
    )
    .mutation(({ input }) => filesService.copyPath(input.worktreeId, input.fromPath, input.toPath)),

  searchFiles: publicProcedure
    .input(
      z.object({
        worktreeId: z.string(),
        query: z.string().default(""),
        // Raised from 50 → 200 to match the corpus expansion in issue
        // #530: with files from nested git repos now visible to Quick
        // Open, the previous 50-entry cap could push a wanted match
        // off the result list entirely.
        limit: z.number().default(200),
      }),
    )
    .query(({ input }) =>
      searchService.searchFiles(input.worktreeId, {
        query: input.query,
        limit: input.limit,
      }),
    ),

  // Resolve an absolute (or worktree-relative) path against this
  // worktree: does it exist, is it a regular file, and does it live inside
  // the worktree (→ worktree-relative path) or outside it (→ external tab)?
  // Quick Open calls this for an absolute-path query so a path that happens
  // to be inside the current worktree opens as a normal file rather than an
  // external tab. Shares `openFile`'s canonicalize + containment logic.
  //
  // Intentional tradeoff: this reports `exists`/`isFile` for ANY absolute
  // path an authenticated caller supplies (not just in-worktree ones), so it
  // is a filesystem-existence oracle. That is acceptable under Band's threat
  // model — the same auth scope already reads arbitrary absolute paths via
  // `host.readFile` — and the `external` flag is load-bearing, not dead code:
  // it's how the client decides between a worktree-relative and an external
  // tab. Do not "harden" this by dropping the out-of-worktree classification.
  resolvePath: publicProcedure
    .input(z.object({ worktreeId: z.string(), path: z.string().min(1) }))
    .query(({ input }) =>
      editorService.resolvePath({ worktreeId: input.worktreeId, filePath: input.path }),
    ),

  searchContent: publicProcedure
    .input(
      z.object({
        worktreeId: z.string(),
        query: z.string().min(1),
        caseSensitive: z.boolean().default(false),
        wholeWord: z.boolean().default(false),
        regex: z.boolean().default(false),
        limit: z.number().default(100),
      }),
    )
    .query(({ input }) =>
      searchService.searchContent(input.worktreeId, {
        query: input.query,
        caseSensitive: input.caseSensitive,
        wholeWord: input.wholeWord,
        regex: input.regex,
        limit: input.limit,
      }),
    ),
});

export type WorktreeRouter = typeof worktreeRouter;
