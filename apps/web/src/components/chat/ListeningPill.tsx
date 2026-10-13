import { describeWatch, formatExpiry } from "@band-app/client/subscription-label";
import { Popover, PopoverContent, PopoverTrigger } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Radio, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAdapter } from "@/dashboard";
import { trpc } from "../../lib/trpc-client";

type SubscriptionList = Awaited<ReturnType<typeof trpc.subscriptions.list.query>>;

const listKey = (chatId: string) => ["subscriptions.list", chatId] as const;

/**
 * Shows that a chat is listening for events (plan step S.6) and lists what
 * it waits for. Renders nothing when the chat has no subscriptions. Agents
 * and the CLI create subscriptions without this page open, so the list
 * refetches on every `subscription-*` event for the chat.
 */
export function ListeningPill({ chatId }: { chatId: string }) {
  const adapter = useAdapter();
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<string | null>(null);

  const query = useQuery<SubscriptionList>({
    queryKey: listKey(chatId),
    queryFn: () => trpc.subscriptions.list.query({ chatId }),
    staleTime: 30_000,
  });

  // An invalidation during the first load does not start a second request: the query has no data
  // yet, so TanStack Query hands back the one in flight, which was answered before the change.
  // The flag makes the pill read the list again once that request ends.
  const changedWhileFetching = useRef(false);

  useEffect(() => {
    const refresh = () => {
      if (queryClient.isFetching({ queryKey: listKey(chatId) }) > 0) {
        changedWhileFetching.current = true;
      }
      void queryClient.invalidateQueries({ queryKey: listKey(chatId) });
    };
    return adapter.subscribeStatusEvents((event) => {
      // The stream replays nothing, so a subscription created while it was connecting or down
      // sent an event this pill never saw. The on-connect snapshot is the cue to read the list.
      if (event.kind === "snapshot") {
        refresh();
        return;
      }
      if (event.chatId !== chatId) return;
      if (typeof event.kind !== "string" || !event.kind.startsWith("subscription-")) return;
      refresh();
    });
  }, [adapter, chatId, queryClient]);

  const { isFetching, refetch } = query;
  useEffect(() => {
    if (isFetching || !changedWhileFetching.current) return;
    changedWhileFetching.current = false;
    void refetch();
  }, [isFetching, refetch]);

  const subscriptions = query.data ?? [];
  if (subscriptions.length === 0) return null;

  const remove = async (id: string) => {
    setRemoving(id);
    try {
      await trpc.subscriptions.remove.mutate({ id });
    } catch (err) {
      console.error("[ListeningPill] error removing subscription:", err);
    } finally {
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: listKey(chatId) });
    }
  };

  const now = Date.now();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="listening-pill"
          className="absolute top-2 right-3 z-20 flex items-center gap-1.5 rounded-full border border-border bg-background/90 px-2.5 py-1 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
        >
          <Radio className="size-3.5" aria-hidden="true" />
          Listening
          <span data-testid="listening-pill__count" className="tabular-nums">
            {subscriptions.length}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" data-testid="listening-pill__list">
        <ul className="divide-y divide-border">
          {subscriptions.map((sub) => {
            const { source, watches } = describeWatch(sub);
            return (
              <li
                key={sub.id}
                data-testid={`listening-pill__item--${sub.id}`}
                data-source={sub.source}
                data-cron={sub.cron}
                data-wakeups={sub.wakeups}
                data-max-wakeups={sub.maxWakeups}
                data-expires-at={sub.expiresAt}
                className="flex items-start gap-2 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 text-sm leading-tight">
                    <span className="font-medium text-foreground">{source}</span>
                    <span
                      data-testid="listening-pill__watches"
                      className="min-w-0 truncate text-muted-foreground"
                    >
                      {watches}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                    <span data-testid="listening-pill__wakeups">
                      {sub.wakeups}/{sub.maxWakeups} wakeups
                    </span>
                    {" · "}
                    <span data-testid="listening-pill__expiry">
                      {formatExpiry(sub.expiresAt, now)}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  data-testid={`listening-pill__remove--${sub.id}`}
                  aria-label={`Stop listening to ${watches}`}
                  disabled={removing === sub.id}
                  onClick={() => void remove(sub.id)}
                  className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
