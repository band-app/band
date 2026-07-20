import { createContext, useContext } from "react";

/**
 * Whether the Dockview inner containers (Chat / Terminal / Browser) may offer
 * split affordances (split-right / split-down buttons + keyboard shortcuts +
 * drag-to-split). Propagated from each container down to its stable, module-
 * level `RightHeaderActions` component via React context — the same portal-
 * based mechanism `PanelVisibilityContext` already relies on to reach dockview-
 * rendered components.
 *
 * On mobile the workspace renders panels as a single tabbed group only, so the
 * mobile terminal render site sets `allowSplit: false`. Every other render site
 * (all inside the desktop-only `SharedDockviewLayout`) inherits the default
 * `true`, so desktop split behaviour is unchanged.
 *
 * Defaults to `true` so components mounted outside a Provider (tests, Storybook)
 * keep their split controls.
 */
export interface SplitCapability {
  allowSplit: boolean;
}

export const SplitCapabilityContext = createContext<SplitCapability>({
  allowSplit: true,
});

export function useSplitCapability(): SplitCapability {
  return useContext(SplitCapabilityContext);
}
