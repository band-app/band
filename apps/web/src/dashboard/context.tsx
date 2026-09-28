import { QueryClientProvider } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { DashboardAdapter, PlatformCapabilities } from "./adapter";
import { queryClient } from "./query-client";
import { createDashboardStore } from "./stores/dashboard-store";
import { StoreContext } from "./stores/index";

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
    }),
    [adapter],
  );

  return (
    <DashboardContext.Provider value={{ adapter, capabilities }}>
      <QueryClientProvider client={queryClient}>
        <StoreContext.Provider value={stores}>{children}</StoreContext.Provider>
      </QueryClientProvider>
    </DashboardContext.Provider>
  );
}
