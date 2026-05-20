import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import type { FormatFileResult } from "@band-app/dashboard-core";
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
// format on every Shift+Alt+F regardless of file type, so unsupported
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

// `FormatFileResult` is defined in `@band-app/dashboard-core` because the
// client-side adapter contract is the load-bearing public surface; the
// server is the *implementer*, so it imports the shape rather than
// re-declaring it. A future field addition (e.g. `warnings`) means
// updating one place and TypeScript will fail this function's annotated
// return type if the implementation drifts.

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

  // Clear Prettier's `resolveConfig` cache up-front so the user's latest
  // `.prettierrc` (or `package.json::prettier`) is used for *both*
  // `getFileInfo` (which honours `resolveConfig: true` to pick up plugin-
  // supplied parsers) and the explicit `resolveConfig` call further down.
  // Cost is one extra worktree walk per format — small, and the
  // alternative (stale config) is far more confusing.
  prettier.clearConfigCache();

  // `inferredParser` is null when Prettier has no built-in parser for the
  // file's extension (and no plugin registers one). That's our soft-skip
  // signal — explicitly preferred over `getSupportInfo` so any project-
  // level `plugins` config a user has set is honoured.
  //
  // `ignorePath` has to be supplied explicitly: Prettier's programmatic API
  // (unlike its CLI) does not auto-discover `.prettierignore`. Without
  // this, `info.ignored` would always be `false` and the ignore-rule
  // soft-skip path would never fire.
  const ignorePath = resolvePath(worktreePath, ".prettierignore");
  const info = await prettier.getFileInfo(absFile, {
    resolveConfig: true,
    ignorePath: existsSync(ignorePath) ? ignorePath : undefined,
  });
  // Order matters: `.prettierignore` matches set both `ignored: true` and
  // `inferredParser: null`, so check `ignored` first to produce the more
  // specific reason. Otherwise the no-parser branch swallows them.
  if (info.ignored) {
    return {
      skipped: true,
      file: absFile,
      reason: `Ignored by .prettierignore`,
      durationMs: Date.now() - start,
    };
  }
  if (info.inferredParser === null) {
    return {
      skipped: true,
      file: absFile,
      reason: `Prettier has no parser for ${absFile}`,
      durationMs: Date.now() - start,
    };
  }

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
  // A plain prefix check is symlink-naive: a symlink inside the worktree
  // pointing at e.g. `/etc` would let `worktreePath/link/passwd` pass the
  // guard even though `realpath` resolves it outside the worktree. The
  // formatter is pure (never reads `absFile`), but `prettier.resolveConfig`
  // walks up from the supplied path looking for `.prettierrc` — so a
  // traversal could surface config from an unintended location. Harden by
  // resolving real paths on both sides before comparing.
  let realFile: string;
  try {
    realFile = realpathSync(absFile);
  } catch {
    // File doesn't exist on disk yet (untitled / unsaved buffer). Resolve
    // the parent directory instead; the leaf is the user's choice and
    // hasn't been materialized into a possibly-traversal-y symlink yet.
    try {
      realFile = join(realpathSync(dirname(absFile)), basename(absFile));
    } catch {
      // Neither the file nor its parent exists yet (e.g. a deep new path
      // the user hasn't materialized). With nothing on disk there's no
      // symlink to follow, so `absFile` is already the `resolvePath`-
      // normalized canonical string — the prefix check below still
      // correctly rejects any path that resolves outside the worktree.
      realFile = absFile;
    }
  }
  let realWorktree: string;
  try {
    realWorktree = realpathSync(worktreePath);
  } catch {
    realWorktree = worktreePath;
  }
  const normalized = realWorktree.endsWith("/") ? realWorktree : `${realWorktree}/`;
  return realFile === realWorktree || realFile.startsWith(normalized);
}
