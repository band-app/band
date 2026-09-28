import { useCallback, useEffect, useRef } from "react";
import { clientStorage } from "../../lib/client-state";
import { toWorkspaceId } from "../lib/workspace-id";
import { useLabelFilter } from "./use-label-filter";
import { useProjects } from "./use-projects";

/**
 * Per-label "last selected workspace" memory.
 *
 * Lets the dashboard restore the workspace the user was last viewing under
 * a particular label when they switch back to that label (issue #505). The
 * map is stored as JSON in localStorage; both `getLastWorkspace` and
 * `setLastWorkspace` read and write storage at call time, so the hook needs no React state of its own — values are always fresh, and
 * callers that need reactivity should subscribe to the SYNC_EVENT directly.
 *
 * Two callers decide *when* to write: `useRecordLabelLastWorkspace` (below,
 * run by the app shell) when a workspace is opened under a label, and
 * `DashboardShell`'s `setLabelFilter` on a label switch. ALL (label ===
 * null) has no per-label memory: callers must not write the null key here.
 */

/** localStorage key for the per-label "last workspace" map. */
export const LABEL_LAST_WORKSPACE_KEY = "band.projects-list.label-last-workspace";

/** Custom event broadcast on every successful write. Cross-tab updates
 *  also reach consumers via the native `storage` event. No same-file
 *  consumer subscribes today; the event is exposed for future
 *  reactive use cases that might want to refresh when another tab
 *  mutates the map. */
const SYNC_EVENT = "band:label-last-workspace-change";

/** The saved map, label id to workspace id; empty when nothing is saved. */
export function readLabelLastWorkspaces(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LABEL_LAST_WORKSPACE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof k === "string" && typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    // Corrupted entry — start fresh.
  }
  return {};
}

function write(value: Record<string, string>): void {
  if (typeof window === "undefined") return;
  // NB: dispatch lives INSIDE the try block — intentional deviation
  // from `useLabelFilter.write`, which dispatches unconditionally. The
  // map carries cross-consumer state that subscribers re-read via
  // `readLabelLastWorkspaces()` on every SYNC_EVENT, so a failed
  // `setItem` paired with an unconditional dispatch would make every consumer pick up the
  // stale on-disk value and silently lose the caller's intended
  // update. `useLabelFilter`'s value is consumed locally per shell
  // rather than read back from storage on each event, so the
  // trade-off there doesn't apply.
  try {
    clientStorage.setItem(LABEL_LAST_WORKSPACE_KEY, JSON.stringify(value));
    window.dispatchEvent(new CustomEvent(SYNC_EVENT));
  } catch {
    // localStorage full or unavailable — ignore, and skip the dispatch.
  }
}

export interface UseLabelLastWorkspaceReturn {
  /** Look up the last workspaceId selected while `labelId` was active.
   *  Returns `undefined` when no history exists yet. */
  getLastWorkspace: (labelId: string) => string | undefined;
  /** Record `workspaceId` as the last workspace selected while `labelId`
   *  was active. Safe to call repeatedly with the same value (no-op when
   *  unchanged). */
  setLastWorkspace: (labelId: string, workspaceId: string) => void;
}

export function useLabelLastWorkspace(): UseLabelLastWorkspaceReturn {
  // Both methods read and write storage at call time. No React state is
  // needed because nothing about the map is rendered today —
  // `getLastWorkspace` is only invoked imperatively from
  // `DashboardShell.setLabelFilter` on a user action, where reading
  // localStorage directly gives an always-fresh value and frees the
  // callback closure from any React state, keeping
  // `getLastWorkspace`'s identity stable across navigations so
  // downstream `useCallback`s don't rebuild and the keyboard shortcut
  // listener doesn't re-attach. If a future reactive consumer is
  // added, subscribe to SYNC_EVENT + the native `storage` event in
  // that consumer rather than re-introducing global state here.
  const getLastWorkspace = useCallback((labelId: string) => readLabelLastWorkspaces()[labelId], []);
  const setLastWorkspace = useCallback((labelId: string, workspaceId: string) => {
    const current = readLabelLastWorkspaces();
    if (current[labelId] === workspaceId) return;
    write({ ...current, [labelId]: workspaceId });
  }, []);

  return { getLastWorkspace, setLastWorkspace };
}

/**
 * Record each workspace opened while a label is selected as that label's
 * last workspace, when its project carries the label (a workspace reached
 * through the ⌘K picker under another label isn't recorded).
 *
 * The app shell runs this, not `DashboardShell`: on a phone the dashboard
 * is a full-screen route that unmounts the moment a workspace is picked, so
 * an effect inside it never saw the new workspace.
 *
 * The `lastSeen` guard skips reruns caused by the label changing while the
 * workspace stays the same, i.e. right after a label switch and before its
 * restore navigation lands. Without it the incoming label would briefly get
 * the outgoing label's workspace and undo the restore. The guard starts
 * empty so the workspace on screen at load is recorded too, and a lookup
 * made before the project list has loaded doesn't consume it.
 */
export function useRecordLabelLastWorkspace(activeWorkspaceId: string | null): void {
  const [labelFilter] = useLabelFilter();
  const { projects } = useProjects();
  const { setLastWorkspace } = useLabelLastWorkspace();
  const lastSeen = useRef<string | null>(null);
  useEffect(() => {
    if (!activeWorkspaceId || !labelFilter) {
      // ALL has no per-label memory, but a later label switch must still
      // see the workspace as unchanged.
      lastSeen.current = activeWorkspaceId;
      return;
    }
    if (lastSeen.current === activeWorkspaceId || projects.length === 0) return;
    lastSeen.current = activeWorkspaceId;
    const project = projects.find((p) =>
      p.worktrees.some((wt) => toWorkspaceId(p.name, wt.name) === activeWorkspaceId),
    );
    if (project?.label === labelFilter) setLastWorkspace(labelFilter, activeWorkspaceId);
  }, [labelFilter, activeWorkspaceId, projects, setLastWorkspace]);
}
