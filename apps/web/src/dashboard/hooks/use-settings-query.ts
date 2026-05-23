import { useQuery } from "@tanstack/react-query";
import { useAdapter } from "../context";
import { queryKeys } from "../query-client";
import type { Settings } from "../types";

export function useSettingsQuery() {
  const adapter = useAdapter();
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.settings,
    queryFn: () => adapter.getSettings(),
  });
  return {
    settings: data ?? ({ worktreesDir: null } as Settings),
    isLoading,
    error: error ? String(error) : null,
  };
}
