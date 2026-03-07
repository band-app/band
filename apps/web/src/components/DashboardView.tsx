import { DashboardProvider, DashboardShell } from "@band/dashboard-core";
import { WebCapabilities, WebDashboardAdapter } from "@band/dashboard-core/adapters/web";
import { TooltipProvider } from "@band/ui";

const adapter = new WebDashboardAdapter();
const capabilities = new WebCapabilities();

export function DashboardView() {
  return (
    <DashboardProvider adapter={adapter} capabilities={capabilities}>
      <TooltipProvider>
        <DashboardShell />
      </TooltipProvider>
    </DashboardProvider>
  );
}
