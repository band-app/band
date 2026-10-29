/**
 * The core's Checks tab (`components/review`), named the way `RightSidepanel`
 * names tabs from `useWorktreeSideTabs`: `plugin:<pluginId>.<tabId>`.
 */
export const CHECKS_SIDE_TAB = "plugin:core.checks";

/**
 * Reveal the right sidepanel on the Checks tab. `RightSidepanel` remembers
 * the tab, so call this before navigating to another worktree and that
 * worktree's panel opens on it. With no review provider for the worktree the panel
 * shows Explorer.
 *
 * `worktreeId` names the worktree the tab is for. The mobile layout has no
 * remembered tab: it opens the Checks sheet only in that worktree, once it
 * is on screen (`MobileWorktreeShell`).
 */
export function showChecksTab(worktreeId?: string): void {
  window.dispatchEvent(
    new CustomEvent("band:right-sidepanel-set-tab", {
      detail: { tab: CHECKS_SIDE_TAB, worktreeId },
    }),
  );
  window.dispatchEvent(new CustomEvent("band:show-right-panel"));
}
