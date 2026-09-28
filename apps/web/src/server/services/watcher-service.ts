/**
 * Services-tier façade over the infra status event bus
 * (`infra/events/status-event-bus.ts`).
 *
 * The bare `emit` / `subscribe` primitives + the `StatusEvent` shape
 * live in infra so the lower-level adapters (tunnel-client) can publish
 * without crossing into the services tier. This service adds the parts
 * that *do* belong here:
 *
 *   - the on-connect snapshot replay (current workspace statuses,
 *     branch statuses, running setup/teardown scripts) — needs DB access
 *     + the workspace-script registry, both services-tier concerns;
 *   - the branch-status poller lifecycle (start on first subscribe,
 *     stop when the last subscriber disconnects).
 *
 * `emit` and `StatusEvent` are re-exported so existing callers don't
 * need to change import paths in lock-step with the rename.
 */

import { getDb } from "../infra/db/connection";
import { branchStatuses as branchStatusesTable } from "../infra/db/schema";
import {
  emit,
  listenerCount,
  type StatusEvent,
  type StatusListener,
  subscribe as subscribeRaw,
} from "../infra/events/status-event-bus";
import { type BranchStatusPoller, branchStatusPoller } from "./branch-status-poller";
import { loadCurrentStatuses } from "./state";
import { workspaceScriptService } from "./workspace-script-service";

export type { StatusEvent };
export { emit };

export class WatcherService {
  constructor(private readonly poller: BranchStatusPoller = branchStatusPoller) {}

  /**
   * Read the persisted branch-status table and translate each row into
   * the wire-format `StatusEvent` the on-connect snapshot replay emits.
   * Lives on the service (not infra) because it joins DB rows into the
   * wire shape callers expect.
   */
  private loadCurrentBranchStatuses(): StatusEvent[] {
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
   * Ensures the branch-status poller is running (the poller's own
   * `pollerState.timer` guard makes a second `start()` a no-op when
   * another subscriber already kicked it off) and stops it when the
   * last subscriber disconnects via `listenerCount() === 0`.
   */
  subscribe(listener: StatusListener): () => void {
    const unsubscribeRaw = subscribeRaw(listener);
    this.poller.start();

    // Send current agent status snapshot (always include runningSetups for reconciliation)
    const statuses = loadCurrentStatuses();
    // Snapshot the running scripts once — used both for the `snapshot`
    // event below and the per-workspace `setup-status` loop.
    const runningScripts = workspaceScriptService.getRunning();
    const runningSetups = [...new Set(runningScripts.map((run) => run.workspaceId))];
    listener({ kind: "snapshot", statuses, runningSetups });

    // Send current branch status snapshots
    for (const event of this.loadCurrentBranchStatuses()) {
      listener(event);
    }

    // Send current setup status snapshots
    for (const { workspaceId, script } of runningScripts) {
      listener({ kind: "setup-status", workspaceId, script, setupState: "running" });
    }

    return () => {
      unsubscribeRaw();
      if (listenerCount() === 0) {
        this.poller.stop();
      }
    };
  }
}

export const watcherService = new WatcherService();
