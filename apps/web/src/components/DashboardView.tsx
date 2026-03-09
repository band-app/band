import { DashboardProvider, DashboardShell } from "@band/dashboard-core";
import { HybridCapabilities, HybridDashboardAdapter } from "@band/dashboard-core/adapters/hybrid";
import { TooltipProvider } from "@band/ui";

const adapter = new HybridDashboardAdapter();
const capabilities = new HybridCapabilities();

export function DashboardView() {
  return (
    <DashboardProvider adapter={adapter} capabilities={capabilities}>
      <TooltipProvider>
        <DashboardShell />
      </TooltipProvider>
    </DashboardProvider>
  );
}
