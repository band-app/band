import { useQuery } from "@tanstack/react-query";
import { useAdapter } from "../context";
import { queryKeys } from "../query-client";
import type { ProjectInfo } from "../types";

// Module-level constant so the fallback returned while `data` is undefined
// is reference-stable across renders. Callers that put `projects` in a
// `useEffect`/`useMemo` dependency list would otherwise see a fresh `[]`
// allocation on every render during the loading window, re-firing their
// effect even though the value is semantically unchanged.
const EMPTY_PROJECTS: readonly ProjectInfo[] = Object.freeze([]);

export function useProjects() {
  const adapter = useAdapter();
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => adapter.listProjects(),
    refetchInterval: 30_000,
  });
  return {
    projects: data ?? (EMPTY_PROJECTS as ProjectInfo[]),
    isLoading,
    error: error ? String(error) : null,
  };
}
