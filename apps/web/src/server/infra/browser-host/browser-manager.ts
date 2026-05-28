/**
 * Function-shaped façade over `browser-service` consumed by the colocated
 * CDP adapters (`host-state.ts`, `cdp-targets.ts`, `cdp-proxy.ts`).
 *
 * The real implementation lives in `server/services/browser-service.ts`;
 * this module exposes the subset that the infra-tier browser-host adapters
 * need to drive CDP without crossing back up to the services tier. New
 * services-tier callers should import the `browserService` singleton (or
 * the `BrowserService` class) directly from `services/browser-service.ts`.
 *
 * Originally lived at `lib/browser-manager.ts`; lifted into
 * `server/infra/browser-host/` as part of Phase 8 (issue #319).
 */

import {
  type BrowserStatus,
  type BrowserTab,
  browserService,
  type CreateBrowserOptions,
  type UpdateBrowserOptions,
} from "../../services/browser-service";

export type { BrowserStatus, BrowserTab, CreateBrowserOptions, UpdateBrowserOptions };

export function createBrowser(workspaceId: string, options?: CreateBrowserOptions): BrowserTab {
  return browserService.create(workspaceId, options);
}

export function getBrowser(browserId: string): BrowserTab | undefined {
  return browserService.get(browserId);
}

export function listBrowsers(workspaceId: string): BrowserTab[] {
  return browserService.list(workspaceId);
}

export function updateBrowser(
  browserId: string,
  updates: UpdateBrowserOptions,
): BrowserTab | undefined {
  return browserService.update(browserId, updates);
}

export function updateBrowserUrl(browserId: string, url: string): void {
  browserService.updateUrl(browserId, url);
}

export function updateBrowserStatus(browserId: string, status: BrowserStatus): void {
  browserService.updateStatus(browserId, status);
}

export function removeBrowser(browserId: string): boolean {
  // `browserService.remove` returns the removed `BrowserTab` (truthy) or
  // `false` when no row matched. The shim's historical contract is a plain
  // boolean, so coerce — callers that need the workspaceId should migrate
  // to `browserService.remove` directly.
  return browserService.remove(browserId) !== false;
}

export function removeWorkspaceBrowsers(workspaceId: string): void {
  browserService.removeAllForWorkspace(workspaceId);
}

export function loadBrowsersFromDb(): number {
  return browserService.loadFromDb();
}
