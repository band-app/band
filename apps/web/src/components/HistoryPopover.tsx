/**
 * Workspace-scoped browser history viewer.
 *
 * Anchored to the History button in the browser pane chrome. The user
 * can:
 *   - Browse recent visits, grouped by day ("Today" / "Yesterday" /
 *     "Tuesday, May 6" / ISO date).
 *   - Search by URL or title — switches to frecency-ranked results.
 *   - Click a row to navigate the active tab there.
 *   - Per-row trash icon to delete one entry.
 *   - Footer "Clear ▾" with Last hour / 24 hours / week / All time.
 *
 * Reads/writes via the `history.*` tRPC procedures. The popover
 * refetches `list` whenever it opens and whenever a mutation succeeds.
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@band-app/ui";
import { ChevronDown, Globe, History, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "../lib/trpc-client";

export interface HistoryEntry {
  id: number;
  workspaceId: string;
  url: string;
  title: string | null;
  faviconUrl: string | null;
  lastVisitedAt: number;
  visitCount: number;
}

export interface HistoryPopoverProps {
  workspaceId: string;
  onNavigate: (url: string) => void;
}

const SEARCH_DEBOUNCE_MS = 150;
const LIST_LIMIT = 200;

/**
 * Group history entries by the calendar day of `lastVisitedAt` in the
 * user's local timezone. Returns `[ { label, entries[] }, ... ]` in
 * descending recency order — same order as the input list.
 */
function groupByDay(entries: HistoryEntry[]): { label: string; entries: HistoryEntry[] }[] {
  const groups = new Map<string, { label: string; entries: HistoryEntry[] }>();
  const order: string[] = [];

  for (const entry of entries) {
    const dayKey = dayKeyFor(entry.lastVisitedAt);
    let group = groups.get(dayKey);
    if (!group) {
      group = { label: labelFor(dayKey), entries: [] };
      groups.set(dayKey, group);
      order.push(dayKey);
    }
    group.entries.push(entry);
  }

  return order.map((k) => groups.get(k)!);
}

/** Local-time `YYYY-MM-DD` for a given epoch ms. */
function dayKeyFor(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function labelFor(dayKey: string): string {
  const today = dayKeyFor(Date.now());
  const yesterday = dayKeyFor(Date.now() - 24 * 60 * 60 * 1000);
  if (dayKey === today) return "Today";
  if (dayKey === yesterday) return "Yesterday";

  // Show weekday + abbreviated month within the last week; full date
  // otherwise.
  const [y, m, d] = dayKey.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const daysSince = Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
  if (daysSince <= 7) {
    return date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  }
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function timeFor(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function HistoryPopover({ workspaceId, onNavigate }: HistoryPopoverProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const reloadKey = useRef(0);

  // Bump `reloadKey.current` to trigger a refetch. Lets per-row delete
  // and the Clear footer refresh the list without piping state.
  const refresh = useCallback(() => {
    reloadKey.current += 1;
    setEntries((prev) => prev); // force a state read on next render
  }, []);

  // Fetch on open + on query change + when `refresh()` bumps the key.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloadKey.current` is intentionally read inside the effect to trigger refetches.
  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoading(true);

    const trimmed = query.trim();
    const fire = () => {
      const promise = trimmed
        ? trpc.history.search.query({ workspaceId, query: trimmed, limit: 50 })
        : trpc.history.list.query({ workspaceId, limit: LIST_LIMIT });
      promise
        .then((result) => {
          if (cancelled) return;
          setEntries(result.entries);
        })
        .catch(() => {
          if (!cancelled) setEntries([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    // Debounce typing; refresh-driven reloads can fire immediately.
    const delay = trimmed ? SEARCH_DEBOUNCE_MS : 0;
    const handle = setTimeout(fire, delay);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, query, workspaceId, reloadKey.current]);

  const groups = useMemo(() => groupByDay(entries), [entries]);

  const handleNavigate = useCallback(
    (url: string) => {
      onNavigate(url);
      setOpen(false);
    },
    [onNavigate],
  );

  const handleDelete = useCallback(
    async (id: number) => {
      await trpc.history.delete.mutate({ id }).catch(() => {});
      // Optimistic local update so the UI doesn't flash empty during
      // refetch.
      setEntries((prev) => prev.filter((e) => e.id !== id));
      refresh();
    },
    [refresh],
  );

  const handleClear = useCallback(
    async (range: "hour" | "day" | "week" | "all") => {
      await trpc.history.clear.mutate({ workspaceId, range }).catch(() => {});
      refresh();
    },
    [refresh, workspaceId],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="History"
          aria-label="Browser history"
        >
          <History className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[440px] p-0"
        onOpenAutoFocus={(e) => {
          // Focus our search input rather than the first focusable
          // element (which is whichever row happens to render first).
          e.preventDefault();
          const input = document.getElementById("history-popover-search");
          if (input) input.focus();
        }}
      >
        {/* Search header */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            id="history-popover-search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search history"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        {/* Body */}
        <div className="max-h-[420px] overflow-y-auto">
          {loading && entries.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">Loading…</div>
          ) : groups.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {query ? "No matching history" : "No history yet"}
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.label}>
                <div className="sticky top-0 z-10 border-b border-border bg-popover px-3 py-1 text-xs font-medium text-muted-foreground">
                  {group.label}
                </div>
                <ul>
                  {group.entries.map((entry) => (
                    <li
                      key={entry.id}
                      className="group flex items-center gap-2 px-3 py-1.5 hover:bg-accent/60"
                    >
                      {entry.faviconUrl ? (
                        <img
                          src={entry.faviconUrl}
                          alt=""
                          className="size-4 shrink-0 rounded-sm"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      ) : (
                        <Globe className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <button
                        type="button"
                        onClick={() => handleNavigate(entry.url)}
                        className="flex min-w-0 flex-1 flex-col text-left"
                      >
                        <span className="truncate text-sm font-medium leading-tight text-foreground">
                          {entry.title || entry.url}
                        </span>
                        <span className="truncate text-xs leading-tight text-muted-foreground">
                          {entry.url}
                        </span>
                      </button>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {timeFor(entry.lastVisitedAt)}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleDelete(entry.id)}
                        className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                        title="Delete entry"
                        aria-label="Delete entry"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end border-t border-border px-3 py-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                Clear <ChevronDown className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => handleClear("hour")}>Last hour</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handleClear("day")}>Last 24 hours</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handleClear("week")}>Last week</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handleClear("all")}>All time</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </PopoverContent>
    </Popover>
  );
}
