import { createContext, useContext } from "react";

/**
 * Shape of the visibility signal each Layout inner container
 * (Chat / Terminal / Browser) propagates down to its tab panels.
 *
 * - `visible`  — combined "this container's outer panel is visible
 *                AND the worktree is active". Tab panels combine it
 *                with the layout's per-tab active state to decide
 *                whether the leaf content (chat / terminal / browser)
 *                should actually render or stay suspended.
 * - `wsActive` — worktree-level activity flag on its own. Some leaves
 *                (e.g. `BrowserPaneComponent`) use this to hide the
 *                native webview for reasons external to the inner
 *                layout.
 *
 * - `worktreeId` — the worktree whose dockview hosts the panel. Leaves
 *                use it instead of the id saved in their params, which
 *                names the old worktree after a move or continue.
 *
 * `visible` and `wsActive` default to `true` so leaf components that mount outside a
 * Provider (e.g. in tests, or Storybook) behave like they're fully
 * visible.
 */
export interface PanelVisibility {
  visible: boolean;
  wsActive: boolean;
  worktreeId?: string;
}

export const PanelVisibilityContext = createContext<PanelVisibility>({
  visible: true,
  wsActive: true,
});

export function usePanelVisibility(): PanelVisibility {
  return useContext(PanelVisibilityContext);
}
