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
import { useCallback, useEffect, useId, useMemo, useState } from "react";
// Single source of truth — same type the server-side store uses.
// Imported from `browser-history-types` (not `browser-history-store`)
// so this renderer module doesn't pull Drizzle into the client bundle.
import type { HistoryEntry } from "../lib/browser-history-types";
import { trpc } from "../lib/trpc-client";

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
  // `useId` gives this instance a stable, unique id — important
  // because in split-pane layouts multiple `HistoryPopover`
  // instances coexist, and a hardcoded id would cause
  // `document.getElementById` (in `onOpenAutoFocus` below) to focus
  // the wrong popover's input.
  const searchId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  // Plain state counter (not a ref) — bumping it re-runs the fetch
  // effect via the deps array. A ref + `setEntries(prev => prev)`
  // trick doesn't work: React 18 bails out on same-reference state
  // updates, so the effect would never see the incremented value.
  const [reloadKey, setReloadKey] = useState(0);

  // Bump the reload counter to trigger a refetch. Lets per-row delete
  // and the Clear footer refresh the list without piping state.
  const refresh = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  // Fetch on open + on query change + when `refresh()` bumps the key.
  // `reloadKey` is intentionally a trigger-only dependency — bumping
  // it via `refresh()` re-runs this effect even though the body
  // doesn't read its value. Biome's exhaustive-deps rule flags this
  // as "extra dependency" because the read is absent; the suppression
  // documents that it's the intended re-run mechanism.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a trigger-only dep — see comment above.
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
  }, [open, query, workspaceId, reloadKey]);

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
      await trpc.history.delete.mutate({ id, workspaceId }).catch(() => {});
      // Optimistic local update so the UI doesn't flash empty during
      // refetch.
      setEntries((prev) => prev.filter((e) => e.id !== id));
      refresh();
    },
    [refresh, workspaceId],
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
          const input = document.getElementById(searchId);
          if (input) input.focus();
        }}
      >
        {/* Search header */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            id={searchId}
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
