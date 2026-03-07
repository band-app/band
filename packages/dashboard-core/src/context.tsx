import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { DashboardAdapter, PlatformCapabilities } from "./adapter";
import { createDashboardStore } from "./stores/dashboard-store";
import { StoreContext } from "./stores/index";
import { createSettingsStore } from "./stores/settings-store";

interface DashboardContextValue {
  adapter: DashboardAdapter;
  capabilities: PlatformCapabilities;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function useAdapter(): DashboardAdapter {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("useAdapter must be used within DashboardProvider");
  return ctx.adapter;
}

export function useCapabilities(): PlatformCapabilities {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("useCapabilities must be used within DashboardProvider");
  return ctx.capabilities;
}

interface DashboardProviderProps {
  adapter: DashboardAdapter;
  capabilities: PlatformCapabilities;
  children: ReactNode;
}

export function DashboardProvider({ adapter, capabilities, children }: DashboardProviderProps) {
  const stores = useMemo(
    () => ({
      dashboardStore: createDashboardStore(adapter),
      settingsStore: createSettingsStore(adapter),
    }),
    [adapter],
  );

  return (
    <DashboardContext.Provider value={{ adapter, capabilities }}>
      <StoreContext.Provider value={stores}>{children}</StoreContext.Provider>
    </DashboardContext.Provider>
  );
}
