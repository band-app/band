/**
 * Renderer-side queue for external-file opens that arrive before the
 * target `CodeBrowserView` has mounted its listener.
 *
 * Why this exists: when `band open <abs-path-outside-workspace>` fires
 * the SSE event, `__root.tsx` needs to navigate to the workspace's code
 * route AND tell that view which external file to open. The route
 * mounts `CodeBrowserView`, but the view's `useEffect` subscribers
 * don't run until after React's next commit — dispatching a window
 * event in the microtask queue races against mount and gets silently
 * dropped.
 *
 * Design: a module-level Map<workspaceId, PendingOpen> with a
 * subscriber set. `__root.tsx` writes into the queue *before*
 * navigation. `CodeBrowserView` drains its slot synchronously on
 * mount (in the same `useEffect` that subscribes), so the pre-mount
 * payload is delivered before any subsequent event the view might
 * miss. Subsequent calls while the view is mounted reach it through
 * the subscriber callback.
 *
 * Same shape as the favicon store in `ScreencastPanel.tsx` — Map +
 * listener Set — which is the established codebase pattern for cross-
 * component renderer state without pulling in Jotai/Zustand.
 */

export interface PendingExternalOpen {
  /** Absolute filesystem path, optionally with `:line[:col]` / `:line-end` suffix. */
  filePath: string;
}

const pending = new Map<string, PendingExternalOpen>();
const listeners = new Set<() => void>();

/**
 * Queue an external-file open for the given workspace. Replaces any
 * existing pending open for the same workspace — the most recent
 * `band open` call wins, matching the user's intent.
 */
export function enqueueExternalOpen(workspaceId: string, filePath: string): void {
  pending.set(workspaceId, { filePath });
  for (const listener of listeners) listener();
}

/**
 * Read-and-remove the pending open for a workspace. Idempotent: calling
 * twice in a row returns `undefined` the second time. Callers should
 * invoke this once on mount (to catch pre-mount writes) and again
 * inside their subscriber callback (to catch writes while mounted).
 */
export function consumeExternalOpen(workspaceId: string): PendingExternalOpen | undefined {
  const value = pending.get(workspaceId);
  if (value === undefined) return undefined;
  pending.delete(workspaceId);
  return value;
}

export function subscribeExternalOpens(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
