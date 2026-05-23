import { useQuery } from "@tanstack/react-query";
import { useAdapter } from "../context";
import { queryKeys } from "../query-client";
import type { ProjectInfo } from "../types";

export function useProjects() {
  const adapter = useAdapter();
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => adapter.listProjects(),
    refetchInterval: 30_000,
  });
  return {
    projects: data ?? ([] as ProjectInfo[]),
    isLoading,
    error: error ? String(error) : null,
  };
}
