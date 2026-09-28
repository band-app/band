import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@band-app/ui";
import { Check, Copy } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { writeClipboardText } from "../../lib/clipboard";

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });

/** "just now", "5 minutes ago", "10 months ago". */
export function timeAgo(ms: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return relative.format(-Math.floor(seconds / size), unit);
  }
  return "just now";
}

// One clock for every mounted row (only the rows on screen are mounted), so
// "just now" turns into "1 minute ago" without a timer per message.
const TICK_MS = 30_000;
let now = Date.now();
const listeners = new Set<() => void>();
let timer: number | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
  );
}

/**
 * A message's hover row: copy its text, and when it was sent. Hidden until
 * the message is hovered or focused; always shown on touch screens, which
 * have no hover.
 */
export function MessageActions({
  text,
  createdAt,
  align,
}: {
  text: string;
  createdAt?: number;
  align: "start" | "end";
}) {
  const [copied, setCopied] = useState(false);
  const now = useNow();

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (!text && createdAt === undefined) return null;

  return (
    <div
      data-testid="message-actions"
      className={cn(
        "flex items-center gap-2 text-xs text-muted-foreground opacity-0 transition-opacity",
        "group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100",
        align === "end" && "justify-end",
      )}
    >
      {text && (
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy message"}
          onClick={() => {
            void writeClipboardText(text).then((ok) => setCopied(ok));
          }}
          className="rounded p-1 hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      )}
      {createdAt !== undefined && (
        <Tooltip>
          <TooltipTrigger asChild>
            <time data-testid="message-actions__time" dateTime={new Date(createdAt).toISOString()}>
              {timeAgo(createdAt, now)}
            </time>
          </TooltipTrigger>
          <TooltipContent>{new Date(createdAt).toLocaleString()}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
