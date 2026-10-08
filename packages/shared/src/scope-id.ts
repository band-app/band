/**
 * The scope id of a project's folder.
 *
 * A project's folder (its context files, where its coordinator works) is no worktree, but the
 * task queue, the agent runtime, the terminal and file services and the UI's worktree view all key
 * their work by a worktree id string. So a project uses `project:<projectId>` there. No worktree id
 * can look like this, because a worktree id is `<repo>-<branch>` and a repo or branch name cannot
 * hold a colon.
 */

const PREFIX = "project:";

export const projectScopeId = (projectId: string): string => `${PREFIX}${projectId}`;

/** The project id behind a scope id, or undefined for a worktree id. */
export function projectIdOfScope(scopeId: string): string | undefined {
  return scopeId.startsWith(PREFIX) ? scopeId.slice(PREFIX.length) : undefined;
}

/** Whether a scope id names no worktree: a project's folder. */
export const isFolderScope = (scopeId: string): boolean => projectIdOfScope(scopeId) !== undefined;
