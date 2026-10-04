import { Popover, PopoverContent, PopoverTrigger } from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Radio, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useAdapter } from "@/dashboard";
import { trpc } from "../../lib/trpc-client";

type SubscriptionList = Awaited<ReturnType<typeof trpc.subscriptions.list.query>>;
type ChatSubscription = SubscriptionList[number];

const listKey = (chatId: string) => ["subscriptions.list", chatId] as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "github:pr:o/r#3" becomes "PR o/r#3"; other sources name themselves. */
function describeWatch(sub: ChatSubscription): { source: string; watches: string } {
  const [kind, ...rest] = sub.filterKey.split(":");
  const target = rest.join(":");
  if (sub.source === "github" && kind === "github") {
    const [type, ...path] = target.split(":");
    const name = path.join(":");
    if (type === "pr") return { source: "GitHub", watches: `PR ${name}` };
    if (type === "ci") return { source: "GitHub", watches: `CI on ${name}` };
  }
  if (sub.source === "timer") {
    if (sub.cron) return { source: "Timer", watches: `cron ${sub.cron}` };
    if (sub.at !== undefined) {
      return { source: "Timer", watches: `once at ${new Date(sub.at).toLocaleString()}` };
    }
    return { source: "Timer", watches: "timer" };
  }
  if (sub.source === "webhook") {
    return { source: "Webhook", watches: `/api/hooks/${sub.id}` };
  }
  return { source: sub.source, watches: sub.filterKey };
}

/** How long until `expiresAt`, in the largest whole unit. */
function formatExpiry(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return "expired";
  if (left >= DAY_MS) return `expires in ${Math.floor(left / DAY_MS)}d`;
  if (left >= HOUR_MS) return `expires in ${Math.floor(left / HOUR_MS)}h`;
  return `expires in ${Math.max(1, Math.floor(left / MINUTE_MS))}m`;
}

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

  useEffect(() => {
    return adapter.subscribeStatusEvents((event) => {
      if (event.chatId !== chatId) return;
      if (typeof event.kind !== "string" || !event.kind.startsWith("subscription-")) return;
      void queryClient.invalidateQueries({ queryKey: listKey(chatId) });
    });
  }, [adapter, chatId, queryClient]);

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
