/**
 * Dependency-inversion seam for the CDP adapters in this directory
 * (issue #535, follow-up 2).
 *
 * `host-state.ts` needs to resolve a Band browser tab's `url` /
 * `workspaceId` from a `bandTabId`. The owning data structure (the
 * in-memory `Map<browserId, BrowserTab>` registry) lives in
 * `services/browser-service.ts` — but infra cannot depend on services.
 *
 * The fix is a registry that infra owns and the services tier populates
 * at module load: `BrowserService` calls `setBrowserLookup` with a
 * function that returns the tab snapshot the CDP adapter needs.
 *
 * Returns `undefined` when the tab doesn't exist (caller throws), or when
 * the lookup hasn't been registered yet (no-op default). The latter only
 * matters during the very first server tick before
 * `services/browser-service.ts` evaluates; the CDP adapters don't run
 * that early.
 */

import type { BrowserRow } from "../db/queries/browsers";

export interface BrowserLookupSnapshot {
  id: BrowserRow["id"];
  workspaceId: BrowserRow["workspaceId"];
  url: BrowserRow["url"];
}

type BrowserLookup = (browserId: string) => BrowserLookupSnapshot | undefined;

const NOOP_LOOKUP: BrowserLookup = () => undefined;
let current: BrowserLookup = NOOP_LOOKUP;

export function setBrowserLookup(lookup: BrowserLookup): void {
  current = lookup;
}

export function lookupBrowser(browserId: string): BrowserLookupSnapshot | undefined {
  return current(browserId);
}
