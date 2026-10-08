/** Persistence for `projects`, `project_repos` and the worktrees that belong to a project. Only `ProjectService` calls this. */

import { and, asc, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../connection";
import {
  branchStatuses,
  legacyCoordinatorWorktrees,
  panelStates,
  projectRepos,
  projects,
  worktrees,
} from "../schema";

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectRepoRow = typeof projectRepos.$inferSelect;

export interface ProjectWorktreeRow {
  repoName: string;
  name: string;
  branch: string;
  path: string;
  hostId: string;
}

export class ProjectQueries {
  list(): ProjectRow[] {
    return getDb().select().from(projects).orderBy(asc(projects.createdAt)).all();
  }

  find(id: string): ProjectRow | undefined {
    return getDb().select().from(projects).where(eq(projects.id, id)).get();
  }

  /**
   * Retires what older hubs left behind, in one transaction: the default project (`is_default`),
   * and the task links of the removed multi-repo task folders. `worktrees.task_id` and
   * `panel_states.task_id` have no foreign key, so they are cleared by hand. Deleting the default
   * project cascades to its repo list and its tasks, and detaches its worktrees. Returns the
   * removed default project, if there was one.
   */
  retireLegacy(): ProjectRow | undefined {
    const db = getDb();
    return db.transaction((tx) => {
      tx.update(worktrees).set({ taskId: null }).where(isNotNull(worktrees.taskId)).run();
      tx.update(panelStates)
        .set({ taskId: null })
        .where(and(isNotNull(panelStates.taskId), isNotNull(panelStates.worktreeId)))
        .run();
      const legacy = tx.select().from(projects).where(eq(projects.isDefault, true)).get();
      if (legacy) tx.delete(projects).where(eq(projects.id, legacy.id)).run();
      return legacy;
    });
  }

  /** Ids of the projects that list the repo. */
  projectsOfRepo(repoName: string): string[] {
    return getDb()
      .select({ id: projectRepos.projectId })
      .from(projectRepos)
      .where(eq(projectRepos.repoName, repoName))
      .all()
      .map((r) => r.id);
  }

  findByName(name: string): ProjectRow | undefined {
    return getDb().select().from(projects).where(eq(projects.name, name)).get();
  }

  findByContext(contextName: string): ProjectRow | undefined {
    return getDb().select().from(projects).where(eq(projects.contextName, contextName)).get();
  }

  findByCoordinatorChat(chatId: string): ProjectRow | undefined {
    return getDb().select().from(projects).where(eq(projects.coordinatorChatId, chatId)).get();
  }

  /** Coordinator worktrees of the 6.2 layout that the hub has yet to remove. */
  legacyCoordinatorWorktrees() {
    return getDb().select().from(legacyCoordinatorWorktrees).all();
  }

  clearLegacyCoordinatorWorktree(worktreeId: string): void {
    getDb()
      .delete(legacyCoordinatorWorktrees)
      .where(eq(legacyCoordinatorWorktrees.worktreeId, worktreeId))
      .run();
  }

  /** The CI state and pull request the branch-status poller last stored for a worktree. */
  branchStatus(worktreeId: string) {
    return getDb()
      .select({ ciState: branchStatuses.ciState, ciPr: branchStatuses.ciPr })
      .from(branchStatuses)
      .where(eq(branchStatuses.worktreeId, worktreeId))
      .get();
  }

  insert(row: ProjectRow, repos: Array<{ repoName: string; role: string | null }>): void {
    getDb().transaction((tx) => {
      tx.insert(projects).values(row).run();
      for (const repo of repos) {
        tx.insert(projectRepos)
          .values({ projectId: row.id, repoName: repo.repoName, role: repo.role })
          .run();
      }
    });
  }

  update(id: string, patch: Partial<Omit<ProjectRow, "id" | "createdAt">>): void {
    getDb().update(projects).set(patch).where(eq(projects.id, id)).run();
  }

  remove(id: string): boolean {
    const result = getDb().delete(projects).where(eq(projects.id, id)).run();
    return Number(result.changes ?? 0) > 0;
  }

  reposOf(projectId: string): ProjectRepoRow[] {
    return getDb()
      .select()
      .from(projectRepos)
      .where(eq(projectRepos.projectId, projectId))
      .orderBy(asc(projectRepos.repoName))
      .all();
  }

  allRepos(): ProjectRepoRow[] {
    return getDb().select().from(projectRepos).orderBy(asc(projectRepos.repoName)).all();
  }

  /** Adds the repo, or changes its role when it is already there. */
  upsertRepo(projectId: string, repoName: string, role: string | null): void {
    getDb()
      .insert(projectRepos)
      .values({ projectId, repoName, role })
      .onConflictDoUpdate({
        target: [projectRepos.projectId, projectRepos.repoName],
        set: { role },
      })
      .run();
  }

  removeRepo(projectId: string, repoName: string): boolean {
    const result = getDb()
      .delete(projectRepos)
      .where(and(eq(projectRepos.projectId, projectId), eq(projectRepos.repoName, repoName)))
      .run();
    return Number(result.changes ?? 0) > 0;
  }

  /** Drops a removed repo from every project. */
  removeRepoEverywhere(repoName: string): void {
    getDb().delete(projectRepos).where(eq(projectRepos.repoName, repoName)).run();
  }

  worktreesOf(projectId: string): ProjectWorktreeRow[] {
    return getDb()
      .select({
        repoName: worktrees.repoName,
        name: worktrees.name,
        branch: worktrees.branch,
        path: worktrees.path,
        hostId: worktrees.hostId,
      })
      .from(worktrees)
      .where(eq(worktrees.projectId, projectId))
      .orderBy(asc(worktrees.repoName), asc(worktrees.name))
      .all();
  }
}
