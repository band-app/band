import { DashboardShell } from "@/dashboard";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { isDesktop } from "../lib/is-desktop";
import { DesktopLayout } from "./DesktopLayout";
import { ToolbarOverflowMenuItems, ToolbarOverflowProvider } from "./ToolbarButtons";

export function DashboardView() {
  const isWideScreen = useIsDesktop();
  const useDesktopLayout = isWideScreen || isDesktop;

  if (useDesktopLayout) {
    return (
      <ToolbarOverflowProvider>
        <DesktopLayout toolbarMenuItems={<ToolbarOverflowMenuItems />} />
      </ToolbarOverflowProvider>
    );
  }

  return (
    <ToolbarOverflowProvider>
      <DashboardShell toolbarMenuItems={<ToolbarOverflowMenuItems />} />
    </ToolbarOverflowProvider>
  );
}
