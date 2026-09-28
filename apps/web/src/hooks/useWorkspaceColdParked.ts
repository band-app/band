import { useCallback, useSyncExternalStore } from "react";
import { isWorkspaceColdParked, subscribeWorkspaceColdPark } from "../lib/workspace-cold-park";

/** True while `workspaceId` is a cold-parked hidden workspace, whose heavy
 *  resources (LSP clients, file watchers) should be released until it is shown
 *  again. See `workspace-cold-park.ts`. */
export function useWorkspaceColdParked(workspaceId: string): boolean {
  const getSnapshot = useCallback(() => isWorkspaceColdParked(workspaceId), [workspaceId]);
  return useSyncExternalStore(subscribeWorkspaceColdPark, getSnapshot, () => false);
}
