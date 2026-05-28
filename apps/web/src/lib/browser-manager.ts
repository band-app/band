/**
 * Back-compat shim — re-exports the browser-service API under the legacy
 * `lib/browser-manager.ts` function-shaped surface so existing callers
 * (`browser-host.ts`, the CLI adapter, …) keep compiling without touching
 * their imports.
 *
 * The real implementation lives in `server/services/browser-service.ts`.
 * New code should import the `browserService` singleton (or the
 * `BrowserService` class) directly from there — this file exists only to
 * ease the migration started in issue #316 (Phase 5 of the 3-tier
 * refactor) and will be deleted in a follow-up phase once every call
 * site has moved.
 */

import {
  type BrowserStatus,
  type BrowserTab,
  browserService,
  type CreateBrowserOptions,
  type UpdateBrowserOptions,
} from "../server/services/browser-service";

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
  return browserService.remove(browserId);
}

export function removeWorkspaceBrowsers(workspaceId: string): void {
  browserService.removeAllForWorkspace(workspaceId);
}

export function loadBrowsersFromDb(): number {
  return browserService.loadFromDb();
}
