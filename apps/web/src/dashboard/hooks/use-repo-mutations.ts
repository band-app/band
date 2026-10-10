import { toWorktreeId } from "@band-app/shared/worktree-id";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAdapter } from "../context";
import { readAgentMode } from "../lib/agent-mode";
import { queryKeys } from "../query-client";
import { useDashboardStore, useRawDashboardStore } from "../stores/index";
import type { RepoInfo } from "../types";

export function useRemoveRepo() {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const setError = useDashboardStore((s) => s.setError);

  return useMutation({
    mutationFn: (name: string) => adapter.removeRepo(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.repos });
    },
    onError: (err) => {
      setError(err);
    },
  });
}

export function useReorderRepos() {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const setError = useDashboardStore((s) => s.setError);

  return useMutation({
    mutationFn: (names: string[]) => adapter.reorderRepos(names),
    onMutate: async (names) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.repos });
      const previous = queryClient.getQueryData<RepoInfo[]>(queryKeys.repos);
      if (previous) {
        const reordered = [...previous].sort(
          (a, b) => names.indexOf(a.name) - names.indexOf(b.name),
        );
        queryClient.setQueryData(queryKeys.repos, reordered);
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.repos, context.previous);
      }
      setError(err);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.repos });
    },
  });
}

export function useUpdateRepoLabel() {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const setError = useDashboardStore((s) => s.setError);

  return useMutation({
    mutationFn: ({ name, label }: { name: string; label: string | null }) =>
      adapter.updateRepoLabel(name, label),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.repos });
    },
    onError: (err) => {
      setError(err);
    },
  });
}

export function useGitInit() {
  const adapter = useAdapter();
  const setError = useDashboardStore((s) => s.setError);

  return useMutation({
    mutationFn: (path: string) => adapter.gitInit(path),
    onError: (err) => {
      setError(err);
    },
  });
}

export function usePromoteRepoToGit() {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const setError = useDashboardStore((s) => s.setError);

  return useMutation({
    mutationFn: (name: string) => {
      if (!adapter.promoteRepoToGit) {
        return Promise.reject(
          new Error("This dashboard adapter doesn't support promoting plain repos to git."),
        );
      }
      return adapter.promoteRepoToGit(name);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.repos });
    },
    onError: (err) => {
      setError(err);
    },
  });
}

export function useCreateWorktree() {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const setError = useDashboardStore((s) => s.setError);
  const openWorktree = useDashboardStore((s) => s.openWorktree);

  return useMutation({
    mutationFn: ({
      repo,
      branch,
      base,
      prompt,
      host,
    }: {
      repo: string;
      branch: string;
      base?: string;
      prompt?: string;
      host?: { hostId: string; hostRepoPath?: string };
    }) => adapter.createWorktree(repo, branch, base, prompt, readAgentMode(), host),
    onSuccess: (data, vars) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.repos });
      const worktreeId = toWorktreeId(vars.repo, vars.branch, data.hostId ?? vars.host?.hostId);
      openWorktree(worktreeId);
    },
    onError: (err) => {
      setError(err);
    },
  });
}

export function useRemoveWorktree() {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const setError = useDashboardStore((s) => s.setError);
  const openWorktree = useDashboardStore((s) => s.openWorktree);
  const setDeleting = useDashboardStore((s) => s.setDeleting);
  const store = useRawDashboardStore();

  return useMutation({
    mutationFn: ({ repo, name, hostId }: { repo: string; name: string; hostId?: string }) =>
      adapter.removeWorktree(repo, name, hostId),
    // The server runs the worktree's teardown before it removes anything,
    // which can take up to a minute. Mark the card as deleting meanwhile.
    onMutate: ({ repo, name, hostId }) => {
      setDeleting(toWorktreeId(repo, name, hostId), true);
    },
    onSuccess: async (_data, { repo, name, hostId }) => {
      // Awaited so the card is gone from the list before it stops showing
      // as deleting (see onSettled), rather than flashing back to normal.
      await queryClient.invalidateQueries({ queryKey: queryKeys.repos });

      const deletedWorktreeId = toWorktreeId(repo, name, hostId);
      if (store.getState().activeWorktreeId === deletedWorktreeId) {
        const repos = queryClient.getQueryData<RepoInfo[]>(queryKeys.repos);
        const repoInfo = repos?.find((p) => p.name === repo);
        if (repoInfo) {
          // Navigate to the repo's main worktree by its immutable `name`.
          // `defaultBranch` is the git remote's default (synced, may drift),
          // so resolve the surviving worktree whose identity or live branch
          // matches it and use that row's `name` — falling back to
          // `defaultBranch` if no row matches (best-effort, matches prior
          // behavior).
          const mainWt = repoInfo.worktrees.find(
            (wt) =>
              (wt.name === repoInfo.defaultBranch || wt.branch === repoInfo.defaultBranch) &&
              (wt.hostId ?? "local") === (hostId ?? "local"),
          );
          openWorktree(
            toWorktreeId(repo, mainWt?.name ?? repoInfo.defaultBranch, mainWt?.hostId ?? hostId),
          );
        }
      }
    },
    onError: (err) => {
      setError(err);
    },
    onSettled: (_data, _err, { repo, name, hostId }) => {
      setDeleting(toWorktreeId(repo, name, hostId), false);
    },
  });
}
