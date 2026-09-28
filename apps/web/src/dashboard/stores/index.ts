import { createContext, useContext } from "react";
import type { DashboardStore } from "./dashboard-store";

interface StoreContextValue {
  dashboardStore: DashboardStore;
}

export const StoreContext = createContext<StoreContextValue | null>(null);

export function useDashboardStore<T>(
  selector: (state: import("./dashboard-store").DashboardState) => T,
): T {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useDashboardStore must be used within DashboardProvider");
  return ctx.dashboardStore(selector);
}

export function useRawDashboardStore(): DashboardStore {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useRawDashboardStore must be used within DashboardProvider");
  return ctx.dashboardStore;
}
