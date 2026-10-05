/**
 * The GitHub plugin's Checks tab (`plugins/github`), named the way
 * `RightSidepanel` names plugin tabs: `plugin:<pluginId>.<tabId>`.
 */
export const CHECKS_SIDE_TAB = "plugin:github.pull-request";

/**
 * Reveal the right sidepanel on the Checks tab. `RightSidepanel` remembers
 * the tab, so call this before navigating to another worktree and that
 * worktree's panel opens on it. With the GitHub plugin disabled the panel
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
