import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { formatFileLocation } from "@/dashboard";
import { WorkspaceNotFoundError } from "../errors";
import { killAllServers, killWorkspaceServers } from "../infra/lsp/lsp-manager";
import { subscribeToFileChanges, type Unsubscribe } from "./file-watcher";
import { FormatterError, formatFile } from "./formatter";
import { emit } from "./watcher-service";
import { workspaceService } from "./workspace-service";

/**
 * Editor domain service.
 *
 * Absorbs the small helpers that used to live in `lib/`:
 *   - `lib/active-workspace.ts`   → the in-memory "currently focused
 *     workspace" hint that the CLI's `band open` falls back to.
 *   - `lib/formatter.ts`          → Prettier dispatcher (kept as a
 *     module-level helper in `services/formatter.ts`).
 *   - `lib/file-watcher.ts`       → per-workspace fs.watch lifecycle
 *     (kept as a module-level helper in `services/file-watcher.ts`).
 *
 * Plus a couple of behaviours that used to be inlined in the legacy
 * `editorRouter` (`apps/web/src/trpc/router.ts`):
 *   - LSP shutdown hooks (`killWorkspaceServers`, `killAllServers`) so
 *     the workspace cleanup path and the server-shutdown handler reach
 *     LSP state via the service tier rather than poking infra directly.
 *   - `openFile` resolution + SSE emit (used by the CLI's `band open`).
 *
 * Renderer-side dispatching of the `open-file` event still lives in the
 * renderer (`src/lib/dispatch-open-file.ts`) because it runs in the
 * browser, not the server — moving it across the process boundary would
 * be a no-op.
 */
export class EditorService {
  private activeWorkspaceId: string | null = null;

  // -------------------------------------------------------------------------
  // Active-workspace tracking (process-local; resets on server restart)
  // -------------------------------------------------------------------------

  setActiveWorkspace(workspaceId: string | null): void {
    this.activeWorkspaceId = workspaceId && workspaceId.length > 0 ? workspaceId : null;
  }

  getActiveWorkspace(): string | null {
    return this.activeWorkspaceId;
  }

  // -------------------------------------------------------------------------
  // Formatting (delegates to the Prettier helper)
  // -------------------------------------------------------------------------

  /**
   * Format `content` using Prettier as if it were the file at `filePath`
   * inside `workspaceId`. Throws `FormatterError` for bad input (file
   * outside the worktree, Prettier syntax error, etc.); throws a
   * `WorkspaceNotFoundError` when the workspace can't be resolved
   * (the caller maps both to tRPC errors — `formatFile` is one of the
   * historical NOT_FOUND carve-outs in `api/workspace/router.ts`).
   */
  async formatFile(
    workspaceId: string,
    filePath: string,
    content: string,
  ): Promise<Awaited<ReturnType<typeof formatFile>>> {
    const workspace = workspaceService.resolve(workspaceId);
    if (!workspace) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    return formatFile(workspace.worktree.path, filePath, content);
  }

  // -------------------------------------------------------------------------
  // File-change subscriptions (per-workspace fs.watch)
  // -------------------------------------------------------------------------

  subscribeToFileChanges(
    workspaceId: string,
    listener: (path: string | null) => void,
  ): Unsubscribe {
    return subscribeToFileChanges(workspaceId, listener);
  }

  // -------------------------------------------------------------------------
  // LSP lifecycle pass-throughs
  // -------------------------------------------------------------------------

  killWorkspaceLspServers(workspaceId: string): void {
    killWorkspaceServers(workspaceId);
  }

  killAllLspServers(): void {
    killAllServers();
  }

  // -------------------------------------------------------------------------
  // `band open` — resolve a CLI-supplied path and emit the SSE event
  // -------------------------------------------------------------------------

  async openFile(input: {
    workspaceId?: string;
    filePath: string;
    line?: number;
    lineEnd?: number;
    column?: number;
    focus?: boolean;
  }): Promise<{
    ok: true;
    workspaceId: string;
    filePath: string;
    external: boolean;
  }> {
    const targetWorkspaceId = input.workspaceId ?? this.activeWorkspaceId;
    if (!targetWorkspaceId) {
      throw new EditorOpenError(
        "PRECONDITION_FAILED",
        "No active workspace. Open a workspace in the Band dashboard or pass --workspace.",
      );
    }

    const workspace = workspaceService.resolve(targetWorkspaceId);
    if (!workspace) {
      throw new EditorOpenError("NOT_FOUND", `Workspace '${targetWorkspaceId}' not found`);
    }

    const resolved = await this.resolveTarget(workspace.worktree.path, input.filePath);

    // `stat` follows to a directory too. Without the `isFile`
    // guard, `band open /path/to/some-dir` would pass through to the
    // renderer as an external "file" and the editor would try to open
    // the directory as a text buffer.
    if (!resolved.exists) {
      throw new EditorOpenError("NOT_FOUND", `File not found: ${input.filePath}`);
    }
    if (!resolved.isFile) {
      throw new EditorOpenError("BAD_REQUEST", `Not a file: ${input.filePath}`);
    }

    // Two open modes share this procedure:
    //   - In-workspace: emit a workspace-relative path so the renderer
    //     opens it in the workspace's Files panel.
    //   - External: file exists on disk but lives outside the active
    //     workspace's root. Pass the absolute path through verbatim so
    //     the FileViewer mounts it as an *external* tab.
    const payloadPath = resolved.inside ? resolved.relativePath! : resolved.canonicalTarget;

    const formatted = formatFileLocation(payloadPath, input.line, {
      lineEnd: input.lineEnd,
      column: input.column,
    });

    emit({
      kind: "open-file",
      workspaceId: targetWorkspaceId,
      filePath: formatted,
      external: !resolved.inside,
      focus: input.focus ?? true,
    });

    return {
      ok: true,
      workspaceId: targetWorkspaceId,
      filePath: formatted,
      external: !resolved.inside,
    };
  }

  /**
   * Resolve a path (absolute or workspace-relative) against a workspace and
   * report where it lands. Used by the dashboard's Quick Open to decide, for
   * an absolute-path query, whether to open the file as a normal
   * workspace-relative tab (when it lives *inside* the worktree) or as an
   * external tab (outside) — and, either way, whether it exists at all.
   *
   * Shares the exact canonicalize + segment-aware containment logic that
   * `openFile` uses, so an absolute path typed into Quick Open and the same
   * path passed to `band open` resolve identically. Unlike `openFile` this
   * neither emits an SSE event nor throws for a missing file — the caller
   * only offers to open when `exists && isFile`.
   */
  async resolvePath(input: { workspaceId: string; filePath: string }): Promise<{
    exists: boolean;
    isFile: boolean;
    /** True when the path lies outside the workspace worktree. */
    external: boolean;
    /** POSIX workspace-relative path, set only when inside the worktree. */
    workspaceRelativePath: string | null;
  }> {
    const workspace = workspaceService.resolve(input.workspaceId);
    if (!workspace) {
      throw new WorkspaceNotFoundError(input.workspaceId);
    }
    const resolved = await this.resolveTarget(workspace.worktree.path, input.filePath);
    return {
      exists: resolved.exists,
      isFile: resolved.isFile,
      external: !resolved.inside,
      workspaceRelativePath: resolved.inside ? resolved.relativePath : null,
    };
  }

  /**
   * Shared resolution core for {@link openFile} and {@link resolvePath}:
   * canonicalize the target (following the deepest existing ancestor so
   * not-yet-created paths still classify), stat it, and run the
   * segment-aware containment check against the canonicalized worktree root.
   */
  private async resolveTarget(
    root: string,
    filePath: string,
  ): Promise<{
    canonicalTarget: string;
    exists: boolean;
    isFile: boolean;
    inside: boolean;
    /** POSIX workspace-relative path when `inside`, else null. */
    relativePath: string | null;
  }> {
    // Absolute paths are taken as-is; relative paths resolve against root.
    const absoluteTarget = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);

    // Canonicalize the workspace root so symlinked path prefixes
    // (macOS's `/var/folders` → `/private/var/folders` in particular)
    // compare equal. The CLI canonicalizes the user's argument before
    // sending, so a stored worktree path under `/var/...` would
    // otherwise look "outside" its real location. Async fs (fs/promises)
    // so the tRPC query handler never parks the event loop on sync I/O.
    let canonicalRoot = root;
    try {
      canonicalRoot = await realpath(root);
    } catch {
      // worktree may have been deleted out from under us — leave as-is
    }

    // Canonicalize the user's path the same way. `realpath` fails on
    // missing files, so walk up to the deepest ancestor that does exist,
    // canonicalize that, then re-append the trailing segments. That
    // keeps the in-workspace check accurate for paths the user wants to
    // *create* as well.
    const canonicalTarget = await canonicalizeMaybeMissing(absoluteTarget);

    let targetStat: import("node:fs").Stats | null = null;
    try {
      targetStat = await stat(canonicalTarget);
    } catch {
      // ENOENT or another IO error — reported via `exists: false`.
    }

    // Segment-aware containment check (same invariant as the untitled
    // save flow in CodeBrowserView): a naive `startsWith` would treat
    // `/a/band-fork/x.ts` as inside `/a/band`.
    const normalizedRoot = canonicalRoot.replace(/\/+$/, "");
    const inside =
      canonicalTarget === normalizedRoot || canonicalTarget.startsWith(`${normalizedRoot}${sep}`);

    // POSIX separators on the wire — tanstack-router and
    // `parseFileLocation` both work off `/`-separated paths.
    const relativePath = inside
      ? (canonicalTarget === normalizedRoot ? "" : canonicalTarget.slice(normalizedRoot.length + 1))
          .split(sep)
          .join("/")
      : null;

    return {
      canonicalTarget,
      exists: !!targetStat,
      isFile: !!targetStat?.isFile(),
      inside,
      relativePath,
    };
  }
}

/**
 * Discriminated error thrown by {@link EditorService.openFile}. The tRPC
 * layer maps these to the appropriate `TRPCError` codes; non-tRPC callers
 * can branch on `.code`.
 */
export class EditorOpenError extends Error {
  readonly code: "PRECONDITION_FAILED" | "NOT_FOUND" | "BAD_REQUEST";
  constructor(code: EditorOpenError["code"], message: string) {
    super(message);
    this.name = "EditorOpenError";
    this.code = code;
  }
}

/**
 * `realpath` resolves symlinks but throws ENOENT for paths that don't
 * exist. We need the symlink-resolution part for paths that may or may not
 * exist (e.g. files the user wants to *open* that don't exist yet). Try to
 * canonicalize the whole path; on failure walk up to the deepest ancestor
 * that does resolve, canonicalize that, then re-append the trailing
 * segments. Async (fs/promises) so callers don't block the event loop.
 */
async function canonicalizeMaybeMissing(p: string): Promise<string> {
  try {
    // Succeeds iff `p` exists and every component resolves.
    return await realpath(p);
  } catch {
    // Missing / unresolvable — fall through to the walk-up below.
  }
  const parts = p.split(sep);
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join(sep) || sep;
    try {
      const canonicalPrefix = await realpath(prefix);
      // `path.join` collapses the duplicate separator that arises when
      // `canonicalPrefix === "/"`.
      return join(canonicalPrefix, ...parts.slice(i));
    } catch {
      // keep walking up toward the root
    }
  }
  return p;
}

// Re-export `FormatterError` so callers don't have to know whether the
// helper still lives in its standalone file or was inlined here.
export { FormatterError };

export const editorService = new EditorService();
