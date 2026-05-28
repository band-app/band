/**
 * Browser history service — thin pass-through over the per-workspace
 * visit log query module.
 *
 * Routers must not import from `infra/` directly (see
 * `docs/web-architecture.md`); the `history.*` tRPC router uses these
 * wrappers so the SQLite-backed query module
 * (`infra/db/queries/browser-history.ts`) stays an infra detail.
 *
 * No business logic lives here — every method is a direct delegate. The
 * input validation (Zod schemas, URL/title caps, favicon scheme
 * whitelist) lives on the router because it's transport-layer concerns,
 * not domain rules.
 */

import {
  type ClearRange,
  clearHistory as clearHistoryImpl,
  deleteHistoryEntry as deleteHistoryEntryImpl,
  type HistoryEntry,
  type ListHistoryOptions,
  listHistory as listHistoryImpl,
  type RecordVisitInput,
  recordVisit as recordVisitImpl,
  searchHistory as searchHistoryImpl,
  type UpdateMetaInput,
  updateVisitMeta as updateVisitMetaImpl,
} from "../infra/db/queries/browser-history";

export type { ClearRange, HistoryEntry, ListHistoryOptions, RecordVisitInput, UpdateMetaInput };

export function recordVisit(input: RecordVisitInput): boolean {
  return recordVisitImpl(input);
}

export function updateVisitMeta(input: UpdateMetaInput): void {
  updateVisitMetaImpl(input);
}

export function listHistory(workspaceId: string, options: ListHistoryOptions = {}): HistoryEntry[] {
  return listHistoryImpl(workspaceId, options);
}

export function searchHistory(workspaceId: string, query: string, limit?: number): HistoryEntry[] {
  return searchHistoryImpl(workspaceId, query, limit);
}

export function deleteHistoryEntry(id: number, workspaceId: string): void {
  deleteHistoryEntryImpl(id, workspaceId);
}

export function clearHistory(workspaceId: string, range: ClearRange): number {
  return clearHistoryImpl(workspaceId, range);
}
