/**
 * The scope ids of project folders (`project:<projectId>`), shared with the UI through
 * `@band-app/shared/scope-id`, plus the hub's mapping from a chat to its scope.
 *
 * A project chat (the coordinator, or any chat opened in the project's folder view) has no
 * worktree: its row has a null `worktree_id` and a `project_id`.
 */

import { projectScopeId } from "@band-app/shared/scope-id";

export { isFolderScope, projectIdOfScope, projectScopeId } from "@band-app/shared/scope-id";

/** The scope a chat's work is keyed by: its worktree's id, or its project's scope id. */
export function chatScope(chat: { worktreeId: string | null; projectId?: string | null }): string {
  if (chat.worktreeId) return chat.worktreeId;
  if (chat.projectId) return projectScopeId(chat.projectId);
  throw new Error("A chat has neither a worktree nor a project");
}
