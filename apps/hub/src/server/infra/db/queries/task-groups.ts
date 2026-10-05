/** Persistence for `task_groups`, `task_group_members` and `dispatch_requests`. `ProjectDispatchService` and `ProjectSubscriptionService` call this. */

import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "../connection";
import { dispatchRequests, taskGroupMembers, taskGroups } from "../schema";

export type TaskGroupRow = typeof taskGroups.$inferSelect;
export type TaskGroupMemberRow = typeof taskGroupMembers.$inferSelect;
export type DispatchRequestRow = typeof dispatchRequests.$inferSelect;

export class TaskGroupQueries {
  insertGroup(
    group: TaskGroupRow,
    members: Array<Pick<TaskGroupMemberRow, "repo" | "worktreeId" | "hostId" | "mergeOrder">>,
  ): void {
    getDb().transaction((tx) => {
      tx.insert(taskGroups).values(group).run();
      for (const m of members) {
        tx.insert(taskGroupMembers)
          .values({ groupId: group.id, prNumber: null, ...m })
          .run();
      }
    });
  }

  groupsOf(projectId: string): TaskGroupRow[] {
    return getDb()
      .select()
      .from(taskGroups)
      .where(eq(taskGroups.projectId, projectId))
      .orderBy(desc(taskGroups.createdAt))
      .all();
  }

  membersOf(groupId: string): TaskGroupMemberRow[] {
    return getDb()
      .select()
      .from(taskGroupMembers)
      .where(eq(taskGroupMembers.groupId, groupId))
      .orderBy(asc(taskGroupMembers.mergeOrder))
      .all();
  }

  /** The member that works in a worktree, with its group, or undefined when no group names it. */
  memberOfWorktree(
    worktreeId: string,
  ): { member: TaskGroupMemberRow; group: TaskGroupRow } | undefined {
    return getDb()
      .select({ member: taskGroupMembers, group: taskGroups })
      .from(taskGroupMembers)
      .innerJoin(taskGroups, eq(taskGroups.id, taskGroupMembers.groupId))
      .where(eq(taskGroupMembers.worktreeId, worktreeId))
      .get();
  }

  /** Every member of every group of a project. */
  membersOfProject(projectId: string): TaskGroupMemberRow[] {
    return getDb()
      .select({ member: taskGroupMembers })
      .from(taskGroupMembers)
      .innerJoin(taskGroups, eq(taskGroups.id, taskGroupMembers.groupId))
      .where(eq(taskGroups.projectId, projectId))
      .all()
      .map((r) => r.member);
  }

  setMemberPr(groupId: string, repo: string, prNumber: number | null): void {
    getDb()
      .update(taskGroupMembers)
      .set({ prNumber })
      .where(and(eq(taskGroupMembers.groupId, groupId), eq(taskGroupMembers.repo, repo)))
      .run();
  }

  setMemberHost(groupId: string, repo: string, hostId: string | null): void {
    getDb()
      .update(taskGroupMembers)
      .set({ hostId })
      .where(and(eq(taskGroupMembers.groupId, groupId), eq(taskGroupMembers.repo, repo)))
      .run();
  }

  insertRequest(row: DispatchRequestRow): void {
    getDb().insert(dispatchRequests).values(row).run();
  }

  findRequest(id: string): DispatchRequestRow | undefined {
    return getDb().select().from(dispatchRequests).where(eq(dispatchRequests.id, id)).get();
  }

  requestsOf(projectId: string, status?: string): DispatchRequestRow[] {
    const where = status
      ? and(eq(dispatchRequests.projectId, projectId), eq(dispatchRequests.status, status))
      : eq(dispatchRequests.projectId, projectId);
    return getDb()
      .select()
      .from(dispatchRequests)
      .where(where)
      .orderBy(desc(dispatchRequests.createdAt))
      .limit(100)
      .all();
  }

  /** Moves a pending request to `status`. False when it was already decided, so two decisions cannot both win. */
  decide(
    id: string,
    status: "approved" | "rejected" | "failed",
    patch: { error?: string | null; result?: Record<string, unknown> | null } = {},
  ): boolean {
    const res = getDb()
      .update(dispatchRequests)
      .set({
        status,
        decidedAt: Date.now(),
        error: patch.error ?? null,
        result: patch.result ?? null,
      })
      .where(and(eq(dispatchRequests.id, id), eq(dispatchRequests.status, "pending")))
      .run();
    return Number(res.changes ?? 0) > 0;
  }

  /** Records the outcome of an approved dispatch, once it has run. */
  finish(
    id: string,
    status: "approved" | "failed",
    patch: { error?: string; result?: Record<string, unknown> },
  ): void {
    getDb()
      .update(dispatchRequests)
      .set({ status, error: patch.error ?? null, result: patch.result ?? null })
      .where(eq(dispatchRequests.id, id))
      .run();
  }
}
