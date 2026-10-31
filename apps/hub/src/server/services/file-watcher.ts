import {
  type FileChangeListener,
  subscribeToFileChanges as subscribe,
  type Unsubscribe,
} from "@band-app/worktree-ops/file-watch";
import { worktreeService } from "./worktree-service";

// The watcher itself, with its ignore list and debounce, is shared with the
// worker's direct listener: `packages/worktree-ops/src/file-watch.ts`.
export type { FileChangeListener, Unsubscribe };

/**
 * Subscribe to external file-system changes inside a worktree. If the
 * worktree can't be resolved (e.g. it was just removed) the subscription is a
 * silent no-op so callers don't need a separate error-handling path.
 */
export function subscribeToFileChanges(
  worktreeId: string,
  listener: FileChangeListener,
): Unsubscribe {
  return subscribe(
    worktreeId,
    () => {
      const ws = worktreeService.resolve(worktreeId);
      return ws ? { host: ws.host, root: ws.worktree.path } : null;
    },
    listener,
  );
}
