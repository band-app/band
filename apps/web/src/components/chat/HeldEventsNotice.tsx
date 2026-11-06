import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@band-app/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { useState } from "react";
import { trpc } from "../../lib/trpc-client";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One line of the read-only transcript, or null for an event that carries no text. */
function lineOf(event: unknown): { who: string; text: string } | null {
  const e = event as {
    type: string;
    text?: string;
    error?: string;
    update?: { sessionUpdate?: string; content?: { text?: string } };
  };
  if (e.type === "prompt" && e.text) return { who: "You", text: e.text };
  if (e.type === "update" && e.update?.sessionUpdate === "agent_message_chunk") {
    const text = e.update.content?.text;
    return text ? { who: "Agent", text } : null;
  }
  if (e.type === "turn-ended" && e.error) return { who: "Error", text: e.error };
  return null;
}

/**
 * Shown above a chat that continued on another worker while its old worker kept logging events.
 * The hub never merges those events: View reads them, Discard deletes them. Renders nothing for a
 * chat with no held events.
 */
export function HeldEventsNotice({ chatId }: { chatId: string }) {
  const queryClient = useQueryClient();
  const held = useQuery({
    queryKey: ["follow.heldEvents", chatId],
    queryFn: () => trpc.follow.heldEvents.query({ chatId }),
    refetchInterval: 30_000,
  });
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transcript = useQuery({
    queryKey: ["follow.heldTranscript", chatId],
    queryFn: () => trpc.follow.heldTranscript.query({ chatId }),
    enabled: open,
  });
  const data = held.data;
  if (!data) return null;

  const discard = async () => {
    setError(null);
    try {
      await trpc.follow.discardHeld.mutate({ chatId });
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["follow.heldEvents", chatId] });
    } catch (err) {
      setError(errorText(err));
    }
  };

  const since = new Date(data.firstAt).toLocaleString();
  const lines = (transcript.data ?? []).map(lineOf).filter((l) => l !== null);
  return (
    <output
      data-testid="held-events"
      data-count={data.count}
      className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs"
    >
      <span data-testid="held-events__text" className="min-w-0 flex-1">
        This chat continued on {data.continuedOnHostName}; {data.count}{" "}
        {data.count === 1 ? "event" : "events"} from {data.fromHostName} after {since} were not
        merged.
      </span>
      <Button
        size="sm"
        variant="outline"
        data-testid="held-events__view"
        onClick={() => setOpen(true)}
      >
        View
      </Button>
      <Button size="sm" variant="outline" data-testid="held-events__discard" onClick={discard}>
        Discard
      </Button>
      {error ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Discarding the held events failed"
              data-testid="held-events__error-icon"
              className="shrink-0 rounded-sm text-destructive"
            >
              <CircleAlert className="size-3.5" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 text-xs">
            <p
              role="alert"
              data-testid="held-events__error"
              className="break-words text-destructive"
            >
              {error}
            </p>
          </PopoverContent>
        </Popover>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[640px]" data-testid="held-events__dialog">
          <DialogHeader>
            <DialogTitle>Events from {data.fromHostName}</DialogTitle>
            <DialogDescription>
              Read-only. These were logged after the chat continued elsewhere.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-80 space-y-2 overflow-auto" data-testid="held-events__transcript">
            {lines.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a static, read-only list
              <li key={i} data-testid="held-events__line" className="text-sm">
                <span className="font-medium">{l.who}: </span>
                {l.text}
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button
              variant="destructive"
              data-testid="held-events__dialog-discard"
              onClick={discard}
            >
              Discard
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </output>
  );
}
