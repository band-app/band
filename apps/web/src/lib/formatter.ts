import { isAbsolute, resolve as resolvePath } from "node:path";
import { createLogger } from "@band-app/logger";
import prettier from "prettier";

const log = createLogger("formatter");

// ---------------------------------------------------------------------------
// Result + error types
// ---------------------------------------------------------------------------
//
// The formatter is a pure function: it takes `content` in, runs Prettier
// against it, returns `formatted` out. The on-disk file is never read or
// written — the client owns save semantics. This keeps the format flow
// independent of the user's "have I saved yet?" state and lets the
// dashboard format the editor buffer directly without a round-trip
// through disk.
//
// `skipped: true` is the soft-skip path: Prettier has no parser for the
// file's extension (or it's covered by `.prettierignore`). Editors fire
// format on every Cmd+Shift+F regardless of file type, so unsupported
// files need to be a no-op, not an error.

export type FormatErrorCode = "FILE_NOT_IN_WORKTREE" | "PRETTIER_FAILED";

export class FormatterError extends Error {
  readonly code: FormatErrorCode;
  readonly detail?: unknown;
  constructor(code: FormatErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "FormatterError";
    this.code = code;
    this.detail = detail;
  }
}

export type FormatFileResult =
  | {
      skipped: true;
      file: string;
      reason: string;
      durationMs: number;
    }
  | {
      skipped: false;
      file: string;
      parser: string;
      formatted: string;
      changed: boolean;
      durationMs: number;
    };

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

interface FormatFileOptions {
  /**
   * Override Prettier's config resolution (test hook). Production callers
   * always omit this so Prettier walks the worktree to discover
   * `.prettierrc*`, `prettier.config.js`, or the `package.json::prettier`
   * field — matching how the project's own `pnpm prettier --write` runs.
   */
  configOverride?: prettier.Options | null;
}

/**
 * Format `content` using Prettier as if it were the file at `filePath`
 * inside `worktreePath`. The function is pure: it does not read or write
 * the file on disk. The client is responsible for handing in the current
 * editor buffer (typically from a live CodeMirror view) and for applying
 * the returned `formatted` string back to that buffer.
 *
 * `filePath` is still required because Prettier infers the parser from
 * the file's extension and walks up its directory tree to discover
 * `.prettierrc` / `package.json::prettier` config. We accept it as an
 * absolute path or a worktree-relative one; either way the resolved
 * absolute path must lie inside `worktreePath`.
 */
export async function formatFile(
  worktreePath: string,
  filePath: string,
  content: string,
  options: FormatFileOptions = {},
): Promise<FormatFileResult> {
  const absFile = isAbsolute(filePath) ? filePath : resolvePath(worktreePath, filePath);

  if (!isInsideWorktree(absFile, worktreePath)) {
    throw new FormatterError(
      "FILE_NOT_IN_WORKTREE",
      `File ${absFile} is outside the worktree ${worktreePath}`,
    );
  }

  const start = Date.now();

  // `inferredParser` is null when Prettier has no built-in parser for the
  // file's extension (and no plugin registers one). That's our soft-skip
  // signal — explicitly preferred over `getSupportInfo` so any project-
  // level `plugins` config a user has set is honoured.
  const info = await prettier.getFileInfo(absFile, { resolveConfig: true });
  if (info.inferredParser === null) {
    return {
      skipped: true,
      file: absFile,
      reason: `Prettier has no parser for ${absFile}`,
      durationMs: Date.now() - start,
    };
  }
  if (info.ignored) {
    return {
      skipped: true,
      file: absFile,
      reason: `Ignored by .prettierignore`,
      durationMs: Date.now() - start,
    };
  }

  // Clear Prettier's `resolveConfig` cache so edits the user just made to
  // `.prettierrc` (or to a `package.json::prettier` field) take effect on
  // the next ⌘⇧F without restarting the server. The cost is small — a
  // re-walk of the worktree — and the alternative (stale config) is far
  // more confusing.
  prettier.clearConfigCache();
  const config =
    options.configOverride !== undefined
      ? options.configOverride
      : await prettier.resolveConfig(absFile);

  let formatted: string;
  try {
    formatted = await prettier.format(content, {
      ...(config ?? {}),
      filepath: absFile,
    });
  } catch (err) {
    // Prettier throws on syntax errors with a helpful message that points
    // at the offending line. Surface it verbatim — the user can map it
    // back to the broken code in their editor.
    const message = err instanceof Error ? err.message : String(err);
    throw new FormatterError("PRETTIER_FAILED", message);
  }

  const changed = formatted !== content;
  if (changed) {
    log.info(
      "Formatted %s with parser=%s (%d bytes in)",
      absFile,
      info.inferredParser,
      content.length,
    );
  }

  return {
    skipped: false,
    file: absFile,
    parser: info.inferredParser,
    formatted,
    changed,
    durationMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isInsideWorktree(absFile: string, worktreePath: string): boolean {
  const normalizedWorktree = worktreePath.endsWith("/") ? worktreePath : `${worktreePath}/`;
  return absFile === worktreePath || absFile.startsWith(normalizedWorktree);
}
