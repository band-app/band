/**
 * Browser history service — thin pass-through over the per-workspace
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
  type ListHistoryOptions,
  listHistory,
  type RecordVisitInput,
  recordVisit,
  searchHistory,
  type UpdateMetaInput,
  updateVisitMeta,
} from "../infra/db/queries/browser-history";

export type { ClearRange, HistoryEntry, ListHistoryOptions, RecordVisitInput, UpdateMetaInput };

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
}

const DEFAULT_ADAPTER: BrowserHistoryAdapter = {
  recordVisit,
  updateVisitMeta,
  listHistory,
  searchHistory,
  deleteHistoryEntry,
  clearHistory,
};

export class BrowserHistoryService {
  constructor(private readonly queries: BrowserHistoryAdapter = DEFAULT_ADAPTER) {}

  recordVisit(input: RecordVisitInput): boolean {
    return this.queries.recordVisit(input);
  }

  updateVisitMeta(input: UpdateMetaInput): void {
    this.queries.updateVisitMeta(input);
  }

  listHistory(workspaceId: string, options: ListHistoryOptions = {}): HistoryEntry[] {
    return this.queries.listHistory(workspaceId, options);
  }

  searchHistory(workspaceId: string, query: string, limit?: number): HistoryEntry[] {
    return this.queries.searchHistory(workspaceId, query, limit);
  }

  deleteHistoryEntry(id: number, workspaceId: string): void {
    this.queries.deleteHistoryEntry(id, workspaceId);
  }

  clearHistory(workspaceId: string, range: ClearRange): number {
    return this.queries.clearHistory(workspaceId, range);
  }
}

export const browserHistoryService = new BrowserHistoryService();
