/**
 * In-memory tracking of the workspace the user is currently looking at in
 * the Band dashboard. Used by the CLI's `band open` command so a user
 * sitting in a terminal can fire a file at "wherever I'm focused right
 * now" without naming the workspace explicitly.
 *
 * The web UI calls `setActiveWorkspace` whenever its active workspace
 * changes (driven by route → workspace mapping). The CLI reads via
 * `getActiveWorkspace`. State is intentionally process-local and not
 * persisted — it's a UX hint, not durable state, and resetting on
 * server restart is the right behaviour (no UI mounted → no "active"
 * workspace).
 */
let activeWorkspaceId: string | null = null;

export function setActiveWorkspace(workspaceId: string | null): void {
  activeWorkspaceId = workspaceId && workspaceId.length > 0 ? workspaceId : null;
}

export function getActiveWorkspace(): string | null {
  return activeWorkspaceId;
}
