import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { createLogger } from "@band-app/logger";
import { TRPCError } from "@trpc/server";
import { rgPath } from "@vscode/ripgrep";
import { z } from "zod";
import {
  type ClearRange,
  clearHistory,
  deleteHistoryEntry,
  listHistory,
  recordVisit,
  searchHistory,
  updateVisitMeta,
} from "../lib/browser-history-store";
import { getOrCreateDefaultChat, updateChat } from "../lib/chat-manager";
import { fuzzyScore } from "../lib/fuzzy-score";
import { execGit } from "../lib/git";
import {
  clearQueuedMessages,
  getQueuedMessages,
  pushQueuedMessage,
  type QueuedMessage,
  removeQueuedMessage,
  setQueuedMessages,
  shiftQueuedMessage,
  subscribeQueue,
  toWireQueuedMessages,
  updateQueuedMessage,
} from "../lib/queued-message-store";
import {
  bandHome,
  getAgentDefinition,
  getWorkspaceStatus,
  loadSettings,
  upsertWorkspaceStatus,
} from "../lib/state";
import { saveUploadedFilesDetailed } from "../lib/upload-utils";
import { emit } from "../lib/watcher";
import { resolveWorkspace } from "../lib/workspace";
import { publicProcedure, t } from "../server/api/trpc";
import { createWorkspaceAgent, replaceAgent } from "../server/infra/agents/agent-pool";
import { subscribeToFileChanges } from "../server/services/file-watcher";
import { FormatterError, formatFile } from "../server/services/formatter";
import { abortTask, resolvePendingInput } from "../server/services/task-service";
import { terminalService } from "../server/services/terminal-service";

const log = createLogger("trpc");

// ---------------------------------------------------------------------------
// Projects — migrated to `server/api/projects/router.ts` in Phase 2 of the
// 3-tier refactor (issue #313). The merged tRPC surface still exposes
// `projects.*` because `server/api/router.ts` composes the migrated
// sub-router with this legacy file. Do NOT re-add a `projects` key below;
// `mergeRouters` is last-write-wins for duplicate keys, so a stray
// re-definition would silently mask the migrated router. See the
// INVARIANT comment in `server/api/router.ts`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Workspaces — migrated to `server/api/workspaces/router.ts` (issue #314).
// The legacy declaration lived here; it is now merged into the root router
// from `server/api/router.ts` so the wire shape is unchanged. The
// `workspaceRouter` (file ops, diffs) below is a different surface and
// remains legacy until its own migration phase.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Settings — migrated to `server/api/settings/router.ts` (issue #312).
// The legacy declaration lived here; it is now merged into the root
// router from `server/api/router.ts` so the wire shape is unchanged.
// ---------------------------------------------------------------------------

// `hooks.*` migrated to `server/api/hooks/router.ts` (and the
// `~/.claude/settings.json` reader/writer at `services/hooks.ts`) as part
// of Phase 7.5 (issue #517).
//
// `cli.*` migrated to `server/api/cli/router.ts` (and the band-CLI binary
// resolver + symlink installer at `services/cli.ts`) as part of Phase 7.5
// (issue #517).

// ---------------------------------------------------------------------------
// Workspace (file operations)
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

const LANG_MAP: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "jsx",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".md": "markdown",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".swift": "swift",
  ".c": "c",
  ".cpp": "cpp",
  ".sh": "bash",
  ".sql": "sql",
  ".graphql": "graphql",
  ".vue": "vue",
  ".svelte": "svelte",
  ".diff": "diff",
};

// ---------------------------------------------------------------------------
// Workspace diff helpers
// ---------------------------------------------------------------------------

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

const EMPTY_TREE_ARGS = ["hash-object", "-t", "tree", "/dev/null"];

/**
 * The canonical SHA of git's empty *tree* object — built into git
 * itself (every git version exposes this hash whether or not any
 * objects have been created locally). We use it as the `mergeBase`
 * sentinel for non-git workspaces so the field always carries a real
 * 40-char SHA shape, which a downstream consumer that does string
 * validation (length / hex check) on `mergeBase` won't choke on.
 *
 * Note this is a tree, not a commit — `git diff` accepts either, but
 * callers that strictly expect a commit-ish (e.g. `git merge-base
 * <sha> HEAD`) will reject it. The DiffView guards against ever
 * passing this through for a plain project via its `isPlain` check;
 * other potential consumers should treat this as "empty diff,
 * intentionally" rather than a usable commit reference.
 */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

interface DiffContext {
  /** Resolved compare branch — defaults to project default. */
  compareBranch: string;
  /** Current branch name, or `defaultBranch` if HEAD is detached / unborn. */
  headBranch: string;
  /** Commit/tree to diff against. */
  mergeBase: string;
}

/**
 * Resolves the `(headBranch, mergeBase, compareBranch)` triple shared by
 * `getDiff`, `getDiffSummary`, and `revertFile`. Falls back to the empty tree
 * when the workspace has no commits yet (so brand-new repos don't 500).
 */
async function resolveDiffContext(
  cwd: string,
  defaultBranch: string,
  diffMode: "uncommitted" | "branch",
  compareBranchInput: string | undefined,
): Promise<DiffContext> {
  const compareBranch =
    diffMode === "uncommitted" ? defaultBranch : (compareBranchInput ?? defaultBranch);

  let headBranch: string;
  try {
    headBranch = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
  } catch {
    headBranch = defaultBranch;
  }

  let mergeBase: string;
  if (diffMode === "uncommitted") {
    try {
      mergeBase = (await execGit(["rev-parse", "HEAD"], cwd)).trim();
    } catch {
      mergeBase = (await execGit(EMPTY_TREE_ARGS, cwd)).trim();
    }
  } else {
    try {
      mergeBase = (await execGit(["merge-base", compareBranch, "HEAD"], cwd)).trim();
    } catch {
      mergeBase = (await execGit(EMPTY_TREE_ARGS, cwd)).trim();
    }
  }

  return { compareBranch, headBranch, mergeBase };
}

/** Parses the trailing summary line of `git diff --stat`. */
function parseDiffStatSummary(statOutput: string): {
  filesChanged: number;
  insertions: number;
  deletions: number;
} {
  const statLines = statOutput.trim().split("\n");
  const summaryLine = statLines[statLines.length - 1] || "";

  const filesMatch = summaryLine.match(/(\d+)\s+files?\s+changed/);
  const insertMatch = summaryLine.match(/(\d+)\s+insertions?\(\+\)/);
  const deleteMatch = summaryLine.match(/(\d+)\s+deletions?\(-\)/);

  return {
    filesChanged: filesMatch ? Number.parseInt(filesMatch[1], 10) : 0,
    insertions: insertMatch ? Number.parseInt(insertMatch[1], 10) : 0,
    deletions: deleteMatch ? Number.parseInt(deleteMatch[1], 10) : 0,
  };
}

/** Builds the `path -> status code` map from `git diff --name-status`. */
function parseFileStatuses(nameStatusOutput: string): Record<string, string> {
  const fileStatuses: Record<string, string> = {};
  for (const line of nameStatusOutput.trim().split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const statusCode = parts[0][0];
    if (statusCode === "R" && parts[2]) {
      fileStatuses[parts[2]] = "R";
    } else if (parts[1]) {
      fileStatuses[parts[1]] = statusCode;
    }
  }
  return fileStatuses;
}

/** Reads an untracked file as the lines that would appear in a synthesized diff. */
async function readUntrackedFileLines(cwd: string, file: string): Promise<string[] | null> {
  try {
    const content = await readFile(join(cwd, file), "utf-8");
    const lines = content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines;
  } catch {
    // Skip binary or unreadable files
    return null;
  }
}

const workspaceRouter = t.router({
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
      const workspace = resolveWorkspace(input.workspaceId);
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
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const cwd = workspace.worktree.path;
      const defaultBranch = workspace.project.defaultBranch;

      let headBranch: string | null = null;
      try {
        headBranch = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
      } catch {
        // No commits yet — leave headBranch null
      }

      let branches: string[] = [];
      try {
        const output = await execGit(
          ["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
          cwd,
        );
        branches = output
          .trim()
          .split("\n")
          .map((b) => b.trim())
          .filter(Boolean);
      } catch (err) {
        log.error(
          `listBranches: for-each-ref failed for ${cwd}: ${err instanceof Error ? err.message : err}`,
        );
      }

      // Drop the current branch (you don't compare against yourself) and pin
      // the default branch to the front. When you're on the default branch,
      // skip the re-add — comparing main↔main is a no-op and confusing.
      const filtered = branches.filter((b) => b !== headBranch);
      if (defaultBranch !== headBranch) {
        const idx = filtered.indexOf(defaultBranch);
        if (idx >= 0) {
          filtered.splice(idx, 1);
        }
        filtered.unshift(defaultBranch);
      }

      return {
        branches: filtered,
        defaultBranch,
        headBranch: headBranch ?? defaultBranch,
      };
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
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const cwd = workspace.worktree.path;
      const defaultBranch = workspace.project.defaultBranch;
      const { compareBranch, headBranch, mergeBase } = await resolveDiffContext(
        cwd,
        defaultBranch,
        input.diffMode ?? "branch",
        input.compareBranch,
      );

      const diffArgs = ["diff"];
      if (input.contextLines !== undefined) {
        diffArgs.push(`-U${input.contextLines}`);
      }
      diffArgs.push(mergeBase);
      let diff = await execGit(diffArgs, cwd);

      const statOutput = await execGit(["diff", "--stat", mergeBase], cwd);
      const stats = parseDiffStatSummary(statOutput);

      const nameStatusOutput = await execGit(["diff", "--name-status", mergeBase], cwd);
      const fileStatuses = parseFileStatuses(nameStatusOutput);

      const untrackedOutput = await execGit(["ls-files", "--others", "--exclude-standard"], cwd);
      const untrackedFiles = untrackedOutput.trim().split("\n").filter(Boolean);

      for (const file of untrackedFiles) {
        const lines = await readUntrackedFileLines(cwd, file);
        if (lines === null) continue;
        diff += `diff --git a/${file} b/${file}\n`;
        diff += "new file mode 100644\n";
        diff += "--- /dev/null\n";
        diff += `+++ b/${file}\n`;
        diff += `@@ -0,0 +1,${lines.length} @@\n`;
        diff += lines.map((l) => `+${l}`).join("\n");
        diff += "\n";
        stats.filesChanged++;
        stats.insertions += lines.length;
        fileStatuses[file] = "U";
      }

      return {
        diff,
        stats,
        // `compareBranch` is the branch we diffed against (the user's pick, or
        // the project default). `defaultBranch` is the project default. They
        // diverge once a non-default branch is picked.
        compareBranch,
        defaultBranch,
        headBranch,
        fileStatuses,
      };
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
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      // Plain (non-git) projects have no diff to compute. Return an empty
      // summary instead of throwing so the UI can show a calm message
      // rather than a raw git error — see #427.
      //
      // Also short-circuit when the worktree's `.git` is missing on disk
      // regardless of the recorded kind. The kind field can lag reality
      // (e.g. a project added before the migration shipped, or a folder
      // whose `.git` was deleted from a terminal) — in either case
      // running `execGit(...)` would surface as a raw error in the
      // Changes view. The next `projects.list` self-heals kind, but
      // until then we still want a graceful empty diff.
      const hasGit = existsSync(join(workspace.worktree.path, ".git"));
      if (workspace.project.kind === "plain" || !hasGit) {
        const defaultBranch = workspace.project.defaultBranch;
        return {
          stats: { filesChanged: 0, insertions: 0, deletions: 0 },
          compareBranch: defaultBranch,
          defaultBranch,
          headBranch: defaultBranch,
          fileStatuses: {},
          mergeBase: EMPTY_TREE_SHA,
        };
      }

      const cwd = workspace.worktree.path;
      const defaultBranch = workspace.project.defaultBranch;
      const { compareBranch, headBranch, mergeBase } = await resolveDiffContext(
        cwd,
        defaultBranch,
        input.diffMode ?? "branch",
        input.compareBranch,
      );

      const statOutput = await execGit(["diff", "--stat", mergeBase], cwd);
      const stats = parseDiffStatSummary(statOutput);

      const nameStatusOutput = await execGit(["diff", "--name-status", mergeBase], cwd);
      const fileStatuses = parseFileStatuses(nameStatusOutput);

      const untrackedOutput = await execGit(["ls-files", "--others", "--exclude-standard"], cwd);
      const untrackedFiles = untrackedOutput.trim().split("\n").filter(Boolean);

      for (const file of untrackedFiles) {
        const lines = await readUntrackedFileLines(cwd, file);
        if (lines === null) continue;
        stats.filesChanged++;
        stats.insertions += lines.length;
        fileStatuses[file] = "U";
      }

      return {
        stats,
        compareBranch,
        defaultBranch,
        headBranch,
        fileStatuses,
        mergeBase,
      };
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
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const cwd = workspace.worktree.path;

      // Check if file is untracked
      const untrackedOutput = await execGit(["ls-files", "--others", "--exclude-standard"], cwd);
      const untrackedFiles = untrackedOutput.trim().split("\n").filter(Boolean);

      if (untrackedFiles.includes(input.filePath)) {
        // Synthesize diff for untracked file
        try {
          const content = await readFile(join(cwd, input.filePath), "utf-8");
          const lines = content.split("\n");
          if (lines.length > 0 && lines[lines.length - 1] === "") {
            lines.pop();
          }
          let diff = `diff --git a/${input.filePath} b/${input.filePath}\n`;
          diff += "new file mode 100644\n";
          diff += "--- /dev/null\n";
          diff += `+++ b/${input.filePath}\n`;
          diff += `@@ -0,0 +1,${lines.length} @@\n`;
          diff += lines.map((l) => `+${l}`).join("\n");
          diff += "\n";
          return { diff };
        } catch {
          return { diff: "" };
        }
      }

      // Tracked file — get diff for this single file
      const fileDiffArgs = ["diff"];
      if (input.contextLines !== undefined) {
        fileDiffArgs.push(`-U${input.contextLines}`);
      }
      fileDiffArgs.push(input.mergeBase, "--", input.filePath);
      const diff = await execGit(fileDiffArgs, cwd);
      return { diff };
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
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const cwd = workspace.worktree.path;
      const { filePath, diffMode } = input;

      // Determine the file status server-side
      const untrackedOutput = await execGit(["ls-files", "--others", "--exclude-standard"], cwd);
      const untrackedFiles = untrackedOutput.trim().split("\n").filter(Boolean);

      if (untrackedFiles.includes(filePath)) {
        // Untracked file — just delete it
        await rm(join(cwd, filePath), { force: true });
        return { ok: true };
      }

      // Reuse the shared resolver so the reference commit matches what
      // getDiff/getDiffSummary computed — otherwise revert can drift.
      const { mergeBase: ref } = await resolveDiffContext(
        cwd,
        workspace.project.defaultBranch,
        diffMode,
        input.compareBranch,
      );

      // Determine the tracked file status from the diff
      const nameStatusOutput = await execGit(["diff", "--name-status", ref, "--", filePath], cwd);
      const statusLine = nameStatusOutput.trim().split("\n").filter(Boolean)[0];
      const fileStatus = statusLine ? statusLine[0] : null;

      if (fileStatus === "A") {
        // Added (staged) file — remove from index and delete from working tree
        await execGit(["rm", "-f", "--", filePath], cwd);
      } else {
        // Modified, Deleted, or Renamed — restore to the reference commit
        await execGit(["checkout", ref, "--", filePath], cwd);
      }

      return { ok: true };
    }),

  gitPull: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }
      const cwd = workspace.worktree.path;
      try {
        await execGit(["pull", "--rebase"], cwd);
      } catch (e) {
        // git pull --rebase can exit non-zero with "Cannot rebase onto multiple
        // branches" when the fetch step already fast-forwarded the working
        // tree. The pull effectively succeeded, so swallow that specific case
        // — same behaviour as the project-keyed `workspaces.gitPull` endpoint.
        const msg = String(e);
        if (msg.includes("Cannot rebase onto multiple branches")) {
          return { ok: true };
        }
        throw new Error(e instanceof Error ? e.message : msg);
      }
      return { ok: true };
    }),

  gitPush: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }
      const cwd = workspace.worktree.path;
      try {
        await execGit(["push"], cwd);
      } catch {
        // First push may need to set upstream. Resolve the live HEAD branch
        // rather than trusting a stale state.json entry — the worktree may
        // have been renamed via `git branch -m` and the project record not
        // yet refreshed.
        let headBranch: string;
        try {
          headBranch = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
        } catch {
          headBranch = workspace.worktree.branch;
        }
        try {
          await execGit(["push", "--set-upstream", "origin", headBranch], cwd);
        } catch (e2) {
          throw new Error(e2 instanceof Error ? e2.message : String(e2));
        }
      }
      return { ok: true };
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
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }
      const cwd = workspace.worktree.path;

      // Stage everything (tracked + untracked) so the commit reflects the
      // diff the user just reviewed in the Changes view.
      await execGit(["add", "-A"], cwd);

      // Pass title + body as separate `-m` args so git formats them with the
      // standard blank-line separator between subject and body.
      const args = ["commit", "-m", input.message];
      const body = input.body?.trim();
      if (body) {
        args.push("-m", body);
      }
      try {
        await execGit(args, cwd);
      } catch (e) {
        throw new Error(e instanceof Error ? e.message : String(e));
      }
      return { ok: true };
    }),

  generateCommitMessage: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }
      const cwd = workspace.worktree.path;

      // Cheap pre-flight: refuse early if there are no pending changes so we
      // don't spin up an agent process just to have it report "nothing to
      // commit". `git status --porcelain` covers staged, unstaged, and
      // untracked files in one call.
      try {
        const status = await execGit(["status", "--porcelain"], cwd);
        if (!status.trim()) {
          throw new Error("No changes to summarise");
        }
      } catch (e) {
        // Re-throw the explicit "no changes" error; swallow other status
        // failures (e.g. unborn HEAD on a brand-new repo) and let the agent
        // figure it out.
        if (e instanceof Error && e.message === "No changes to summarise") {
          throw e;
        }
      }

      const settings = loadSettings();
      const agentDef = getAgentDefinition(settings);

      // The agent runs in the workspace's worktree and has Bash/Read tools,
      // so it can explore the changes directly — `git diff HEAD`,
      // `git status`, peek at related files, check recent commit style, etc.
      // This produces better messages than feeding a (potentially truncated)
      // serialised diff in the prompt.
      const prompt = [
        "You are running inside a git workspace. Write a commit message for the changes that are pending in this workspace right now.",
        "",
        "Steps:",
        "  1. Run `git status` and `git diff HEAD` (and `git diff --stat` if the diff is large) to understand what changed.",
        "  2. If helpful, read a few of the changed files or recent commits (`git log -5 --oneline`) to match the project's commit style.",
        "  3. Write a single commit message.",
        "",
        "Format:",
        "  - First line: a concise subject (≤ 72 chars), imperative mood, no trailing period.",
        "  - Then a blank line.",
        "  - Then a body that explains *why* the change is being made and any notable details.",
        "",
        "Output ONLY the final commit message as plain text — no markdown fences, no preamble, no commentary, no tool-call summaries. Do not modify any files.",
      ].join("\n");

      let agent: Awaited<ReturnType<typeof createWorkspaceAgent>>;
      try {
        agent = await createWorkspaceAgent(cwd, agentDef.id);
      } catch (e) {
        throw new Error(
          `Failed to start coding agent "${agentDef.label}": ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }

      // Track only text emitted by the *final* assistant turn — earlier
      // text deltas are usually narration around tool calls ("Let me check
      // the diff…") that we don't want in the commit message. Each
      // tool-result event resets the buffer so only post-tool prose
      // survives. `maxTurns` is generous enough for git status + diff +
      // optional log + final write-up.
      let lastTurnText = "";
      try {
        for await (const event of agent.runSession(prompt, undefined, {
          maxTurns: 8,
        })) {
          if (event.type === "text-delta") {
            lastTurnText += event.text;
          } else if (event.type === "tool-result") {
            lastTurnText = "";
          } else if (event.type === "error") {
            throw new Error(event.message);
          }
        }
      } finally {
        agent.abort?.();
      }

      const cleaned = lastTurnText.trim();
      if (!cleaned) {
        throw new Error("Agent returned an empty response");
      }

      // Split into subject + body on the first blank line.
      const lines = cleaned.split("\n");
      const subject = (lines.shift() ?? "").trim();
      // Drop a leading blank line if present so the body doesn't start empty.
      while (lines.length > 0 && lines[0].trim() === "") {
        lines.shift();
      }
      const body = lines.join("\n").trim();

      return {
        message: subject,
        body,
        agentLabel: agentDef.label,
      };
    }),

  listFiles: publicProcedure
    .input(z.object({ workspaceId: z.string(), path: z.string().default("") }))
    .query(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const root = workspace.worktree.path;
      const target = resolve(join(root, input.path));

      if (!target.startsWith(root)) {
        throw new Error("Invalid path");
      }

      const dirents = await readdir(target, { withFileTypes: true });
      const entries = dirents
        .map((d) => ({
          name: d.name,
          type: d.isDirectory() ? ("directory" as const) : ("file" as const),
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      return { entries, path: input.path };
    }),

  getFile: publicProcedure
    .input(z.object({ workspaceId: z.string(), path: z.string() }))
    .query(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      if (!input.path) {
        throw new Error("Path is required");
      }

      const root = workspace.worktree.path;
      const target = resolve(join(root, input.path));

      if (!target.startsWith(root)) {
        throw new Error("Invalid path");
      }

      const fileStat = await stat(target);
      const size = fileStat.size;

      if (size > MAX_FILE_SIZE) {
        return { tooLarge: true as const, size };
      }

      const buffer = await readFile(target);

      const sample = buffer.subarray(0, 8192);
      if (sample.includes(0)) {
        return { binary: true as const, size };
      }

      const ext = extname(target).toLowerCase();
      const language = LANG_MAP[ext];

      return {
        content: buffer.toString("utf-8"),
        size,
        language,
      };
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
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const root = workspace.worktree.path;
      const target = resolve(join(root, input.path));

      if (!target.startsWith(root)) {
        throw new Error("Invalid path");
      }

      const fileStat = await stat(target);
      if (fileStat.isDirectory()) {
        throw new Error("Cannot write to a directory");
      }

      await writeFile(target, input.content, "utf-8");

      return { ok: true };
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
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const root = workspace.worktree.path;
      const target = resolve(join(root, input.path));

      if (!target.startsWith(root) || target === root) {
        throw new Error("Invalid path");
      }

      if (existsSync(target)) {
        throw new Error("A file or directory already exists at this path");
      }

      const parent = dirname(target);
      if (!existsSync(parent)) {
        throw new Error("Parent directory does not exist");
      }
      const parentStat = await stat(parent);
      if (!parentStat.isDirectory()) {
        throw new Error("Parent is not a directory");
      }

      await writeFile(target, input.content, { encoding: "utf-8", flag: "wx" });

      return { ok: true };
    }),

  createDirectory: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        path: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const root = workspace.worktree.path;
      const target = resolve(join(root, input.path));

      if (!target.startsWith(root) || target === root) {
        throw new Error("Invalid path");
      }

      if (existsSync(target)) {
        throw new Error("A file or directory already exists at this path");
      }

      const parent = dirname(target);
      if (!existsSync(parent)) {
        throw new Error("Parent directory does not exist");
      }
      const parentStat = await stat(parent);
      if (!parentStat.isDirectory()) {
        throw new Error("Parent is not a directory");
      }

      await mkdir(target);

      return { ok: true };
    }),

  deletePath: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        path: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const root = workspace.worktree.path;
      const target = resolve(join(root, input.path));

      if (!target.startsWith(root) || target === root) {
        throw new Error("Invalid path");
      }

      // Refuse to delete the .git metadata folder — destroying it would
      // corrupt the worktree.
      const relative = target.slice(root.length + 1);
      if (relative === ".git" || relative.startsWith(".git/")) {
        throw new Error("Refusing to delete .git internals");
      }

      let entryStat: Awaited<ReturnType<typeof stat>>;
      try {
        entryStat = await stat(target);
      } catch {
        throw new Error("Path does not exist");
      }

      // `rm` with `recursive` handles both files and directories. We pass
      // it unconditionally so callers don't need to know the entry kind.
      await rm(target, { recursive: true, force: false });

      return {
        ok: true,
        kind: entryStat.isDirectory() ? ("directory" as const) : ("file" as const),
      };
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
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const root = workspace.worktree.path;
      const fromTarget = resolve(join(root, input.fromPath));
      const toTarget = resolve(join(root, input.toPath));

      if (!fromTarget.startsWith(root) || fromTarget === root) {
        throw new Error("Invalid source path");
      }
      if (!toTarget.startsWith(root) || toTarget === root) {
        throw new Error("Invalid destination path");
      }
      if (fromTarget === toTarget) {
        throw new Error("Source and destination are the same");
      }

      // Block touching .git on either side — corrupting it would break
      // the entire worktree.
      const fromRel = fromTarget.slice(root.length + 1);
      const toRel = toTarget.slice(root.length + 1);
      if (
        fromRel === ".git" ||
        fromRel.startsWith(".git/") ||
        toRel === ".git" ||
        toRel.startsWith(".git/")
      ) {
        throw new Error("Refusing to rename .git internals");
      }

      let entryStat: Awaited<ReturnType<typeof stat>>;
      try {
        entryStat = await stat(fromTarget);
      } catch {
        throw new Error("Source path does not exist");
      }

      if (existsSync(toTarget)) {
        throw new Error("A file or directory already exists at the destination");
      }

      const toParent = dirname(toTarget);
      if (!existsSync(toParent)) {
        throw new Error("Destination parent directory does not exist");
      }
      const toParentStat = await stat(toParent);
      if (!toParentStat.isDirectory()) {
        throw new Error("Destination parent is not a directory");
      }

      await rename(fromTarget, toTarget);

      return {
        ok: true,
        kind: entryStat.isDirectory() ? ("directory" as const) : ("file" as const),
      };
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
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const root = workspace.worktree.path;
      const fromTarget = resolve(join(root, input.fromPath));
      const toTarget = resolve(join(root, input.toPath));

      if (!fromTarget.startsWith(root) || fromTarget === root) {
        throw new Error("Invalid source path");
      }
      if (!toTarget.startsWith(root) || toTarget === root) {
        throw new Error("Invalid destination path");
      }
      if (fromTarget === toTarget) {
        throw new Error("Source and destination are the same");
      }

      // Block touching .git on either side — corrupting it would break
      // the entire worktree.
      const fromRel = fromTarget.slice(root.length + 1);
      const toRel = toTarget.slice(root.length + 1);
      if (
        fromRel === ".git" ||
        fromRel.startsWith(".git/") ||
        toRel === ".git" ||
        toRel.startsWith(".git/")
      ) {
        throw new Error("Refusing to copy .git internals");
      }

      let entryStat: Awaited<ReturnType<typeof stat>>;
      try {
        entryStat = await stat(fromTarget);
      } catch {
        throw new Error("Source path does not exist");
      }

      // Block copying a directory into itself or any descendant — would
      // either fail mid-copy or produce an infinite tree.
      if (entryStat.isDirectory() && toTarget.startsWith(fromTarget + sep)) {
        throw new Error("Cannot copy a directory into itself");
      }

      if (existsSync(toTarget)) {
        throw new Error("A file or directory already exists at the destination");
      }

      const toParent = dirname(toTarget);
      if (!existsSync(toParent)) {
        throw new Error("Destination parent directory does not exist");
      }
      const toParentStat = await stat(toParent);
      if (!toParentStat.isDirectory()) {
        throw new Error("Destination parent is not a directory");
      }

      // `cp` with `recursive: true` handles both files and directories.
      // `errorOnExist: true` guards against the race between our
      // existsSync check above and the write.
      await cp(fromTarget, toTarget, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });

      return {
        ok: true,
        kind: entryStat.isDirectory() ? ("directory" as const) : ("file" as const),
      };
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
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const cwd = workspace.worktree.path;
      const output = await execGit(["ls-files", "--cached", "--others", "--exclude-standard"], cwd);

      let files = output.trim().split("\n").filter(Boolean);

      if (input.query) {
        const scored: { file: string; score: number }[] = [];
        for (const f of files) {
          const score = fuzzyScore(input.query, f);
          if (score !== null) {
            scored.push({ file: f, score });
          }
        }
        scored.sort((a, b) => b.score - a.score);
        files = scored.map((r) => r.file);
      }

      return { files: files.slice(0, input.limit) };
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
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new Error("Workspace not found");
      }

      const cwd = workspace.worktree.path;

      // ripgrep is preferred over `git grep` here because git grep only sees
      // files in the index. Band workspaces frequently contain untracked
      // files (agents create files that aren't yet `git add`-ed) and those
      // would otherwise be invisible to find-in-files. ripgrep respects
      // `.gitignore` by default, matching git grep's effective filter for
      // tracked files while also surfacing untracked-but-not-ignored ones.
      const args: string[] = [];
      if (!input.caseSensitive) args.push("--ignore-case");
      if (input.wholeWord) args.push("--word-regexp");
      if (!input.regex) args.push("--fixed-strings");
      args.push("--json");
      // Pass the cwd as an explicit search path. Without a path argument,
      // ripgrep reads from stdin when its stdin is not a tty — under
      // `spawn` (which defaults to a piped stdin) that hangs forever.
      args.push("--", input.query, "./");

      return await new Promise<{
        results: Array<{ file: string; line: number; content: string }>;
      }>((resolvePromise, rejectPromise) => {
        const results: Array<{ file: string; line: number; content: string }> = [];
        // `stdio: ['ignore', 'pipe', 'pipe']` also closes stdin so ripgrep
        // can't fall back into stdin-reading mode.
        const child = spawn(rgPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let stdoutBuf = "";
        let stderrBuf = "";
        let settled = false;
        let killed = false;

        const finish = (value: typeof results) => {
          if (settled) return;
          settled = true;
          resolvePromise({ results: value });
        };

        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          rejectPromise(err);
        };

        child.stdout.setEncoding("utf-8");
        child.stdout.on("data", (chunk: string) => {
          if (settled) return;
          stdoutBuf += chunk;
          // ripgrep --json emits one JSON object per line.
          while (true) {
            const nlIdx = stdoutBuf.indexOf("\n");
            if (nlIdx === -1) break;
            const line = stdoutBuf.slice(0, nlIdx);
            stdoutBuf = stdoutBuf.slice(nlIdx + 1);
            if (!line) continue;

            let event: {
              type?: string;
              data?: {
                path?: { text?: string };
                line_number?: number;
                lines?: { text?: string };
              };
            };
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }

            if (event.type !== "match") continue;
            const data = event.data;
            if (!data) continue;
            const rawFile = data.path?.text;
            const lineNumber = data.line_number;
            const rawContent = data.lines?.text;
            // Non-UTF-8 paths/lines come back as `bytes` (base64) instead of
            // `text`. Skip those — they're rare in workspaces and the UI
            // can't render them sensibly.
            if (!rawFile || typeof lineNumber !== "number" || rawContent === undefined) {
              continue;
            }
            // ripgrep prefixes paths with the search root we passed (`./`).
            // Strip that to match the workspace-relative paths returned by
            // `workspace.searchFiles` (`git ls-files`).
            const file = rawFile.startsWith("./") ? rawFile.slice(2) : rawFile;
            const content = rawContent.endsWith("\n") ? rawContent.slice(0, -1) : rawContent;
            results.push({ file, line: lineNumber, content });

            if (results.length >= input.limit) {
              killed = true;
              child.kill("SIGTERM");
              finish(results);
              return;
            }
          }
        });

        child.stderr.setEncoding("utf-8");
        child.stderr.on("data", (chunk: string) => {
          stderrBuf += chunk;
        });

        child.on("error", (err) => {
          fail(err);
        });

        child.on("close", (code) => {
          if (settled) return;
          // ripgrep exit codes: 0 = matches found, 1 = no matches, 2 = error.
          // Both 0 and 1 are valid "no failure" outcomes for our purposes.
          if (code === 0 || code === 1 || killed) {
            finish(results);
          } else {
            fail(new Error(`ripgrep exited with code ${code}: ${stderrBuf.trim()}`));
          }
        });
      });
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
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Workspace not found" });
      }

      // Resolve the chat pane (use provided chatId or default)
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;

      // Abort any running task and clear queued messages so the new agent
      // starts with a clean slate.
      abortTask(chatId);
      clearQueuedMessages(chatId);

      // Replace the agent in the pool with the new agent type
      await replaceAgent(chatId, workspace.worktree.path, input.agentId);

      // Update the chat pane's agent config
      updateChat(chatId, { agent: input.agentId });

      // Update workspace status with the new coding agent ID
      upsertWorkspaceStatus(input.workspaceId, {
        status: "waiting",
        codingAgentId: input.agentId,
      });

      emit({ kind: "update", status: getWorkspaceStatus(input.workspaceId)! });

      return { ok: true };
    }),
});

// `host.*` (external file read/save outside any workspace root) migrated to
// `server/api/browser-host/router.ts` as part of Phase 7.5 (issue #517) —
// shares a file with `browserHost.*` because both belong to the desktop's
// host bridge.

// `tunnel.*` migrated to `server/api/tunnel/router.ts` (and the cloudflared
// process management at `services/tunnel-service.ts` /
// `infra/tunnels/tunnel-client.ts`) as part of Phase 7.5 (issue #517).

// `prereqs.*` migrated to `server/api/prereqs/router.ts` as part of
// Phase 7.5 (issue #517).

// ---------------------------------------------------------------------------
// Tasks — migrated to `server/api/tasks/router.ts` (Phase 6, issue #317).
// The merged tRPC surface still exposes `tasks.*` because
// `server/api/router.ts` composes the migrated sub-router with this legacy
// file. Do NOT re-add a `tasks` key below; `mergeRouters` is
// last-write-wins for duplicate keys, so a stray re-definition would
// silently mask the migrated router. See the INVARIANT comment in
// `server/api/router.ts`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sessions — migrated to `server/api/sessions/router.ts` (Phase 6, issue
// #317). Same invariant as `tasks` above: do NOT re-declare `sessions`
// here.
//
// The legacy `sessions.messages` query was the AI-SDK-shaped history
// endpoint used by the old `loadMessages → reconnectToStream` dance in
// ChatView. It has been replaced by the chat-events stream
// (`GET /api/chats/:chatId/events`), which handles JSONL backfill + live
// tail in a single subscription. See `docs/experiments/chat-event-log.md`.
// ---------------------------------------------------------------------------

// `services.*` migrated to `server/api/system/router.ts` (the internal
// name is `systemRouter` to follow the 3-tier convention, but it's
// mounted under the public `services` key in `server/api/router.ts` so
// every existing client keeps calling `trpc.services.*` without change)
// as part of Phase 7.5 (issue #517).

// `editor.*` migrated to `server/api/editor/router.ts` (and the editor
// domain service at `services/editor-service.ts`) as part of Phase 7.5
// (issue #517).

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

const chatRouter = t.router({
  answer: publicProcedure
    .input(z.object({ approvalId: z.string(), answers: z.record(z.string(), z.string()) }))
    .mutation(({ input }) => {
      const resolved = resolvePendingInput(input.approvalId, input.answers);
      if (!resolved) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No pending input found for this approvalId",
        });
      }
      return { ok: true };
    }),
});

// `statuses.*` migrated to `server/api/statuses/router.ts` as part of
// Phase 7.5 (issue #517).

// `status.*` migrated to `server/api/statuses/router.ts` as part of Phase 7.5
// (issue #517). Shares a file with `statuses.*` because the two sub-routers
// share `lib/watcher` and the same domain.

// Cronjobs have been migrated to `server/api/cronjobs/router.ts` as part of
// Phase 4 of the 3-tier refactor (issue #315). The sub-router is merged into
// the public `appRouter` in `server/api/router.ts`; this file no longer
// declares a `cronjobs` key (see the merge invariant documented there).

// `skills.*` migrated to `server/api/skills/router.ts` as part of Phase 7.5
// (issue #517).

// `modes.*` migrated to `server/api/modes/router.ts` as part of Phase 7.5
// (issue #517).

// `models.*` migrated to `server/api/models/router.ts` as part of Phase 7.5
// (issue #517).

// `browserHost.*` migrated to `server/api/browser-host/router.ts` as part of
// Phase 7.5 (issue #517). The bridge between the web server and the desktop's
// BrowserViewManager now lives there; the `browserHost` key is exposed via
// the merged root router in `server/api/router.ts` (do not re-add it here).

// ---------------------------------------------------------------------------
// Browser history (persistent per-workspace visit log).
//
// Surfaced as `trpc.history.*` and consumed by:
//   - `BrowserPanel` listeners — call `record` on each committed
//     navigation and `updateMeta` when `page-title-updated` fires.
//   - `useBrowserPaneControls` — calls `search` to drive address-bar
//     autocomplete.
//   - `HistoryPopover` — calls `list` / `search` / `delete` / `clear`.
//
// Visits are upserted on (workspaceId, url) — see `browser-history-store`
// for the dedupe/frecency rules.
// ---------------------------------------------------------------------------

const clearRangeSchema = z.enum(["hour", "day", "week", "all"]);

// Caps on the size of strings we persist. No real navigable URL is
// longer than 2048 chars (browsers historically cap somewhere
// between 2 KB and 8 KB; 2048 is the conservative web-server
// default). Titles can be longer in theory but we'd never display
// more than a few hundred chars. faviconUrl is normally just an
// origin + `/favicon.ico`. These caps protect against a misbehaving
// renderer inflating the DB with megabyte-sized `data:` URIs.
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 1024;

// Whitelist of URL schemes accepted for `faviconUrl`. The rendered
// `<img src={faviconUrl}>` in `HistoryPopover` /
// `AddressBarAutocomplete` would otherwise execute any scheme the
// renderer dreamt up — `data:image/...;base64,...` URIs would
// inflate the DB, and `javascript:` would be a renderer XSS vector
// (though the renderer is trusted; defence in depth still). Real
// favicons are always http(s) origin-relative.
const ALLOWED_FAVICON_SCHEMES = ["http:", "https:"] as const;
const faviconUrlSchema = z
  .string()
  .max(MAX_URL_LENGTH)
  .refine(
    (val) => {
      try {
        return ALLOWED_FAVICON_SCHEMES.includes(
          new URL(val).protocol as (typeof ALLOWED_FAVICON_SCHEMES)[number],
        );
      } catch {
        return false;
      }
    },
    { message: "faviconUrl must be a http(s) URL" },
  );

const historyRouter = t.router({
  record: publicProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        url: z.string().min(1).max(MAX_URL_LENGTH),
        title: z.string().max(MAX_TITLE_LENGTH).optional(),
        faviconUrl: faviconUrlSchema.optional(),
      }),
    )
    .mutation(({ input }) => {
      const recorded = recordVisit({
        workspaceId: input.workspaceId,
        url: input.url,
        title: input.title,
        faviconUrl: input.faviconUrl,
      });
      return { ok: true, recorded };
    }),

  updateMeta: publicProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        url: z.string().min(1).max(MAX_URL_LENGTH),
        title: z.string().max(MAX_TITLE_LENGTH).optional(),
        faviconUrl: faviconUrlSchema.optional(),
      }),
    )
    .mutation(({ input }) => {
      updateVisitMeta({
        workspaceId: input.workspaceId,
        url: input.url,
        title: input.title,
        faviconUrl: input.faviconUrl,
      });
      return { ok: true };
    }),

  list: publicProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        limit: z.number().int().positive().max(500).optional(),
        offset: z.number().int().nonnegative().optional(),
      }),
    )
    .query(({ input }) => {
      const entries = listHistory(input.workspaceId, {
        limit: input.limit,
        offset: input.offset,
      });
      return { entries };
    }),

  search: publicProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        query: z.string(),
        limit: z.number().int().positive().max(50).optional(),
      }),
    )
    .query(({ input }) => {
      const entries = searchHistory(input.workspaceId, input.query, input.limit ?? 8);
      return { entries };
    }),

  delete: publicProcedure
    // `positive()` rather than `nonnegative()` — autoincrement ids
    // start at 1. `workspaceId` scopes the delete so a caller that
    // knows a row id from a *different* workspace can't reach into
    // it.
    .input(z.object({ id: z.number().int().positive(), workspaceId: z.string().min(1) }))
    .mutation(({ input }) => {
      deleteHistoryEntry(input.id, input.workspaceId);
      return { ok: true };
    }),

  clear: publicProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        range: clearRangeSchema,
      }),
    )
    .mutation(({ input }) => {
      const deleted = clearHistory(input.workspaceId, input.range satisfies ClearRange);
      return { deleted };
    }),
});

// ---------------------------------------------------------------------------
// Queue (persisted queued messages)
// ---------------------------------------------------------------------------

/**
 * Wire shape accepted from tRPC clients. `path` is optional on input
 * because external/CLI callers may enqueue a raw `data:` URL that the
 * server has not yet persisted — we resolve a path in that case
 * (see `resolveQueuedFiles` below). Clients that already have the file
 * on disk (the dashboard's drag-reorder, for example) MUST forward the
 * existing `path` through unchanged so it survives the round-trip.
 */
const queuedFileSchema = z.object({
  mediaType: z.string(),
  url: z.string(),
  path: z.string().optional(),
  filename: z.string().optional(),
});

type QueuedFileInput = z.infer<typeof queuedFileSchema>;

/**
 * Ensure every enqueued file has a persisted on-disk `path`. Two shapes
 * to handle:
 *
 *   1. The client already saved the bytes (e.g. dashboard reorder via
 *      `queue.set`) and forwards `path` + a `/api/uploads/...` URL —
 *      pass through unchanged.
 *   2. The client hands us a `data:` URL with no `path` (e.g. CLI-driven
 *      enqueue from raw base64) — persist via `saveUploadedFilesDetailed`
 *      and rebuild the file record with the fresh path + stable URL.
 *
 * Any other shape (no `path`, non-data URL — there's no way to recover
 * the disk path from a bare URL) is dropped with a log entry rather
 * than silently inserted in a half-broken state.
 */
/**
 * Reject client-supplied paths that aren't under `<HOME>/.band/uploads/`.
 * Without this, an authenticated caller (local UI, CLI, or anyone with
 * the band_token) could enqueue `path: "/home/user/.ssh/id_rsa"` — the
 * drain in `task-service.ts` would inject the path verbatim into the
 * agent prompt as `I'm sharing these files with you:\n- /…/id_rsa`,
 * and the agent would happily read and stream the contents.
 *
 * Two-layer check:
 *   1. **String containment** — normalize with `path.resolve` (catches
 *      `…/uploads/../../etc/passwd`-style traversal) and verify the
 *      result lives under the uploads dir. Pure string op, never
 *      throws, doesn't depend on the file existing.
 *   2. **Symlink defence** — if the file exists, walk symlinks with
 *      `realpathSync` and re-check containment of the canonical form,
 *      so an attacker who can place `~/.band/uploads/evil → /etc/passwd`
 *      can't bypass with a path inside the uploads dir.
 *
 * Splitting the checks avoids a previous failure mode where
 * `realpathSync` threw ENOENT on a previously-valid path (the file
 * was deleted between enqueue and use) and the attachment was
 * silently dropped from a queue.set roundtrip — see review on #500.
 * Now: missing file with a path that PASSES the string-containment
 * check is accepted (the drain may then fail to read it, surfacing
 * the issue to the user); missing file with an out-of-bounds path is
 * rejected up front.
 */
function isPathWithinUploadDir(p: string): boolean {
  const uploadDir = join(bandHome(), "uploads");
  // Layer 1: string-only containment. Catches `/etc/passwd` and any
  // `…/uploads/../../etc/passwd`-shaped traversal.
  const normalized = resolve(p);
  if (normalized !== uploadDir && !normalized.startsWith(uploadDir + sep)) {
    return false;
  }
  // Layer 2: symlink defence — only meaningful when the file actually
  // exists. `realpathSync` walks the symlink chain and returns the
  // canonical path; we then re-check containment. ENOENT means the
  // file isn't there yet (or was deleted), in which case layer 1 has
  // already accepted the normalized path — defer to the caller (the
  // drain) to surface the read failure rather than silently dropping.
  try {
    const canonicalUploadDir = realpathSync(uploadDir);
    const canonicalPath = realpathSync(p);
    return (
      canonicalPath === canonicalUploadDir || canonicalPath.startsWith(canonicalUploadDir + sep)
    );
  } catch {
    return true;
  }
}

async function resolveQueuedFiles(
  chatId: string,
  files: QueuedFileInput[] | undefined,
): Promise<{ mediaType: string; url: string; path: string; filename?: string }[] | undefined> {
  if (!files || files.length === 0) return undefined;

  const resolved: { mediaType: string; url: string; path: string; filename?: string }[] = [];
  const needsSave: QueuedFileInput[] = [];
  const needsSaveIdx: number[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    // Derive path from URL when the client doesn't supply one. The
    // SSE wire shape strips `path` (it's server-internal), so the
    // dashboard's drag-reorder round-trip lands here with just
    // `url: "/api/uploads/<storedName>"`. Reconstructing the path
    // server-side keeps the wire small AND prevents a malicious
    // client from spoofing a path that doesn't match its URL.
    const uploadsUrlMatch = file.url.match(/^\/api\/uploads\/(.+)$/);
    const derivedPath =
      file.path ?? (uploadsUrlMatch ? join(bandHome(), "uploads", uploadsUrlMatch[1]) : undefined);

    if (derivedPath) {
      // Containment check — never trust a client-supplied path, even
      // a derived one (an attacker could send
      // `url: "/api/uploads/../../etc/passwd"`).
      if (!isPathWithinUploadDir(derivedPath)) {
        log.warn(
          { chatId, path: derivedPath, filename: file.filename },
          "queue: dropping file with path outside uploads directory",
        );
        continue;
      }
      resolved.push({
        mediaType: file.mediaType,
        url: file.url,
        path: derivedPath,
        ...(file.filename !== undefined && { filename: file.filename }),
      });
      continue;
    }
    if (file.url.startsWith("data:")) {
      needsSave.push(file);
      // Record the slot in `resolved[]` (NOT the loop index `i`): when an
      // earlier entry is dropped (`log.warn` branch), `resolved` lags
      // `files` and `needsSaveIdx[k] = i` would point at the wrong slot,
      // silently corrupting one entry and orphaning another.
      needsSaveIdx.push(resolved.length);
      // Placeholder so we can splice into the right slot once saved.
      resolved.push({
        mediaType: file.mediaType,
        url: file.url,
        path: "",
        filename: file.filename,
      });
      continue;
    }
    log.warn(
      { chatId, url: file.url, filename: file.filename },
      "queue: dropping file with no path and non-data URL — cannot recover disk path",
    );
  }

  if (needsSave.length > 0) {
    const saved = await saveUploadedFilesDetailed(needsSave);
    // The splicing loop below is index-aligned: `saved[k]` MUST
    // correspond to `needsSave[k]`. `saveUploadedFilesDetailed` skips
    // entries that fail its data-URL regex (compacted output) and
    // could in principle return fewer results than the input. A
    // mid-batch skip would then misalign every subsequent slot —
    // `saved[k]` would be written into a slot that belongs to a
    // different file, silently corrupting the queued payload. We
    // pre-filter for data-URL entries, so a mismatch here means an
    // upstream regression (malformed data URL slipping through). When
    // that happens, refuse to splice and let the placeholders fall
    // through to the `.filter((f) => f.path !== "")` pruning step
    // below — losing the saved-but-unmappable files is the right
    // trade-off vs. silently corrupting another file's metadata.
    if (saved.length !== needsSave.length) {
      log.error(
        { chatId, expected: needsSave.length, got: saved.length },
        "queue: saveUploadedFilesDetailed returned unexpected count — dropping data-URL files (cannot map 1:1)",
      );
    } else {
      for (let k = 0; k < saved.length; k++) {
        const target = needsSaveIdx[k];
        resolved[target] = {
          mediaType: saved[k].mediaType,
          url: `/api/uploads/${saved[k].storedName}`,
          path: saved[k].path,
          ...(saved[k].originalName !== undefined && { filename: saved[k].originalName }),
        };
      }
    }
  }

  const finalized = resolved.filter((f) => f.path !== "");
  return finalized.length > 0 ? finalized : undefined;
}

const queueRouter = t.router({
  push: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        chatId: z.string().optional(),
        text: z.string(),
        files: z.array(queuedFileSchema).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      // If disk write fails (ENOSPC, permissions, etc.), degrade to a
      // text-only queue entry rather than reject the whole push with a
      // 500. Losing the attachment is annoying; losing the user's
      // typed message because their disk is full would be worse —
      // they'd have to retype it from scratch with no indication that
      // the text actually survived.
      let files: Awaited<ReturnType<typeof resolveQueuedFiles>>;
      try {
        files = await resolveQueuedFiles(chatId, input.files);
      } catch (err) {
        log.error(
          { chatId, err: err instanceof Error ? err.message : err },
          "queue.push: failed to persist file uploads; enqueuing text only",
        );
        files = undefined;
      }
      const message = pushQueuedMessage(chatId, { text: input.text, files });
      return {
        ok: true,
        message: toWireQueuedMessages([message])[0],
        messages: toWireQueuedMessages(getQueuedMessages(chatId)),
      };
    }),

  set: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        chatId: z.string().optional(),
        messages: z.array(
          z.object({
            id: z.string().optional(),
            text: z.string(),
            files: z.array(queuedFileSchema).optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      // Resolve files per message and tolerate per-message failures.
      // `Promise.all` would short-circuit on the first rejection and
      // leave any already-saved files orphaned on disk with no queue
      // entry referencing them. We log and drop the bad message's
      // files instead, so the reorder/set proceeds with the remaining
      // metadata intact.
      const messages = await Promise.all(
        input.messages.map(async (m) => {
          try {
            return {
              ...(m.id !== undefined && { id: m.id }),
              text: m.text,
              files: await resolveQueuedFiles(chatId, m.files),
            };
          } catch (err) {
            log.error(
              { chatId, messageId: m.id, err: err instanceof Error ? err.message : err },
              "queue: failed to resolve files for queued message; dropping its files",
            );
            return {
              ...(m.id !== undefined && { id: m.id }),
              text: m.text,
              files: undefined,
            };
          }
        }),
      );
      setQueuedMessages(chatId, messages);
      return { ok: true, messages: toWireQueuedMessages(getQueuedMessages(chatId)) };
    }),

  get: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .query(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      return { messages: toWireQueuedMessages(getQueuedMessages(chatId)) };
    }),

  remove: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional(), id: z.string() }))
    .mutation(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      const removed = removeQueuedMessage(chatId, input.id);
      return {
        ok: true,
        removed,
        messages: toWireQueuedMessages(getQueuedMessages(chatId)),
      };
    }),

  update: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        chatId: z.string().optional(),
        id: z.string(),
        text: z.string(),
      }),
    )
    .mutation(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      const updated = updateQueuedMessage(chatId, input.id, input.text);
      return {
        ok: true,
        updated,
        messages: toWireQueuedMessages(getQueuedMessages(chatId)),
      };
    }),

  shift: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .mutation(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      const message = shiftQueuedMessage(chatId);
      return { message: message ? toWireQueuedMessages([message])[0] : null };
    }),

  clear: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .mutation(({ input }) => {
      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      clearQueuedMessages(chatId);
      return { ok: true };
    }),

  stream: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .subscription(async function* (opts) {
      const chatId = opts.input.chatId ?? getOrCreateDefaultChat(opts.input.workspaceId).id;

      type Update = { messages: QueuedMessage[] };
      const queue: Update[] = [];
      let resolve: (() => void) | null = null;

      const unsubscribe = subscribeQueue((id, messages) => {
        if (id !== chatId) return;
        queue.push({ messages });
        resolve?.();
      });

      opts.signal?.addEventListener("abort", () => {
        unsubscribe();
        resolve?.();
      });

      // Emit current state immediately so the client is in sync.
      // `toWireQueuedMessages` strips the server-only `path` field —
      // see queued-message-store.ts for why.
      yield { messages: toWireQueuedMessages(getQueuedMessages(chatId)) };

      // Discard notifications that arrived between listener registration
      // and the initial yield — the initial yield already covers them.
      queue.length = 0;

      try {
        while (!opts.signal?.aborted) {
          while (queue.length > 0) {
            const update = queue.shift()!;
            yield { messages: toWireQueuedMessages(update.messages) };
          }
          await new Promise<void>((r) => {
            resolve = r;
          });
          resolve = null;
        }
      } finally {
        unsubscribe();
      }
    }),
});

// NOTE: the `terminal` and `terminalLayout` sub-routers were lifted into
// `server/api/terminals/router.ts` as part of Phase 7 (issue #318). The wire
// shape is preserved by `server/api/router.ts` via `mergeRouters` — see the
// invariant comment there.

// ---------------------------------------------------------------------------
// App Router
// ---------------------------------------------------------------------------

/**
 * Legacy app router — every domain still lives here except the ones
 * already migrated to `server/api/<domain>/router.ts`. The root router
 * at `server/api/router.ts` merges this with the migrated sub-routers
 * (e.g. `settings`, see issue #312) so the wire shape is unchanged
 * while the codebase moves toward the 3-tier layout described in
 * `docs/web-architecture.md`.
 */
export const appRouter = t.router({
  // Migrated sub-routers — these keys live in `server/api/<domain>/router.ts`
  // and are composed into the merged root router via
  // `server/api/router.ts`. Re-adding any of them here would shadow the
  // migrated sub-router (`mergeRouters` is last-write-wins), violating
  // the migration invariant documented next to the merged router:
  //   `projects`     → `server/api/projects/router.ts`        (issue #313)
  //   `workspaces`   → `server/api/workspaces/router.ts`      (issue #314)
  //   `settings`     → `server/api/settings/router.ts`        (issue #312)
  //   `cronjobs`     → `server/api/cronjobs/router.ts`        (issue #315)
  //   `chats` / `chatLayout` / `browsers` / `browserLayout`
  //                  → `server/api/chats|browsers/router.ts`  (issue #316)
  //   `terminal` / `terminalLayout`
  //                  → `server/api/terminals/router.ts`       (issue #318)
  //   `cli`, `hooks`, `host`, `browserHost`, `editor`, `tunnel`,
  //   `prereqs`, `skills`, `modes`, `models`, `statuses`, `status`,
  //   `services` (internally `system`)
  //                  → `server/api/<domain>/router.ts`        (issue #517)
  workspace: workspaceRouter,
  // `host`, `tunnel`, `prereqs` live under `server/api/<domain>/router.ts`
  // (Phase 7.5, issue #517).
  // `tasks` lives in `server/api/tasks/router.ts` (Phase 6, issue #317).
  // `sessions` lives in `server/api/sessions/router.ts` (Phase 6, issue #317).
  // `services` (internally renamed to `system`) lives in
  // `server/api/system/router.ts` (Phase 7.5, issue #517). It is mounted
  // under the public `services` key in `server/api/router.ts` so every
  // existing client keeps calling `trpc.services.*` without change.
  chat: chatRouter,
  history: historyRouter,
  queue: queueRouter,
});

// NOTE: the canonical `AppRouter` type now lives in
// `apps/web/src/server/api/router.ts` and reflects the merged tRPC surface
// (legacy router + migrated 3-tier sub-routers like `settings.*`). This
// file's `appRouter` is the legacy half only; it is consumed by
// `server/api/router.ts` via `mergeRouters` and should not be re-exported
// as `AppRouter` from here — doing so would describe a strictly-smaller
// router shape under the same name and silently mask the migrated
// procedures from any caller that imported from this module.
