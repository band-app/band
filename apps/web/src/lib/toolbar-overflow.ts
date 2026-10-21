import { createContext, useContext } from "react";

/**
 * The openers of the toolbar overflow dialogs (Cronjobs, Usage, Resources, Mobile access).
 * `ToolbarOverflowProvider` in `components/ToolbarButtons.tsx` provides it. It lives in `lib/` so
 * the `dashboard/` module can read it without importing from `components/`.
 */
export interface ToolbarOverflowContextValue {
  openCronjobs: () => void;
  openReports: () => void;
  openTunnel: () => void;
  openResources: () => void;
  /** Tunnel state hint for the menu item (so we can show running/error coloring). */
  tunnelStatus: "idle" | "running" | "error";
}

export const ToolbarOverflowContext = createContext<ToolbarOverflowContextValue | null>(null);

/** The overflow dialogs' openers, or null outside a <ToolbarOverflowProvider>. */
export function useToolbarOverflow(): ToolbarOverflowContextValue | null {
  return useContext(ToolbarOverflowContext);
}
