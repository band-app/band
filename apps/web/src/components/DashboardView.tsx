import { DashboardShell } from "@band/dashboard-core";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { isTauri } from "../lib/is-tauri";
import { DesktopLayout } from "./DesktopLayout";
import { ToolbarButtons } from "./ToolbarButtons";

export function DashboardView() {
  const isDesktop = useIsDesktop() && !isTauri;

  if (isDesktop) {
    return <DesktopLayout toolbarExtra={<ToolbarButtons />} />;
  }

  return <DashboardShell toolbarExtra={<ToolbarButtons />} />;
}
