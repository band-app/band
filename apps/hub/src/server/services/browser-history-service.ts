/**
 * Browser history service — thin pass-through over the per-worktree
 * visit log query module.
 *
 * Routers must not import from `infra/` directly (see
 * `docs/web-architecture.md`); the `history.*` tRPC router uses this
 * class so the SQLite-backed query module
 * (`infra/db/queries/browser-history.ts`) stays an infra detail.
 *
 * No business logic lives here — every method is a direct delegate. The
 * input validation (Zod schemas, URL/title caps, favicon scheme
 * whitelist) lives on the router because it's a transport-layer
 * concern, not a domain rule.
 *
 * Class-with-constructor-DI shape per `docs/web-architecture.md`
 * (issue #535, follow-up 5). Tests can inject a stub adapter; the
 * exported `browserHistoryService` singleton is what the router
 * consumes.
 */

import {
  type ClearRange,
  clearHistory,
  deleteHistoryEntry,
  type HistoryEntry,
  type ImportedVisit,
  importVisits,
  type ListHistoryOptions,
  listHistory,
  type RecordVisitInput,
  recordVisit,
  searchHistory,
  type UpdateMetaInput,
  updateVisitMeta,
} from "../infra/db/queries/browser-history";

export type {
  ClearRange,
  HistoryEntry,
  ImportedVisit,
  ListHistoryOptions,
  RecordVisitInput,
  UpdateMetaInput,
};

/**
 * Infra adapter the service depends on. Default is the real query
 * module's function exports; tests inject a stub of the same shape.
 */
export interface BrowserHistoryAdapter {
  recordVisit: typeof recordVisit;
  updateVisitMeta: typeof updateVisitMeta;
  listHistory: typeof listHistory;
  searchHistory: typeof searchHistory;
  deleteHistoryEntry: typeof deleteHistoryEntry;
  clearHistory: typeof clearHistory;
  importVisits: typeof importVisits;
}

const DEFAULT_ADAPTER: BrowserHistoryAdapter = {
  recordVisit,
  updateVisitMeta,
  listHistory,
  searchHistory,
  deleteHistoryEntry,
  clearHistory,
  importVisits,
};

/** `<origin>/favicon.ico` for an http(s) URL, the guess `BrowserPanel` records too. */
function guessFaviconUrl(url: string): string | null {
  try {
    const { protocol, origin } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? `${origin}/favicon.ico` : null;
  } catch {
    return null;
  }
}

export class BrowserHistoryService {
  constructor(private readonly queries: BrowserHistoryAdapter = DEFAULT_ADAPTER) {}

  recordVisit(input: RecordVisitInput): boolean {
    return this.queries.recordVisit(input);
  }

  updateVisitMeta(input: UpdateMetaInput): void {
    this.queries.updateVisitMeta(input);
  }

  listHistory(worktreeId: string, options: ListHistoryOptions = {}): HistoryEntry[] {
    return this.queries.listHistory(worktreeId, options);
  }

  searchHistory(worktreeId: string, query: string, limit?: number): HistoryEntry[] {
    return this.queries.searchHistory(worktreeId, query, limit);
  }

  deleteHistoryEntry(id: number, worktreeId: string): void {
    this.queries.deleteHistoryEntry(id, worktreeId);
  }

  clearHistory(worktreeId: string, range: ClearRange): number {
    return this.queries.clearHistory(worktreeId, range);
  }

  /** Import visits from another browser, each with the favicon `BrowserPanel` would record. */
  importVisits(worktreeId: string, visits: Omit<ImportedVisit, "faviconUrl">[]): number {
    return this.queries.importVisits(
      worktreeId,
      visits.map((v) => ({ ...v, faviconUrl: guessFaviconUrl(v.url) })),
    );
  }
}

export const browserHistoryService = new BrowserHistoryService();
