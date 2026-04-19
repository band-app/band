import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAdapter } from "../context";
import { toWorkspaceId } from "../lib/workspace-id";
import { queryKeys } from "../query-client";
import { useDashboardStore, useRawDashboardStore } from "../stores/index";
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

export function useGitInit() {
  const adapter = useAdapter();
  const setError = useDashboardStore((s) => s.setError);

  return useMutation({
    mutationFn: (path: string) => adapter.gitInit(path),
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
  const store = useRawDashboardStore();

  return useMutation({
    mutationFn: ({ project, branch }: { project: string; branch: string }) =>
      adapter.removeWorkspace(project, branch),
    onSuccess: (_data, { project, branch }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });

      const deletedWorkspaceId = toWorkspaceId(project, branch);
      if (store.getState().activeWorkspaceId === deletedWorkspaceId) {
        const projects = queryClient.getQueryData<ProjectInfo[]>(queryKeys.projects);
        const projectInfo = projects?.find((p) => p.name === project);
        if (projectInfo) {
          openWorkspace(toWorkspaceId(project, projectInfo.defaultBranch));
        }
      }
    },
    onError: (err) => {
      setError(String(err));
    },
  });
}
