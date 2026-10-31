import { formatFileLocation } from "@band-app/shared/file-location";
import { resolveTarget } from "@band-app/worktree-ops/resolve-path";
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

    const resolved = await resolveTarget(worktree.host.fs, worktree.worktree.path, input.filePath);

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

// Re-export `FormatterError` so callers don't have to know whether the
// helper still lives in its standalone file or was inlined here.
export { FormatterError };

export const editorService = new EditorService();
