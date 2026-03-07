import { createContext, useContext } from "react";
import type { DashboardStore } from "./dashboard-store";
import type { SettingsStore } from "./settings-store";

interface StoreContextValue {
  dashboardStore: DashboardStore;
  settingsStore: SettingsStore;
}

export const StoreContext = createContext<StoreContextValue | null>(null);

export function useDashboardStore<T>(
  selector: (state: import("./dashboard-store").DashboardState) => T,
): T {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useDashboardStore must be used within DashboardProvider");
  return ctx.dashboardStore(selector);
}

export function useSettingsStore<T>(
  selector: (state: import("./settings-store").SettingsState) => T,
): T {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useSettingsStore must be used within DashboardProvider");
  return ctx.settingsStore(selector);
}

export function useRawDashboardStore(): DashboardStore {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useRawDashboardStore must be used within DashboardProvider");
  return ctx.dashboardStore;
}

export function useRawSettingsStore(): SettingsStore {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useRawSettingsStore must be used within DashboardProvider");
  return ctx.settingsStore;
}
