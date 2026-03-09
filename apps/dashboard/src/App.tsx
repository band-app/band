import { DashboardProvider, DashboardShell } from "@band/dashboard-core";
import {
  HybridDashboardAdapter,
  NativeShellCapabilities,
} from "@band/dashboard-core/adapters/hybrid";

const adapter = new HybridDashboardAdapter();
const capabilities = new NativeShellCapabilities();

export default function App() {
  return (
    <DashboardProvider adapter={adapter} capabilities={capabilities}>
      <DashboardShell />
    </DashboardProvider>
  );
}
