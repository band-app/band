/**
 * Persisted-tab self-heal predicate for the FileViewer load-error
 * path (issue #539, fix layer 3).
 *
 * Pure function — no React, no state. Owns the four-branch decision
 * between "drop this tab because the user can't see / wouldn't want
 * it" and "leave the tab alone because the failure is on a
 * user-owned tab or is transient".
 *
 * Lives here, not inline in `CodeBrowserView`, because:
 *
 *   1. The branches are subtle (path equality + ENOENT-shaped error
 *      vs. literal `ENOENT` substring), and a unit test pinning the
 *      truth table is the right tool — co-locating the helper next
 *      to its sibling `dispatch-open-file.ts` mirrors the existing
 *      "tiny pure helper + side-by-side test" pattern in
 *      `apps/web/tests/dispatch-open-file.test.ts`.
 *   2. Exporting a symbol from a production module solely so a test
 *      can import it inverts the dependency direction — the helper
 *      belongs in its own module either way, with the test reaching
 *      into a stable public surface rather than into a component's
 *      internals.
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
 *
 * Tested in `apps/web/tests/persisted-tab-self-heal.test.ts`.
 */
export function shouldDropPersistedTab(
  failedPath: string,
  restoredTabPath: string | null,
  errorMessage: string,
): boolean {
  if (restoredTabPath !== failedPath) return false;
  return /ENOENT|no such file or directory/i.test(errorMessage);
}
