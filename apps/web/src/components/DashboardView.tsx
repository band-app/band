import { DashboardShell } from "@band-app/dashboard-core";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { isTauri } from "../lib/is-tauri";
import { DesktopLayout } from "./DesktopLayout";
import { ToolbarButtons } from "./ToolbarButtons";

export function DashboardView() {
  const isWideScreen = useIsDesktop();
  const isDesktop = isWideScreen || isTauri;

  if (isDesktop) {
    return <DesktopLayout toolbarExtra={<ToolbarButtons />} />;
  }

  return <DashboardShell toolbarExtra={<ToolbarButtons />} />;
}
