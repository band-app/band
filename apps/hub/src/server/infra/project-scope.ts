/**
 * The scope id of a project-level chat.
 *
 * A project chat (the coordinator) has no worktree: its row has a null `worktree_id` and a
 * `project_id`. The task queue, the agent runtime, subscriptions and the worker relay all key their
 * work by a worktree id string, so a project chat uses `project:<projectId>` there. No worktree id
 * can look like this, because a worktree id is `<repo>-<branch>` and a repo or branch name
 * cannot hold a colon.
 */

const PREFIX = "project:";

export const projectScopeId = (projectId: string): string => `${PREFIX}${projectId}`;

/** The project id behind a scope id, or undefined for a worktree id. */
export function projectIdOfScope(scopeId: string): string | undefined {
  return scopeId.startsWith(PREFIX) ? scopeId.slice(PREFIX.length) : undefined;
}

const TASK_PREFIX = "task:";

/** The scope id of a task chat: a chat that runs in a task folder and has no worktree of its own. */
export const taskScopeId = (taskId: string): string => `${TASK_PREFIX}${taskId}`;

/** The task id behind a scope id, or undefined for a worktree or project scope. */
export function taskIdOfScope(scopeId: string): string | undefined {
  return scopeId.startsWith(TASK_PREFIX) ? scopeId.slice(TASK_PREFIX.length) : undefined;
}

/** Whether a scope id names no worktree: a project (the coordinator) or a task. */
export const isFolderScope = (scopeId: string): boolean =>
  projectIdOfScope(scopeId) !== undefined || taskIdOfScope(scopeId) !== undefined;

/** The scope a chat's work is keyed by: its worktree's id, its task's or its project's scope id. */
export function chatScope(chat: {
  worktreeId: string | null;
  projectId?: string | null;
  taskId?: string | null;
}): string {
  if (chat.worktreeId) return chat.worktreeId;
  if (chat.taskId) return taskScopeId(chat.taskId);
  if (chat.projectId) return projectScopeId(chat.projectId);
  throw new Error("A chat has neither a worktree nor a project");
}
