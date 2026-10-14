/**
 * Moves what the hub stores under one worktree id to another: the chats, terminals and browser
 * tabs (`panel_states`), tasks, agent sessions, cron jobs, subscriptions, browser history, usage
 * and client state. Used when a worktree is restored on another host and so gets a new id.
 */

import { eq, sql } from "drizzle-orm";
import { getDb } from "../connection";
import {
  agentSessions,
  browserHistory,
  clientState,
  cronjobs,
  panelStates,
  pushedShas,
  subscriptions,
  tasks,
  usageEvents,
  worktreeStatuses,
  worktreeStatusSources,
  worktrees,
} from "../schema";

/**
 * Deletes what a worktree id holds under a unique key, so that rekeying another worktree onto the
 * id cannot collide. Used when a continuation replaces an older superseded copy that had the id.
 */
export function clearWorktreeKeyedRows(worktreeId: string): void {
  getDb().transaction((tx) => {
    tx.delete(panelStates).where(eq(panelStates.worktreeId, worktreeId)).run();
    tx.delete(clientState).where(eq(clientState.worktreeId, worktreeId)).run();
  });
}

export function rekeyWorktreeRows(oldId: string, newId: string): void {
  if (oldId === newId) return;
  getDb().transaction((tx) => {
    tx.update(panelStates)
      .set({ worktreeId: newId })
      .where(eq(panelStates.worktreeId, oldId))
      .run();
    tx.update(tasks).set({ worktreeId: newId }).where(eq(tasks.worktreeId, oldId)).run();
    tx.update(agentSessions)
      .set({ worktreeId: newId })
      .where(eq(agentSessions.worktreeId, oldId))
      .run();
    tx.update(cronjobs).set({ worktreeId: newId }).where(eq(cronjobs.worktreeId, oldId)).run();
    tx.update(subscriptions)
      .set({ worktreeId: newId })
      .where(eq(subscriptions.worktreeId, oldId))
      .run();
    tx.update(browserHistory)
      .set({ worktreeId: newId })
      .where(eq(browserHistory.worktreeId, oldId))
      .run();
    tx.update(usageEvents)
      .set({ worktreeId: newId })
      .where(eq(usageEvents.worktreeId, oldId))
      .run();
    tx.update(pushedShas).set({ worktreeId: newId }).where(eq(pushedShas.worktreeId, oldId)).run();
    // Worktrees started from this one now point at the new id.
    tx.update(worktrees)
      .set({ originWorktreeId: newId })
      .where(eq(worktrees.originWorktreeId, oldId))
      .run();
    // The new worktree gets its own status; the old one is recomputed from nothing.
    tx.delete(worktreeStatuses).where(eq(worktreeStatuses.worktreeId, oldId)).run();
    tx.delete(worktreeStatusSources).where(eq(worktreeStatusSources.worktreeId, oldId)).run();
    // A client-state key embeds the worktree id after a prefix, like `band:center-tabs:<id>`.
    tx.run(sql`UPDATE ${clientState} SET
      key = substr(key, 1, instr(key, worktree_id) - 1) || ${newId} || substr(key, instr(key, worktree_id) + length(worktree_id)),
      worktree_id = ${newId}
      WHERE worktree_id = ${oldId} AND instr(key, worktree_id) > 0`);
  });
}
