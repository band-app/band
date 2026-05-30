/**
 * Pure decision helper for the QuickOpenDialog's autoOpen bail
 * (issue #539, fix layer 2).
 *
 * Lives in its own module so the contract can be unit-tested
 * without rendering the dialog. The ref-isolation correctness
 * (the open-capture effect must depend ONLY on `open`, not on
 * `workspaceId`) is enforced in `QuickOpenDialog.tsx` and
 * documented inline there; the predicate below is the only piece
 * of pure logic in the bail path.
 *
 * Unit-tested alongside the other dashboard `lib/` pure helpers
 * (`file-location.ts`, `file-icon.ts`, etc.).
 */

/**
 * Returns `true` iff the dialog should abandon its autoOpen
 * shortcut and silently close — i.e. the workspace the dialog
 * was opened against doesn't match the workspace it'd dispatch
 * `onOpenFile` against.
 *
 *   | capturedWorkspaceId | currentWorkspaceId | bail? |
 *   |---------------------|--------------------|-------|
 *   | null                | "A"                | no    |
 *   | "A"                 | "A"                | no    |
 *   | "A"                 | "B"                | YES   |
 *
 * The `null` capture branch covers the "open-effect hasn't fired
 * yet" state — the dialog hasn't actually committed to a workspace,
 * so there's nothing to bail against. Once captured, any prop flip
 * triggers the bail.
 */
export function shouldBailAutoOpen(
  capturedWorkspaceId: string | null,
  currentWorkspaceId: string,
): boolean {
  return capturedWorkspaceId !== null && capturedWorkspaceId !== currentWorkspaceId;
}
