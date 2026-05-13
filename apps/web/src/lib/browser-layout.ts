/**
 * Pure helpers for the saved dockview-browser layout JSON. Extracted
 * out of `DockviewBrowserContainer.tsx` so the URL-injection logic can
 * be exercised in isolation (no React / dockview / trpc imports).
 */

/**
 * Clone the saved dockview layout and inject `params.initialUrl` for
 * any panel whose browserId appears in `urls`. Returns the layout
 * unchanged when `urls` is null / empty so the original `fromJSON`
 * path is exercised in tests / non-desktop modes.
 *
 * Done as a pre-`fromJSON` mutation rather than a post-restore
 * `api.updateParameters` because `BrowserPaneComponent` reads
 * `params.initialUrl` only in `useState` initializers — by the time
 * we'd call `updateParameters`, the panel has already mounted with
 * `initialUrl: undefined` and started the fallback server fetch.
 *
 * The clone is shallow per-panel: we don't mutate the source layout
 * (it lives in the React Query cache and is referentially compared by
 * other code), and we skip panels whose params already carry an
 * `initialUrl` so a legacy save that did persist it is respected.
 */
export function injectInitialUrls(layout: unknown, urls: Map<string, string> | null): unknown {
  if (!urls || urls.size === 0) return layout;
  if (typeof layout !== "object" || layout === null) return layout;
  const panels = (layout as Record<string, unknown>).panels;
  if (typeof panels !== "object" || panels === null) return layout;
  const nextPanels: Record<string, unknown> = {};
  for (const [id, panel] of Object.entries(panels as Record<string, unknown>)) {
    const url = urls.get(id);
    if (
      url &&
      typeof panel === "object" &&
      panel !== null &&
      typeof (panel as Record<string, unknown>).params === "object" &&
      (panel as Record<string, unknown>).params !== null
    ) {
      const params = (panel as Record<string, unknown>).params as Record<string, unknown>;
      // Only seed `initialUrl` when the layout didn't already carry
      // one — a legacy save might have had it; respect it.
      if (!params.initialUrl) {
        nextPanels[id] = { ...panel, params: { ...params, initialUrl: url } };
        continue;
      }
    }
    nextPanels[id] = panel;
  }
  return { ...(layout as Record<string, unknown>), panels: nextPanels };
}
