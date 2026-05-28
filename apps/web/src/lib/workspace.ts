import { workspaceService } from "../server/services/workspace-service";

/**
 * Back-compat shim around `WorkspaceService.resolve` — preserves the legacy
 * `resolveWorkspace(workspaceId)` import surface so existing callers (the
 * legacy `trpc/router.ts`, `api/chat-events.ts`, and any other lib helpers
 * that haven't been migrated yet) keep compiling while later phases of the
 * 3-tier refactor (issue #314 onward) rewrite each call site to use the
 * service directly. The legacy implementation walked `loadState()`; the
 * service does exactly the same walk, so behaviour is identical.
 *
 * Returns `null` when the workspace id doesn't match any worktree row.
 */
export function resolveWorkspace(workspaceId: string) {
  return workspaceService.resolve(workspaceId);
}
