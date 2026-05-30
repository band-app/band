/**
 * Persisted-tab self-heal predicate for the FileViewer load-error
 * path (issue #539, fix layer 3).
 *
 * Pure function — no React, no state. Owns the four-branch decision
 * between "drop this tab because the user can't see / wouldn't want
 * it" and "leave the tab alone because the failure is on a
 * user-owned tab or is transient".
 *
 * Lives in its own module so the four branches can be exhaustively
 * unit-tested with no React or component rendering involved.
 * Exporting from a component just to make the helper importable
 * from a test would invert the dependency direction; a stable
 * library-shaped surface is the right home.
 */

/**
 * Returns `true` iff the FileViewer's load failure for `failedPath`
 * should drive `handleTabClose(failedPath)` from
 * `CodeBrowserView.handleFileLoadError`.
 *
 * The four branches the function distinguishes:
 *
 *   | restoredTabPath | failedPath  | error contains ENOENT | drop? |
 *   |-----------------|-------------|-----------------------|-------|
 *   | null            | anything    | yes                   | no    |
 *   | "a.ts"          | "b.ts"      | yes                   | no    |
 *   | "a.ts"          | "a.ts"      | no                    | no    |
 *   | "a.ts"          | "a.ts"      | yes                   | YES   |
 *
 * The ENOENT marker is matched case-insensitively against both the
 * literal `ENOENT` substring (the shape from `fs.stat` rejection)
 * and the "no such file or directory" prose form (in case an
 * adapter wraps the rejection before forwarding).
 */
export function shouldDropPersistedTab(
  failedPath: string,
  restoredTabPath: string | null,
  errorMessage: string,
): boolean {
  if (restoredTabPath !== failedPath) return false;
  return /ENOENT|no such file or directory/i.test(errorMessage);
}
