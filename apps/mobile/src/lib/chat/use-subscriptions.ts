/**
 * What a chat is listening for (`subscriptions.list`), kept current from the status stream the
 * way the web's `ListeningPill` does: agents and the CLI create subscriptions while the chat is
 * open, so every `subscription-*` event for the chat, and the snapshot a reconnect starts with,
 * makes the list load again.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { useHubSession } from "../hub-session";

const listKey = (chatId: string) => ["subscriptions.list", chatId] as const;

export function useSubscriptions(chatId: string) {
  const { client, feed, key } = useHubSession();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: [key, ...listKey(chatId)],
    queryFn: () => client.subscriptions.list.query({ chatId }),
    staleTime: 30_000,
  });
  const { refetch } = query;

  useEffect(
    () =>
      feed.onEvent((event) => {
        if (event.kind === "snapshot") {
          void refetch();
          return;
        }
        if (event.chatId !== chatId) return;
        if (event.kind.startsWith("subscription-")) void refetch();
      }),
    [feed, chatId, refetch],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await client.subscriptions.remove.mutate({ id });
      } finally {
        await queryClient.invalidateQueries({ queryKey: [key, ...listKey(chatId)] });
      }
    },
    [client, queryClient, key, chatId],
  );

  return { subscriptions: query.data ?? [], remove };
}
