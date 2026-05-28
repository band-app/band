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
 *
 * CYCLE: this module sits on an ESM cycle —
 *   server/services/workspace-service.ts
 *     → lib/task-runner.ts
 *       → lib/workspace.ts (this file)
 *         → server/services/workspace-service.ts
 *
 * It works today only because every reference to `workspaceService` is
 * inside a function body (live binding), not at module top. Any future
 * commit that captures `workspaceService` at module load on one of those
 * legs (e.g. `const ws = workspaceService;` at the top of `task-runner.ts`
 * or this file) will silently get `undefined`. Keep all refs in function
 * scope until this shim is deleted alongside its last consumer.
 */
export function resolveWorkspace(workspaceId: string) {
  return workspaceService.resolve(workspaceId);
}
