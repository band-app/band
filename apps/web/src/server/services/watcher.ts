import { getDb } from "../infra/db/connection";
import { branchStatuses as branchStatusesTable } from "../infra/db/schema";
import {
  emit,
  listenerCount,
  type StatusEvent,
  type StatusListener,
  subscribe as subscribeRaw,
} from "../infra/events/status-event-bus";
import { startBranchStatusPoller, stopBranchStatusPoller } from "./branch-status-poller";
import { getRunningSetups } from "../infra/setup/setup-runner";
import { loadCurrentStatuses } from "./state";

/**
 * Services-tier façade over the infra status event bus
 * (`infra/events/status-event-bus.ts`).
 *
 * The bare `emit` / `subscribe` primitives + the `StatusEvent` shape live
 * in infra so the lower-level adapters (tunnel-client) can publish
 * without crossing into the services tier. This module adds the parts
 * that *do* belong in services:
 *
 *   - the on-connect snapshot replay (current workspace statuses, branch
 *     statuses, running setups) — needs DB access + the setup-runner
 *     registry, both services-tier concerns;
 *   - the branch-status poller lifecycle (start on first subscribe, stop
 *     when the last subscriber disconnects).
 */

export type { StatusEvent };

// Re-export the raw `emit` so existing callers (`services/*`, the
// `api/*` routers) don't need to migrate their import paths in lockstep
// with this refactor.
export { emit };

function loadCurrentBranchStatuses(): StatusEvent[] {
  const db = getDb();
  const rows = db.select().from(branchStatusesTable).all();
  return rows.map((row) => ({
    kind: "branch-status" as const,
    workspaceId: row.workspaceId,
    git: {
      dirty: row.gitDirty,
      conflict: row.gitConflict,
      ahead: row.gitAhead,
      behind: row.gitBehind,
      sync_state: row.gitSyncState,
    },
    ci: {
      state: row.ciState,
      url: row.ciUrl,
    },
  }));
}

/**
 * Subscribe to status events with the on-connect snapshot replay.
 * Starts the branch-status poller on the first subscribe and stops it
 * when the last subscriber disconnects.
 */
export function subscribe(listener: StatusListener): () => void {
  const unsubscribeRaw = subscribeRaw(listener);
  startBranchStatusPoller();

  // Send current agent status snapshot (always include runningSetups for reconciliation)
  const statuses = loadCurrentStatuses();
  const runningSetups = getRunningSetups();
  listener({ kind: "snapshot", statuses, runningSetups });

  // Send current branch status snapshots
  for (const event of loadCurrentBranchStatuses()) {
    listener(event);
  }

  // Send current setup status snapshots
  for (const workspaceId of getRunningSetups()) {
    listener({ kind: "setup-status", workspaceId, setupState: "running" });
  }

  return () => {
    unsubscribeRaw();
    if (listenerCount() === 0) {
      stopBranchStatusPoller();
    }
  };
}
