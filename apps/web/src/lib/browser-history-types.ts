/**
 * Shared types for persistent browser history.
 *
 * Lives in its own file (and intentionally has no runtime imports
 * — no `drizzle-orm`, no `node:*`) so the renderer can import the
 * shape without dragging the server-only Drizzle dependency tree
 * with it. Both `browser-history-store.ts` (server) and the
 * renderer-side components (`HistoryPopover`, address-bar
 * autocomplete) use this single source of truth so the DB schema
 * and UI can't drift silently.
 */

export interface HistoryEntry {
  id: number;
  workspaceId: string;
  url: string;
  title: string | null;
  faviconUrl: string | null;
  lastVisitedAt: number;
  visitCount: number;
}

/** Window options for `clearHistory` / the `history.clear` tRPC mutation. */
export type ClearRange = "hour" | "day" | "week" | "all";
