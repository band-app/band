import { useHosts, useRepos, useStatusFeed } from "../use-hub-data";
import { findRow } from "../worktree-list";

/** `repo · branch` of a worktree, for a view's header. */
export function useWorktreeLabel(worktreeId: string): string {
  const repos = useRepos();
  const hosts = useHosts();
  const { state } = useStatusFeed();
  const row = findRow(repos.data ?? [], worktreeId, state, hosts.data ?? []);
  return row ? `${row.repoTitle} · ${row.branch}` : "";
}
