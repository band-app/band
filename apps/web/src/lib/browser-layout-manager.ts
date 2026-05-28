/**
 * Back-compat shim — re-exports the browser-service's layout API under the
 * legacy `lib/browser-layout-manager.ts` function-shaped surface so existing
 * imports keep compiling.
 *
 * The real implementation lives in `server/services/browser-service.ts`.
 * New code should call `browserService.getLayout(...)` etc. directly —
 * this file exists only to ease the migration started in issue #316
 * (Phase 5 of the 3-tier refactor) and will be deleted in a follow-up
 * phase once every call site has moved.
 */

import { browserService } from "../server/services/browser-service";

export const getBrowserLayout = (workspaceId: string): unknown | null =>
  browserService.getLayout(workspaceId);

export const saveBrowserLayout = (workspaceId: string, tree: unknown): void =>
  browserService.saveLayout(workspaceId, tree);

export const deleteBrowserLayout = (workspaceId: string): void =>
  browserService.deleteLayout(workspaceId);

export function addBrowserToLayout(
  workspaceId: string,
  browserId: string,
  opts?: { title?: string; initialUrl?: string },
): void {
  browserService.addToLayout(workspaceId, browserId, opts);
}

export function removeBrowserFromLayout(workspaceId: string, browserId: string): void {
  browserService.removeFromLayout(workspaceId, browserId);
}
