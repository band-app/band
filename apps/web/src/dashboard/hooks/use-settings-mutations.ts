import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAdapter } from "../context";
import { queryKeys } from "../query-client";
import { useDashboardStore } from "../stores/index";
import type { Settings } from "../types";

export function useUpdateSettings() {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const setError = useDashboardStore((s) => s.setError);

  return useMutation({
    mutationFn: (settings: Settings) => adapter.updateSettings(settings),
    onSuccess: (_data, settings) => {
      queryClient.setQueryData(queryKeys.settings, settings);
    },
    onError: (err) => {
      setError(String(err));
    },
  });
}
