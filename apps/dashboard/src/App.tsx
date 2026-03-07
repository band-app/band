import { DashboardProvider, DashboardShell } from "@band/dashboard-core";
import { TauriCapabilities, TauriDashboardAdapter } from "@band/dashboard-core/adapters/tauri";
import { TunnelToolbarButton } from "@/components/TunnelToolbarButton";

const adapter = new TauriDashboardAdapter();
const capabilities = new TauriCapabilities();

export default function App() {
  return (
    <DashboardProvider adapter={adapter} capabilities={capabilities}>
      <DashboardShell toolbarExtra={<TunnelToolbarButton />} />
    </DashboardProvider>
  );
}
