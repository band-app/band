import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useHubSession } from "./hub-session";
import { isForbidden, isMissingProcedure } from "./settings/errors";
import type { VoiceConfig } from "./settings/voice";

/** A missing procedure or a refusal is an answer, not something to retry. */
const retry = (count: number, err: unknown) =>
  !isMissingProcedure(err) && !isForbidden(err) && count < 1;

/** Whether the token is an admin one, and its id. `tokens.current` is open to every device token. */
export function useCurrentToken() {
  const { client } = useHubSession();
  return useQuery({
    queryKey: ["tokens.current"],
    queryFn: () => client.tokens.current.query(),
    staleTime: 60_000,
    retry,
  });
}

/** `hosts.list`, read again on every `host-status-changed` event of the status stream. */
export function useLiveHosts() {
  const { client, feed, queryClient } = useHubSession();
  useEffect(
    () =>
      feed.onEvent((event) => {
        if (event.kind === "host-status-changed") {
          void queryClient.invalidateQueries({ queryKey: ["hosts.list"] });
        }
      }),
    [feed, queryClient],
  );
  return useQuery({
    queryKey: ["hosts.list"],
    queryFn: async () => (await client.workers.list.query()).hosts,
    retry,
  });
}

export function useInterruptions(hostId: string, enabled: boolean) {
  const { client } = useHubSession();
  return useQuery({
    queryKey: ["hosts.interruptions", hostId],
    queryFn: () => client.workers.interruptions.query({ hostId }),
    enabled,
    gcTime: 0,
    retry: false,
  });
}

export function useUpdateHost() {
  const { client } = useHubSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (hostId: string) => client.workers.update.mutate({ hostId }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["hosts.list"] }),
  });
}

export function useDismissUpdate() {
  const { client } = useHubSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (hostId: string) => client.workers.dismissUpdate.mutate({ hostId }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["hosts.list"] }),
  });
}

export function useUpdateStatus() {
  const { client } = useHubSession();
  return useQuery({
    queryKey: ["hosts.updateStatus"],
    queryFn: () => client.workers.updateStatus.query(),
    retry: false,
  });
}

export function useAgentModels() {
  const { client } = useHubSession();
  return useQuery({
    queryKey: ["models.listAll"],
    queryFn: () => client.models.listAll.query(),
    retry,
  });
}

export function useAvailability() {
  const { client } = useHubSession();
  return useQuery({
    queryKey: ["models.availability"],
    queryFn: () => client.models.availability.query({}),
    retry,
  });
}

export function useRefreshModels() {
  const { client } = useHubSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (hostId: string | undefined) => client.models.refresh.mutate({ hostId }),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["models.listAll"] }),
        queryClient.invalidateQueries({ queryKey: ["models.availability"] }),
      ]),
  });
}

export function useVoiceStatus() {
  const { client } = useHubSession();
  return useQuery({
    queryKey: ["voice.status"],
    queryFn: () => client.voice.status.query(),
    retry,
  });
}

export function useVoiceConfig(enabled: boolean) {
  const { client } = useHubSession();
  return useQuery({
    queryKey: ["voice.config"],
    queryFn: () => client.voice.config.query(),
    enabled,
    retry,
  });
}

export function useSaveVoice() {
  const { client } = useHubSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (voice: VoiceConfig) => client.settings.update.mutate({ voice }),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["voice.status"] }),
        queryClient.invalidateQueries({ queryKey: ["voice.config"] }),
      ]),
  });
}

export function useTestVoice() {
  const { client } = useHubSession();
  return useMutation({
    mutationFn: (endpoint: Omit<VoiceConfig, "enabled">) => client.voice.test.mutate(endpoint),
  });
}

export function useTokens(enabled: boolean) {
  const { client } = useHubSession();
  return useQuery({
    queryKey: ["tokens.list"],
    queryFn: async () => (await client.tokens.list.query()).tokens,
    enabled,
    refetchInterval: 5_000,
    retry,
  });
}

export function useRevokeToken() {
  const { client } = useHubSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) => client.tokens.revoke.mutate({ tokenId }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["tokens.list"] }),
  });
}

/** Creates a device nobody holds yet and returns its one-time pairing link parts. */
export function useAddDevice() {
  const { client } = useHubSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { label: string; admin: boolean }) => {
      const { view } = await client.tokens.createUnpairedDevice.mutate(input);
      const [pairing, addresses] = await Promise.all([
        client.tokens.pairing.mutate({ tokenId: view.id, regenerate: false }),
        client.tokens.pairingAddresses.query().catch(() => null),
      ]);
      return {
        label: view.label,
        code: pairing.code,
        expiresAt: pairing.expiresAt,
        publicUrl: addresses?.publicUrl ?? null,
      };
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["tokens.list"] }),
  });
}
