import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAdapter } from "../context";
import { toWorkspaceId } from "../lib/workspace-id";
import { queryKeys } from "../query-client";
import { useDashboardStore } from "../stores/index";
import type { ProjectInfo } from "../types";

export function useAddProject() {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const setError = useDashboardStore((s) => s.setError);

  return useMutation({
    mutationFn: ({ path, label }: { path: string; label?: string }) =>
      adapter.addProject(path, label),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
    onError: (err) => {
      setError(String(err));
    },
  });
}

export function useRemoveProject() {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const setError = useDashboardStore((s) => s.setError);

  return useMutation({
    mutationFn: (name: string) => adapter.removeProject(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
    onError: (err) => {
      setError(String(err));
    },
  });
}

export function useReorderProjects() {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const setError = useDashboardStore((s) => s.setError);

  return useMutation({
    mutationFn: (names: string[]) => adapter.reorderProjects(names),
    onMutate: async (names) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.projects });
      const previous = queryClient.getQueryData<ProjectInfo[]>(queryKeys.projects);
      if (previous) {
        const reordered = [...previous].sort(
          (a, b) => names.indexOf(a.name) - names.indexOf(b.name),
        );
        queryClient.setQueryData(queryKeys.projects, reordered);
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.projects, context.previous);
      }
      setError(String(err));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

export function useUpdateProjectLabel() {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const setError = useDashboardStore((s) => s.setError);

  return useMutation({
    mutationFn: ({ name, label }: { name: string; label: string | null }) =>
      adapter.updateProjectLabel(name, label),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
    onError: (err) => {
      setError(String(err));
    },
  });
}

export function useCreateWorkspace() {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const setError = useDashboardStore((s) => s.setError);
  const openWorkspace = useDashboardStore((s) => s.openWorkspace);

  return useMutation({
    mutationFn: ({
      project,
      branch,
      base,
      prompt,
    }: {
      project: string;
      branch: string;
      base?: string;
      prompt?: string;
    }) => adapter.createWorkspace(project, branch, base, prompt),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      const workspaceId = toWorkspaceId(vars.project, vars.branch);
      openWorkspace(workspaceId);
    },
    onError: (err) => {
      setError(String(err));
    },
  });
}

export function useRemoveWorkspace() {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const setError = useDashboardStore((s) => s.setError);
  const openWorkspace = useDashboardStore((s) => s.openWorkspace);

  return useMutation({
    mutationFn: ({ project, branch }: { project: string; branch: string }) =>
      adapter.removeWorkspace(project, branch),
    onMutate: async ({ project, branch }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.projects });
      const previous = queryClient.getQueryData<ProjectInfo[]>(queryKeys.projects);
      if (previous) {
        const updated = previous.map((p) =>
          p.name === project
            ? { ...p, worktrees: p.worktrees.filter((wt) => wt.branch !== branch) }
            : p,
        );
        queryClient.setQueryData(queryKeys.projects, updated);
      }
      return { previous };
    },
    onSuccess: (_data, { project, branch }) => {
      const activeWorkspaceId = useDashboardStore.getState().activeWorkspaceId;
      const deletedWorkspaceId = toWorkspaceId(project, branch);
      if (activeWorkspaceId === deletedWorkspaceId) {
        const projects = queryClient.getQueryData<ProjectInfo[]>(queryKeys.projects);
        const projectInfo = projects?.find((p) => p.name === project);
        if (projectInfo) {
          const mainWorkspaceId = toWorkspaceId(project, projectInfo.defaultBranch);
          openWorkspace(mainWorkspaceId);
        }
      }
    },
    onError: (err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKeys.projects, context.previous);
      }
      setError(String(err));
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}
