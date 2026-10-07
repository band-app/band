/** Persistence for `project_tasks` and `task_members` (plan step T.2). `TaskService` calls this. */

import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { projectTasks, taskMembers, worktrees } from "../schema";
import { setPanelStatesTask } from "./panel-states";

export type ProjectTaskRow = typeof projectTasks.$inferSelect;
export type TaskMemberRow = typeof taskMembers.$inferSelect;

export class ProjectTaskQueries {
  insert(task: ProjectTaskRow, members: TaskMemberRow[] = []): void {
    getDb().transaction((tx) => {
      tx.insert(projectTasks).values(task).run();
      for (const m of members) tx.insert(taskMembers).values(m).run();
    });
  }

  find(id: string): ProjectTaskRow | undefined {
    return getDb().select().from(projectTasks).where(eq(projectTasks.id, id)).get();
  }

  findByName(projectId: string, name: string): ProjectTaskRow | undefined {
    return getDb()
      .select()
      .from(projectTasks)
      .where(and(eq(projectTasks.projectId, projectId), eq(projectTasks.name, name)))
      .get();
  }

  /** Tasks of a project, newest first. */
  listOf(projectId: string): ProjectTaskRow[] {
    return getDb()
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.projectId, projectId))
      .orderBy(desc(projectTasks.createdAt))
      .all();
  }

  all(): ProjectTaskRow[] {
    return getDb().select().from(projectTasks).orderBy(desc(projectTasks.createdAt)).all();
  }

  setHost(id: string, hostId: string | null, briefPath?: string | null): void {
    getDb()
      .update(projectTasks)
      .set({ hostId, ...(briefPath !== undefined ? { briefPath } : {}) })
      .where(eq(projectTasks.id, id))
      .run();
  }

  setStatus(id: string, status: string): void {
    getDb().update(projectTasks).set({ status }).where(eq(projectTasks.id, id)).run();
  }

  remove(id: string): void {
    getDb().delete(projectTasks).where(eq(projectTasks.id, id)).run();
  }

  membersOf(taskId: string): TaskMemberRow[] {
    return getDb()
      .select()
      .from(taskMembers)
      .where(eq(taskMembers.taskId, taskId))
      .orderBy(asc(taskMembers.mergeOrder), asc(taskMembers.repoName))
      .all();
  }

  /** Every member of every task of a project. */
  membersOfProject(projectId: string): TaskMemberRow[] {
    return getDb()
      .select({ member: taskMembers })
      .from(taskMembers)
      .innerJoin(projectTasks, eq(projectTasks.id, taskMembers.taskId))
      .where(eq(projectTasks.projectId, projectId))
      .all()
      .map((r) => r.member);
  }

  /** The member that works in a worktree, with its task, or undefined when no task names it. */
  memberOfWorktree(
    worktreeId: string,
  ): { member: TaskMemberRow; task: ProjectTaskRow } | undefined {
    return getDb()
      .select({ member: taskMembers, task: projectTasks })
      .from(taskMembers)
      .innerJoin(projectTasks, eq(projectTasks.id, taskMembers.taskId))
      .where(eq(taskMembers.worktreeId, worktreeId))
      .get();
  }

  addMember(member: TaskMemberRow): void {
    getDb().insert(taskMembers).values(member).run();
  }

  removeMember(taskId: string, repo: string): void {
    getDb()
      .delete(taskMembers)
      .where(and(eq(taskMembers.taskId, taskId), eq(taskMembers.repoName, repo)))
      .run();
  }

  setMemberWorktree(taskId: string, repo: string, worktreeId: string | null): void {
    getDb()
      .update(taskMembers)
      .set({ worktreeId })
      .where(and(eq(taskMembers.taskId, taskId), eq(taskMembers.repoName, repo)))
      .run();
  }

  setMemberPr(taskId: string, repo: string, prNumber: number | null): void {
    getDb()
      .update(taskMembers)
      .set({ prNumber })
      .where(and(eq(taskMembers.taskId, taskId), eq(taskMembers.repoName, repo)))
      .run();
  }

  /** Writes the task id of a worktree row. The whole-tree repo save keeps it afterwards. */
  setWorktreeTask(repoName: string, name: string, taskId: string | null): void {
    getDb()
      .update(worktrees)
      .set({ taskId })
      .where(and(eq(worktrees.repoName, repoName), eq(worktrees.name, name)))
      .run();
  }

  /** Worktrees that no task names yet: the boot backfill makes each a one-member task. */
  worktreesWithoutTask(): Array<{
    repoName: string;
    name: string;
    branch: string;
    hostId: string;
    projectId: string | null;
  }> {
    return getDb()
      .select({
        repoName: worktrees.repoName,
        name: worktrees.name,
        branch: worktrees.branch,
        hostId: worktrees.hostId,
        projectId: worktrees.projectId,
      })
      .from(worktrees)
      .where(isNull(worktrees.taskId))
      .all();
  }

  /** The task ids of the project that have a member with this worktree id. */
  countOfProject(projectId: string): number {
    const row = getDb()
      .select({ n: sql<number>`count(*)` })
      .from(projectTasks)
      .where(eq(projectTasks.projectId, projectId))
      .get();
    return row?.n ?? 0;
  }

  /**
   * Makes a worktree that no task names a one-member task in `projectId`. The task's name is the
   * worktree id, its folder is the worktree's own, and its chats follow it. Returns the task id.
   */
  adoptWorktree(wt: {
    repoName: string;
    name: string;
    branch: string;
    hostId: string;
    projectId: string;
  }): string {
    const worktreeId = `${wt.repoName}-${wt.name.replaceAll("/", "-")}`;
    const taskId = `tsk-${randomBytes(6).toString("hex")}`;
    // A task of this project may already use the name (a migrated group named after the branch).
    const taken = getDb()
      .select({ id: projectTasks.id })
      .from(projectTasks)
      .where(and(eq(projectTasks.projectId, wt.projectId), eq(projectTasks.name, worktreeId)))
      .get();
    const taskName = taken ? `${worktreeId}-${taskId.slice(4, 10)}` : worktreeId;
    getDb().transaction((tx) => {
      tx.insert(projectTasks)
        .values({
          id: taskId,
          projectId: wt.projectId,
          name: taskName,
          branch: wt.name,
          briefPath: null,
          hostId: wt.hostId,
          status: "active",
          createdAt: Date.now(),
        })
        .run();
      tx.insert(taskMembers)
        .values({
          taskId,
          repoName: wt.repoName,
          worktreeId,
          role: null,
          mergeOrder: 0,
          prNumber: null,
        })
        .run();
      tx.update(worktrees)
        .set({ taskId })
        .where(and(eq(worktrees.repoName, wt.repoName), eq(worktrees.name, wt.name)))
        .run();
    });
    setPanelStatesTask(worktreeId, taskId);
    return taskId;
  }

  /**
   * A worktree was removed: drops its member row, and the task too when it was the task of that
   * worktree alone (it has no folder of its own and no member left).
   */
  forgetWorktree(worktreeId: string): void {
    const found = this.memberOfWorktree(worktreeId);
    if (!found) return;
    this.removeMember(found.task.id, found.member.repoName);
    if (!found.task.briefPath && this.membersOf(found.task.id).length === 0) {
      this.remove(found.task.id);
    }
  }
}
