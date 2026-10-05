import { isAbsolute, join, resolve, sep } from "node:path";
import type { FsStat, HostFs } from "@band-app/host-api";
import { formatFileLocation } from "@band-app/shared/file-location";
import { WorktreeNotFoundError } from "../errors";
import { hostRegistry } from "../infra/host/registry";
import { subscribeToFileChanges, type Unsubscribe } from "./file-watcher";
import { FormatterError, formatFile } from "./formatter";
import { emit } from "./watcher-service";
import { worktreeService } from "./worktree-service";

/**
 * Editor domain service.
 *
 * Absorbs the small helpers that used to live in `lib/`:
 *   - `lib/active-worktree.ts`   → the in-memory "currently focused
 *     worktree" hint that the CLI's `band open` falls back to.
 *   - `lib/formatter.ts`          → Prettier dispatcher (kept as a
 *     module-level helper in `services/formatter.ts`).
 *   - `lib/file-watcher.ts`       → per-worktree fs.watch lifecycle
 *     (kept as a module-level helper in `services/file-watcher.ts`).
 *
 * Plus a couple of behaviours that used to be inlined in the legacy
 * `editorRouter` (`apps/web/src/trpc/router.ts`):
 *   - LSP shutdown hooks (`host.lsp.killWorktree`, `host.lsp.killAll`) so
 *     the worktree cleanup path and the server-shutdown handler reach
 *     LSP state via the service tier rather than poking infra directly.
 *   - `openFile` resolution + SSE emit (used by the CLI's `band open`).
 *
 * Renderer-side dispatching of the `open-file` event still lives in the
 * renderer (`src/lib/dispatch-open-file.ts`) because it runs in the
 * browser, not the server — moving it across the process boundary would
 * be a no-op.
 */
export class EditorService {
  private activeWorktreeId: string | null = null;

  // -------------------------------------------------------------------------
  // Active-worktree tracking (process-local; resets on server restart)
  // -------------------------------------------------------------------------

  setActiveWorktree(worktreeId: string | null): void {
    this.activeWorktreeId = worktreeId && worktreeId.length > 0 ? worktreeId : null;
  }

  getActiveWorktree(): string | null {
    return this.activeWorktreeId;
  }

  // -------------------------------------------------------------------------
  // Formatting (delegates to the Prettier helper)
  // -------------------------------------------------------------------------

  /**
   * Format `content` using Prettier as if it were the file at `filePath`
   * inside `worktreeId`. Throws `FormatterError` for bad input (file
   * outside the worktree, Prettier syntax error, etc.); throws a
   * `WorktreeNotFoundError` when the worktree can't be resolved
   * (the caller maps both to tRPC errors — `formatFile` is one of the
   * historical NOT_FOUND carve-outs in `api/worktree/router.ts`).
   */
  async formatFile(
    worktreeId: string,
    filePath: string,
    content: string,
  ): Promise<Awaited<ReturnType<typeof formatFile>>> {
    const worktree = worktreeService.resolve(worktreeId);
    if (!worktree) {
      throw new WorktreeNotFoundError(worktreeId);
    }
    return formatFile(worktree.worktree.path, filePath, content, { fs: worktree.host.fs });
  }

  // -------------------------------------------------------------------------
  // File-change subscriptions (per-worktree fs.watch)
  // -------------------------------------------------------------------------

  subscribeToFileChanges(worktreeId: string, listener: (path: string | null) => void): Unsubscribe {
    return subscribeToFileChanges(worktreeId, listener);
  }

  // -------------------------------------------------------------------------
  // LSP lifecycle pass-throughs
  // -------------------------------------------------------------------------

  killWorktreeLspServers(worktreeId: string): Promise<void> {
    return hostRegistry.hostFor(worktreeId).lsp.killWorktree(worktreeId);
  }

  /** Stops every language server on every host, local and remote. One host failing does not stop the rest. */
  async killAllLspServers(): Promise<void> {
    await Promise.allSettled(hostRegistry.all().map((host) => host.lsp.killAll()));
  }

  // -------------------------------------------------------------------------
  // `band open` — resolve a CLI-supplied path and emit the SSE event
  // -------------------------------------------------------------------------

  async openFile(input: {
    worktreeId?: string;
    filePath: string;
    line?: number;
    lineEnd?: number;
    column?: number;
    focus?: boolean;
  }): Promise<{
    ok: true;
    worktreeId: string;
    filePath: string;
    external: boolean;
  }> {
    const targetWorktreeId = input.worktreeId ?? this.activeWorktreeId;
    if (!targetWorktreeId) {
      throw new EditorOpenError(
        "PRECONDITION_FAILED",
        "No active worktree. Open a worktree in the Band dashboard or pass --worktree.",
      );
    }

    const worktree = worktreeService.resolve(targetWorktreeId);
    if (!worktree) {
      throw new EditorOpenError("NOT_FOUND", `Worktree '${targetWorktreeId}' not found`);
    }

    const resolved = await this.resolveTarget(
      worktree.host.fs,
      worktree.worktree.path,
      input.filePath,
    );

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
    //   - In-worktree: emit a worktree-relative path so the renderer
    //     opens it in the worktree's Files panel.
    //   - External: file exists on disk but lives outside the active
    //     worktree's root. Pass the absolute path through verbatim so
    //     the FileViewer mounts it as an *external* tab.
    const payloadPath = resolved.inside ? resolved.relativePath! : resolved.canonicalTarget;

    const formatted = formatFileLocation(payloadPath, input.line, {
      lineEnd: input.lineEnd,
      column: input.column,
    });

    emit({
      kind: "open-file",
      worktreeId: targetWorktreeId,
      filePath: formatted,
      external: !resolved.inside,
      focus: input.focus ?? true,
    });

    return {
      ok: true,
      worktreeId: targetWorktreeId,
      filePath: formatted,
      external: !resolved.inside,
    };
  }

  /**
   * Resolve a path (absolute or worktree-relative) against a worktree and
   * report where it lands. Used by the dashboard's Quick Open to decide, for
   * an absolute-path query, whether to open the file as a normal
   * worktree-relative tab (when it lives *inside* the worktree) or as an
   * external tab (outside) — and, either way, whether it exists at all.
   *
   * Shares the exact canonicalize + segment-aware containment logic that
   * `openFile` uses, so an absolute path typed into Quick Open and the same
   * path passed to `band open` resolve identically. Unlike `openFile` this
   * neither emits an SSE event nor throws for a missing file — the caller
   * only offers to open when `exists && isFile`.
   */
  async resolvePath(input: { worktreeId: string; filePath: string }): Promise<{
    exists: boolean;
    isFile: boolean;
    /** True when the path lies outside the worktree worktree. */
    external: boolean;
    /** POSIX worktree-relative path, set only when inside the worktree. */
    worktreeRelativePath: string | null;
  }> {
    const worktree = worktreeService.resolve(input.worktreeId);
    if (!worktree) {
      throw new WorktreeNotFoundError(input.worktreeId);
    }
    const resolved = await this.resolveTarget(
      worktree.host.fs,
      worktree.worktree.path,
      input.filePath,
    );
    return {
      exists: resolved.exists,
      isFile: resolved.isFile,
      external: !resolved.inside,
      worktreeRelativePath: resolved.inside ? resolved.relativePath : null,
    };
  }

  /**
   * Shared resolution core for {@link openFile} and {@link resolvePath}:
   * canonicalize the target (following the deepest existing ancestor so
   * not-yet-created paths still classify), stat it, and run the
   * segment-aware containment check against the canonicalized worktree root.
   */
  private async resolveTarget(
    fs: HostFs,
    root: string,
    filePath: string,
  ): Promise<{
    canonicalTarget: string;
    exists: boolean;
    isFile: boolean;
    inside: boolean;
    /** POSIX worktree-relative path when `inside`, else null. */
    relativePath: string | null;
  }> {
    // Absolute paths are taken as-is; relative paths resolve against root.
    const absoluteTarget = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);

    // Canonicalize the worktree root so symlinked path prefixes
    // (macOS's `/var/folders` → `/private/var/folders` in particular)
    // compare equal. The CLI canonicalizes the user's argument before
    // sending, so a stored worktree path under `/var/...` would
    // otherwise look "outside" its real location. Async fs (fs/promises)
    // so the tRPC query handler never parks the event loop on sync I/O.
    let canonicalRoot = root;
    try {
      canonicalRoot = await fs.realpath(root);
    } catch {
      // worktree may have been deleted out from under us — leave as-is
    }

    // Canonicalize the user's path the same way. `realpath` fails on
    // missing files, so walk up to the deepest ancestor that does exist,
    // canonicalize that, then re-append the trailing segments. That
    // keeps the in-worktree check accurate for paths the user wants to
    // *create* as well.
    const canonicalTarget = await canonicalizeMaybeMissing(fs, absoluteTarget);

    let targetStat: FsStat | null = null;
    try {
      targetStat = await fs.stat(canonicalTarget, { followSymlinks: true });
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
      isFile: targetStat?.kind === "file",
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
async function canonicalizeMaybeMissing(fs: HostFs, p: string): Promise<string> {
  try {
    // Succeeds iff `p` exists and every component resolves.
    return await fs.realpath(p);
  } catch {
    // Missing / unresolvable — fall through to the walk-up below.
  }
  const parts = p.split(sep);
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join(sep) || sep;
    try {
      const canonicalPrefix = await fs.realpath(prefix);
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
