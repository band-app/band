import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { formatFileLocation } from "@/dashboard";
import { emit } from "../../lib/watcher";
import { resolveWorkspace } from "../../lib/workspace";
import { killAllServers, killWorkspaceServers } from "../infra/lsp/lsp-manager";
import { subscribeToFileChanges, type Unsubscribe } from "./file-watcher";
import { FormatterError, formatFile } from "./formatter";

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
   * outside the worktree, Prettier syntax error, etc.); throws a plain
   * `Error` when the workspace can't be resolved (the caller maps both
   * to tRPC errors).
   */
  async formatFile(
    workspaceId: string,
    filePath: string,
    content: string,
  ): Promise<Awaited<ReturnType<typeof formatFile>>> {
    const workspace = resolveWorkspace(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`);
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

  openFile(input: {
    workspaceId?: string;
    filePath: string;
    line?: number;
    lineEnd?: number;
    column?: number;
    focus?: boolean;
  }): {
    ok: true;
    workspaceId: string;
    filePath: string;
    external: boolean;
  } {
    const targetWorkspaceId = input.workspaceId ?? this.activeWorkspaceId;
    if (!targetWorkspaceId) {
      throw new EditorOpenError(
        "PRECONDITION_FAILED",
        "No active workspace. Open a workspace in the Band dashboard or pass --workspace.",
      );
    }

    const workspace = resolveWorkspace(targetWorkspaceId);
    if (!workspace) {
      throw new EditorOpenError("NOT_FOUND", `Workspace '${targetWorkspaceId}' not found`);
    }

    const root = workspace.worktree.path;

    // Resolve the path: absolute paths are taken as-is; relative paths
    // are resolved against the workspace root.
    const absoluteTarget = isAbsolute(input.filePath)
      ? resolve(input.filePath)
      : resolve(root, input.filePath);

    // Canonicalize the workspace root so symlinked path prefixes
    // (macOS's `/var/folders` → `/private/var/folders` in particular)
    // compare equal. The CLI canonicalizes the user's argument before
    // sending, so a stored worktree path under `/var/...` would
    // otherwise look "outside" its real location.
    let canonicalRoot = root;
    try {
      canonicalRoot = realpathSync(root);
    } catch {
      // worktree may have been deleted out from under us — leave as-is
    }

    // Canonicalize the user's path the same way. `realpathSync` fails on
    // missing files, so walk up to the deepest ancestor that does exist,
    // canonicalize that, then re-append the trailing segments. That
    // keeps the in-workspace check accurate for paths the user wants to
    // *create* as well.
    const canonicalTarget = canonicalizeMaybeMissing(absoluteTarget);

    // `existsSync` is true for directories too. Without the `isFile`
    // guard, `band open /path/to/some-dir` would pass through to the
    // renderer as an external "file" and the editor would try to open
    // the directory as a text buffer.
    let targetStat: import("node:fs").Stats | null = null;
    try {
      targetStat = statSync(canonicalTarget);
    } catch {
      // ENOENT or another IO error — surfaced as "File not found" below.
    }
    if (!targetStat) {
      throw new EditorOpenError("NOT_FOUND", `File not found: ${input.filePath}`);
    }
    if (!targetStat.isFile()) {
      throw new EditorOpenError("BAD_REQUEST", `Not a file: ${input.filePath}`);
    }

    // Segment-aware containment check (same invariant as the untitled
    // save flow in CodeBrowserView): a naive `startsWith` would treat
    // `/a/band-fork/x.ts` as inside `/a/band`.
    const normalizedRoot = canonicalRoot.replace(/\/+$/, "");
    const isInside =
      canonicalTarget === normalizedRoot || canonicalTarget.startsWith(`${normalizedRoot}${sep}`);

    // Two open modes share this procedure:
    //   - In-workspace: emit a workspace-relative path so the renderer
    //     opens it in the workspace's Files panel.
    //   - External: file exists on disk but lives outside the active
    //     workspace's root. Pass the absolute path through verbatim so
    //     the FileViewer mounts it as an *external* tab.
    let payloadPath: string;
    if (isInside) {
      const relativePath =
        canonicalTarget === normalizedRoot ? "" : canonicalTarget.slice(normalizedRoot.length + 1);
      // POSIX separators on the wire — tanstack-router and
      // `parseFileLocation` both work off `/`-separated paths.
      payloadPath = relativePath.split(sep).join("/");
    } else {
      payloadPath = canonicalTarget;
    }

    const formatted = formatFileLocation(payloadPath, input.line, {
      lineEnd: input.lineEnd,
      column: input.column,
    });

    emit({
      kind: "open-file",
      workspaceId: targetWorkspaceId,
      filePath: formatted,
      external: !isInside,
      focus: input.focus ?? true,
    });

    return {
      ok: true,
      workspaceId: targetWorkspaceId,
      filePath: formatted,
      external: !isInside,
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
 * `realpathSync` resolves symlinks but throws ENOENT for paths that don't
 * exist. We need the symlink-resolution part for paths that may or may not
 * exist (e.g. files the user wants to *open* that don't exist yet). Walk
 * up the path until we hit an ancestor that does exist, canonicalize that,
 * then re-append the trailing segments.
 */
function canonicalizeMaybeMissing(p: string): string {
  if (existsSync(p)) {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  }
  const parts = p.split(sep);
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join(sep) || sep;
    if (existsSync(prefix)) {
      try {
        const canonicalPrefix = realpathSync(prefix);
        // `path.join` collapses the duplicate separator that arises when
        // `canonicalPrefix === "/"`.
        return join(canonicalPrefix, ...parts.slice(i));
      } catch {
        return p;
      }
    }
  }
  return p;
}

// Re-export `FormatterError` so callers don't have to know whether the
// helper still lives in its standalone file or was inlined here.
export { FormatterError };

export const editorService = new EditorService();
