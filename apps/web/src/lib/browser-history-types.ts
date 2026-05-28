/**
 * Renderer-side mirror of the browser history row shape.
 *
 * Lives in its own file (and intentionally has no runtime imports
 * — no `drizzle-orm`, no `node:*`) so the renderer can import the
 * shape without dragging the server-only Drizzle dependency tree
 * with it. The canonical definition lives in
 * `server/infra/db/queries/browser-history.ts`; this copy is the
 * renderer-facing mirror. Keep both in sync if the schema gains a
 * column — structural equality across the tRPC wire is what makes
 * the duplication safe.
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
