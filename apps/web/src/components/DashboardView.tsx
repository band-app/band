import { DashboardShell, useSettingsQuery } from "@band-app/dashboard-core";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { isTauri } from "../lib/is-tauri";
import { DesktopLayout } from "./DesktopLayout";
import { ToolbarButtons } from "./ToolbarButtons";

export function DashboardView() {
  const { settings } = useSettingsQuery();
  const appMode = settings.appMode ?? "side-panel";
  const isWideScreen = useIsDesktop();
  const isDesktop = (isWideScreen && !isTauri) || (isTauri && appMode === "full-editor");

  if (isDesktop) {
    return <DesktopLayout toolbarExtra={<ToolbarButtons />} />;
  }

  return <DashboardShell toolbarExtra={<ToolbarButtons />} />;
}
