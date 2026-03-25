import { DashboardProvider, DashboardShell } from "@band-app/dashboard-core";
import {
  HybridDashboardAdapter,
  NativeShellCapabilities,
} from "@band-app/dashboard-core/adapters/hybrid";

const adapter = new HybridDashboardAdapter();
const capabilities = new NativeShellCapabilities();

export default function App() {
  return (
    <DashboardProvider adapter={adapter} capabilities={capabilities}>
      <DashboardShell />
    </DashboardProvider>
  );
}
