import { useQuery } from "@tanstack/react-query";
import { useAdapter } from "../context";
import { queryKeys } from "../query-client";
import type { RepoInfo } from "../types";

// Module-level constant so the fallback returned while `data` is undefined
// is reference-stable across renders. Callers that put `repos` in a
// `useEffect`/`useMemo` dependency list would otherwise see a fresh `[]`
// allocation on every render during the loading window, re-firing their
// effect even though the value is semantically unchanged.
const EMPTY_REPOS: readonly RepoInfo[] = Object.freeze([]);

export function useRepos() {
  const adapter = useAdapter();
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.repos,
    queryFn: () => adapter.listRepos(),
    refetchInterval: 30_000,
  });
  return {
    repos: data ?? (EMPTY_REPOS as RepoInfo[]),
    isLoading,
    error: error ? String(error) : null,
  };
}
