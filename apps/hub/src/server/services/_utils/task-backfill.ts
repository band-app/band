/**
 * Boot step (plan step T.2): every worktree belongs to a task. The migration made a one-member
 * task of each worktree that had a project. This makes one for the rest, in the worktree's
 * project or the default project, once that exists. A worktree that has a task is left alone, so
 * it is safe on every boot. The folder of such a task is the worktree's own, and nothing moves.
 */

import { createLogger } from "@band-app/logger";
import { ProjectTaskQueries } from "../../infra/db/queries/project-tasks";
import { ProjectQueries } from "../../infra/db/queries/projects";

const log = createLogger("task-backfill");

export function backfillTasks(
  tasks: ProjectTaskQueries = new ProjectTaskQueries(),
  projects: ProjectQueries = new ProjectQueries(),
): number {
  const defaultId = projects.findDefault()?.id;
  let made = 0;
  for (const wt of tasks.worktreesWithoutTask()) {
    // The worktree's own project, else a project its repo is in, else the default project.
    const projectId = wt.projectId ?? projects.projectsOfRepo(wt.repoName)[0] ?? defaultId;
    if (!projectId) continue;
    tasks.adoptWorktree({ ...wt, projectId });
    made++;
  }
  if (made > 0) log.info({ count: made }, "made one-member tasks for existing worktrees");
  return made;
}
