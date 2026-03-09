import { DashboardProvider, DashboardShell } from "@band/dashboard-core";
import {
  HybridDashboardAdapter,
  NativeShellCapabilities,
} from "@band/dashboard-core/adapters/hybrid";
import { TooltipProvider } from "@band/ui";
import { TunnelToolbarButton } from "./TunnelToolbarButton";

const adapter = new HybridDashboardAdapter();
const capabilities = new NativeShellCapabilities();

export function DashboardView() {
  return (
    <DashboardProvider adapter={adapter} capabilities={capabilities}>
      <TooltipProvider>
        <DashboardShell toolbarExtra={<TunnelToolbarButton />} />
      </TooltipProvider>
    </DashboardProvider>
  );
}
