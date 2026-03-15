import { DashboardShell } from "@band/dashboard-core";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { inTauri } from "../routes/__root";
import { DesktopLayout } from "./DesktopLayout";
import { ToolbarButtons } from "./ToolbarButtons";

export function DashboardView() {
  const isDesktop = useIsDesktop() && !inTauri;

  if (isDesktop) {
    return <DesktopLayout toolbarExtra={<ToolbarButtons />} />;
  }

  return <DashboardShell toolbarExtra={<ToolbarButtons />} />;
}
