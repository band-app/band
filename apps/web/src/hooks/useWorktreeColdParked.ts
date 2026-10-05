import { useCallback, useSyncExternalStore } from "react";
import { isWorktreeColdParked, subscribeWorktreeColdPark } from "../lib/worktree-cold-park";

/** True while `worktreeId` is a cold-parked hidden worktree, whose heavy
 *  resources (LSP clients, file watchers) should be released until it is shown
 *  again. See `worktree-cold-park.ts`. */
export function useWorktreeColdParked(worktreeId: string): boolean {
  const getSnapshot = useCallback(() => isWorktreeColdParked(worktreeId), [worktreeId]);
  return useSyncExternalStore(subscribeWorktreeColdPark, getSnapshot, () => false);
}
