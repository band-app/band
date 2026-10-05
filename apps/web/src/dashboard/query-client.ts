import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

export const queryKeys = {
  repos: ["repos"] as const,
  settings: ["settings"] as const,
  browserProfiles: ["browserProfiles"] as const,
  repoBrowserProfiles: ["repoBrowserProfiles"] as const,
};
