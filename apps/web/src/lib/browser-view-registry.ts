import { invoke as desktopInvoke } from "./desktop-ipc";
import { isDesktop } from "./is-desktop";

/**
 * Tracks which workspaces currently own a live native browser `WebContentsView`
 * (desktop only), so the projects reconcile can destroy them when a workspace
 * is DELETED — the analogue of `reconcileTerminalWorkspaces` for the terminal
 * cache.
 *
 * Why a registry: post-#643 the browser webview is PARKED (hidden), not
 * destroyed, when its workspace is evicted from `MultiWorkspacePanelHost`'s LRU
 * — so it stays alive and reusable until the workspace is destroyed. A parked
 * webview whose workspace has since been evicted from the frontend cache is no
 * longer represented by a mounted `BrowserPanelComponent`, so iterating the
 * panel-host cache can't find it. This module-level set is the durable record
 * of "workspaces with a webview to clean up", independent of mount state.
 *
 * The native view is keyed by `workspaceId` (one browser view per workspace —
 * see `BrowserPanelComponent`'s `ipcKeyRef`). The set is best-effort: a desktop
 * LRU eviction can destroy a view without going through here, but a stale
 * `browser_destroy` on reconcile is a harmless no-op.
 */

const browserWorkspaces = new Set<string>();

/** Record that a workspace has a live native browser view. */
export function registerBrowserView(workspaceId: string): void {
  browserWorkspaces.add(workspaceId);
}

/** Forget a workspace's browser view (after it's destroyed). */
export function unregisterBrowserView(workspaceId: string): void {
  browserWorkspaces.delete(workspaceId);
}

/**
 * Destroy the native browser views of workspaces that no longer exist (deleted
 * / worktree removed). Mirrors `reconcileTerminalWorkspaces`: this is the ONLY
 * workspace-level browser-destroy trigger — a panel-LRU eviction PARKS the
 * webview (keeps it alive for reuse), it does not destroy it. The active
 * workspace is never destroyed even if it's mid-delete.
 *
 * No-op off desktop (there are no native browser views on web).
 */
export function reconcileBrowserWorkspaces(
  validWorkspaceIds: Set<string>,
  activeWorkspaceId: string | null,
): void {
  if (!isDesktop) return;
  for (const workspaceId of [...browserWorkspaces]) {
    if (validWorkspaceIds.has(workspaceId) || workspaceId === activeWorkspaceId) continue;
    browserWorkspaces.delete(workspaceId);
    desktopInvoke("browser_destroy", { workspaceId }).catch(() => {});
  }
}
