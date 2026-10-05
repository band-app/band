// ---------------------------------------------------------------------------
// Format-file result returned by `adapter.formatWorktreeFile`
// ---------------------------------------------------------------------------
//
// Mirrors the discriminated-union shape returned by the `worktree.formatFile`
// tRPC procedure. The procedure is pure: the client passes in editor content
// and gets back the formatted string. Disk persistence is the caller's
// responsibility (typically via the existing save flow).
//
// `skipped: true` means Prettier has no parser for the file (or it's covered
// by `.prettierignore`) — editors fire format-on-shortcut regardless of file
// type, so unsupported files are a soft no-op rather than an error.
// `skipped: false` reports the parser used, the formatted content, and a
// `changed` flag so the caller can decide whether to bother updating its
// editor buffer.

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
