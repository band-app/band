/**
 * Persistent browser pane history.
 *
 * One row per `(workspaceId, url)` — revisits bump `visitCount` and
 * `lastVisitedAt` instead of inserting a duplicate row. This bounds
 * storage growth and lets `searchHistory` rank candidates with a single
 * SQL frecency expression (`visit_count / (1 + age_days)`).
 *
 * Callers are the tRPC `historyRouter` procedures; the renderer never
 * touches Drizzle directly.
 */

import { and, desc, eq, gte, or, sql } from "drizzle-orm";
import type { ClearRange, HistoryEntry } from "../../../../lib/browser-history-types";
import { getDb } from "../connection";
import { browserHistory } from "../schema";

// Re-export the shared types so existing call sites that imported
// from `browser-history-store` still resolve. New code should import
// directly from `browser-history-types` to avoid pulling Drizzle.
export type { ClearRange, HistoryEntry };

// URL prefixes that must never be recorded — Chromium-internal,
// extension surface, devtools, and local-file paths leak nothing useful
// and would clutter autocomplete with junk.
const SKIP_PREFIXES = ["about:", "chrome-extension://", "devtools://", "file://"];

/** Returns `true` when this URL is safe to persist into history. */
export function shouldRecord(url: string): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  for (const prefix of SKIP_PREFIXES) {
    if (trimmed.startsWith(prefix)) return false;
  }
  return true;
}

export interface RecordVisitInput {
  workspaceId: string;
  url: string;
  title?: string;
  faviconUrl?: string;
  now?: number;
}

/**
 * Record a visit. Upserts on the `(workspace_id, url)` unique index:
 *  - First visit → insert with `visitCount = 1`.
 *  - Subsequent visits → increment `visitCount`, refresh `lastVisitedAt`,
 *    and only overwrite `title` / `faviconUrl` when the new call carries
 *    a non-null value (otherwise keep what we already learned).
 *
 * Returns `true` if the URL was accepted, `false` if it was filtered.
 */
export function recordVisit(input: RecordVisitInput): boolean {
  if (!shouldRecord(input.url)) return false;

  const db = getDb();
  const now = input.now ?? Date.now();

  db.insert(browserHistory)
    .values({
      workspaceId: input.workspaceId,
      url: input.url,
      title: input.title ?? null,
      faviconUrl: input.faviconUrl ?? null,
      lastVisitedAt: now,
      visitCount: 1,
    })
    .onConflictDoUpdate({
      target: [browserHistory.workspaceId, browserHistory.url],
      set: {
        lastVisitedAt: now,
        visitCount: sql`${browserHistory.visitCount} + 1`,
        // Only overwrite when the new call brings a value — preserves a
        // title learned on a previous visit if this one happens to fire
        // before `page-title-updated` does.
        title: sql`COALESCE(${input.title ?? null}, ${browserHistory.title})`,
        faviconUrl: sql`COALESCE(${input.faviconUrl ?? null}, ${browserHistory.faviconUrl})`,
      },
    })
    .run();
  return true;
}

export interface UpdateMetaInput {
  workspaceId: string;
  url: string;
  title?: string;
  faviconUrl?: string;
}

/**
 * Backfill title / favicon on an existing row. Called when
 * `page-title-updated` or favicon information arrives after the initial
 * visit insert. No-op if there is no matching row yet (the visit may
 * have been filtered).
 */
export function updateVisitMeta(input: UpdateMetaInput): void {
  const db = getDb();
  // Use the Drizzle-inferred row type so the compiler catches typos
  // in the `set` keys — `Record<string, unknown>` would silently
  // no-op an `if (input.title)` -> `updates.titel = ...` slip.
  const updates: Partial<typeof browserHistory.$inferInsert> = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.faviconUrl !== undefined) updates.faviconUrl = input.faviconUrl;
  if (Object.keys(updates).length === 0) return;

  db.update(browserHistory)
    .set(updates)
    .where(
      and(eq(browserHistory.workspaceId, input.workspaceId), eq(browserHistory.url, input.url)),
    )
    .run();
}

export interface ListHistoryOptions {
  limit?: number;
  offset?: number;
}

/** Recency-ordered list of history entries for a workspace. */
export function listHistory(workspaceId: string, opts: ListHistoryOptions = {}): HistoryEntry[] {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  return db
    .select()
    .from(browserHistory)
    .where(eq(browserHistory.workspaceId, workspaceId))
    .orderBy(desc(browserHistory.lastVisitedAt))
    .limit(limit)
    .offset(offset)
    .all();
}

/**
 * Substring-match URLs and titles, ranked by frecency:
 *   score = visit_count / (1 + age_days)
 *
 * Case-insensitive (SQLite's `LIKE` is case-insensitive on ASCII by
 * default; we lowercase the search term to be safe).
 */
export function searchHistory(
  workspaceId: string,
  query: string,
  limit = 8,
  now: number = Date.now(),
): HistoryEntry[] {
  const db = getDb();
  const trimmed = query.trim();
  if (!trimmed) return [];

  // SQLite's LIKE treats `%`, `_`, and `\` as wildcards / escape
  // chars — without escaping, a bare `%` query would match every
  // row in the workspace. Escape the user input and tell LIKE that
  // `\` is the escape character (see the `ESCAPE '\\'` raw-SQL
  // suffix on each `like()` below; Drizzle's `like()` helper
  // doesn't take an escape argument so we splice it in via `sql`).
  const escaped = trimmed.toLowerCase().replace(/[%_\\]/g, "\\$&");
  const pattern = `%${escaped}%`;
  const cappedLimit = Math.min(Math.max(limit, 1), 50);

  // Frecency expression — kept inline so we don't need a generated
  // column. `age_days` floors at 0 (just-visited rows still score
  // higher than older ones because of the +1 in the denominator).
  const score = sql<number>`(
    CAST(${browserHistory.visitCount} AS REAL) /
    (1.0 + (${now} - ${browserHistory.lastVisitedAt}) / 86400000.0)
  )`;

  return db
    .select()
    .from(browserHistory)
    .where(
      and(
        eq(browserHistory.workspaceId, workspaceId),
        or(
          sql`LOWER(${browserHistory.url}) LIKE ${pattern} ESCAPE '\\'`,
          sql`LOWER(COALESCE(${browserHistory.title}, '')) LIKE ${pattern} ESCAPE '\\'`,
        ),
      ),
    )
    .orderBy(sql`${score} DESC`, desc(browserHistory.lastVisitedAt))
    .limit(cappedLimit)
    .all();
}

/**
 * Delete a single history entry by id. Scoped to the workspace so a
 * compromised renderer that knows an integer row id can't reach
 * across workspaces. No-op if not found or if the row belongs to a
 * different workspace.
 */
export function deleteHistoryEntry(id: number, workspaceId: string): void {
  const db = getDb();
  db.delete(browserHistory)
    .where(and(eq(browserHistory.id, id), eq(browserHistory.workspaceId, workspaceId)))
    .run();
}

/**
 * Clear all (or a recent slice) of a workspace's history.
 * Returns the number of rows actually deleted.
 */
export function clearHistory(
  workspaceId: string,
  range: ClearRange,
  now: number = Date.now(),
): number {
  const db = getDb();

  if (range === "all") {
    const result = db
      .delete(browserHistory)
      .where(eq(browserHistory.workspaceId, workspaceId))
      .run();
    return Number(result.changes ?? 0);
  }

  // Windows are inclusive of `now` — i.e. "last hour" = anything
  // visited within the last 60 minutes from this call.
  const windows: Record<Exclude<ClearRange, "all">, number> = {
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
  };
  const cutoff = now - windows[range];

  const result = db
    .delete(browserHistory)
    .where(
      and(eq(browserHistory.workspaceId, workspaceId), gte(browserHistory.lastVisitedAt, cutoff)),
    )
    .run();
  return Number(result.changes ?? 0);
}
