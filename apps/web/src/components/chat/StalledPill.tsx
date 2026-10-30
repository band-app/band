import { useQuery } from "@tanstack/react-query";
import { Hourglass } from "lucide-react";
import { usePollInterval } from "../../lib/poll-interval";
import { trpc } from "../../lib/trpc-client";

/**
 * Marks a chat whose turn is running but whose agent has sent nothing for a long time
 * (`BAND_TURN_QUIET_STALL_MS` on the hub, 20 minutes by default). Band does not stop the agent:
 * the person decides whether to wait or press Stop. Renders nothing for a healthy chat.
 */
export function StalledPill({ worktreeId, chatId }: { worktreeId: string; chatId: string }) {
  const refetchInterval = usePollInterval(30_000);
  const { data } = useQuery({
    queryKey: ["chats.list", worktreeId],
    queryFn: () => trpc.chats.list.query({ worktreeId }),
    refetchInterval,
    staleTime: 15_000,
  });
  const chat = data?.chats.find((c) => c.id === chatId);
  if (!chat?.stalled) return null;
  return (
    <div
      role="status"
      aria-label="This turn has stalled: the agent has sent nothing for a long time"
      data-testid="stalled-pill"
      data-last-activity-at={chat.lastActivityAt ?? undefined}
      className="absolute top-2 left-3 z-20 flex items-center gap-1.5 rounded-full border border-warning bg-background/90 px-2.5 py-1 text-xs text-warning shadow-sm"
    >
      <Hourglass className="size-3.5" aria-hidden="true" />
      Stalled
    </div>
  );
}
