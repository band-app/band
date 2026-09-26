import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAdapter } from "../context";
import { queryKeys } from "../query-client";
import type { BrowserProfileInfo } from "../types";

const EMPTY_PROFILES: readonly BrowserProfileInfo[] = Object.freeze([]);
const EMPTY_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Band browser profiles (the built-in Default profile is not in the list).
 * `isLoaded` is false until the first fetch settles, so callers can tell
 * "no profiles" apart from "not fetched yet". A failed fetch counts as
 * settled with no profiles, so callers fall back to Default.
 */
export function useBrowserProfiles() {
  const adapter = useAdapter();
  const { data, isFetched } = useQuery({
    queryKey: queryKeys.browserProfiles,
    queryFn: () => adapter.listBrowserProfiles?.() ?? Promise.resolve([]),
  });
  return {
    profiles: data ?? (EMPTY_PROFILES as BrowserProfileInfo[]),
    isLoaded: isFetched,
  };
}

/** `projectName → profileId` for projects that don't use Default. */
export function useProjectBrowserProfiles() {
  const adapter = useAdapter();
  const { data } = useQuery({
    queryKey: queryKeys.projectBrowserProfiles,
    queryFn: (): Promise<Record<string, string>> =>
      adapter.listProjectBrowserProfiles?.() ?? Promise.resolve({}),
  });
  return data ?? EMPTY_DEFAULTS;
}

export function useSetProjectBrowserProfile() {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectName, profileId }: { projectName: string; profileId: string | null }) =>
      adapter.setProjectBrowserProfile?.(projectName, profileId) ?? Promise.resolve(),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.projectBrowserProfiles }),
  });
}

export function useRemoveBrowserProfile() {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (profileId: string) =>
      adapter.removeBrowserProfile?.(profileId) ?? Promise.resolve(),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.browserProfiles }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projectBrowserProfiles }),
      ]),
  });
}

/** Refetch the profile list and project defaults after a change made elsewhere. */
export function useInvalidateBrowserProfiles() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.browserProfiles }),
      queryClient.invalidateQueries({ queryKey: queryKeys.projectBrowserProfiles }),
    ]);
}
